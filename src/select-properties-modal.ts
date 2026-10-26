import { App, Menu, Modal, AbstractInputSuggest, Scope, setIcon, Keymap, TFile } from "obsidian";
import { RowNavigator, renderKeyHints, type KeyHint } from "commons/modal";
import { TargetHighlighter, getTabHeadersForFiles, openFileInLeaf } from "commons/workspace";
import {
	isListProperty,
	getPropertySuggestions,
	getPropertyType,
	normalizeTag,
	rankCandidates,
	ValuePicker,
	datetimePickerOptions,
	coerceToType,
	jsTypeOf,
	candidateKey,
	type ValueType,
	type FrontmatterValueSources,
	type ValuePickerOptions,
	type VaultMetadataCatalog,
	type VaultPropertyType,
} from "commons/properties";
import { setTimeoutIn, ownerWindow } from "commons/windows";

let nextPropertyNameId = 0;

export interface Candidate {
	raw: unknown;
	key: string;
	display: string;
	jsType: string;
	coercedFrom?: unknown;
	mismatch?: boolean;
}

export interface PropertyCardState {
	name: string;
	isList: boolean;
	candidates: Candidate[];
	selected: unknown[];
	hasConflict: boolean;
	selectedCandidateKey?: string;
	/** Pending only: a skipped property keeps its values but is left out on Continue. */
	skipped: boolean;
	/** Obsidian widget the user chose for a property the vault does not know yet; undefined means automatic. */
	widget?: string;
	/** True while the type can still be chosen (a new, unknown property). */
	typeEditable?: boolean;
	notice?: string;
	conflictContext?: ConflictCardContext;
	cardEl?: HTMLElement;
	skipCheckboxEl?: HTMLInputElement;
	picker?: ValuePicker;
}

// Describes where a conflict came from so the card can name the notes
// involved instead of leaving the user guessing.
export interface ConflictCardContext {
	/** Notes the conflicting values came from. */
	conflictNotes?: string[];
	/** Vault paths of conflictNotes, used to mark their tabs while the card has focus. */
	conflictPaths?: string[];
	/** Note the clipboard value was copied from, when known. */
	clipboardOrigin?: string;
	/** Notes and occurrence counts for each candidate value. */
	valueSources?: FrontmatterValueSources;
}

interface TypeChoice {
	label: string;
	icon: string;
	/** Obsidian property widget; undefined lets Obsidian pick the type itself. */
	widget?: string;
	type?: VaultPropertyType;
}

// Same choices as Obsidian's own Property type menu.
const TYPE_CHOICES: TypeChoice[] = [
	{ label: "Automatic", icon: "wand-2" },
	{ label: "Text", icon: "align-left", widget: "text", type: "text" },
	{ label: "List", icon: "list", widget: "multitext", type: "list" },
	{ label: "Number", icon: "binary", widget: "number", type: "number" },
	{ label: "Checkbox", icon: "check-square", widget: "checkbox", type: "checkbox" },
	{ label: "Date", icon: "calendar", widget: "date", type: "date" },
	{ label: "Date & time", icon: "clock", widget: "datetime", type: "datetime" },
];

export interface SelectPropertiesModalOptions {
	title?: string;
	subtitle?: string;
	/** Tooltip for the subtitle badge. */
	subtitleHint?: string;
	conflictNames?: readonly string[];
	/** Where focus starts when nothing conflicts; defaults to the add-property row. */
	initialFocus?: "tags" | "add";
	finishText?: string;
}

function duplicateNoticeText(
	propertyName: string,
	valueSources: NonNullable<ConflictCardContext["valueSources"]>[string]
): string | undefined {
	const repeatedSources = Object.values(valueSources ?? {}).flatMap((sources) =>
		sources.filter((source) => source.count > 1)
	);
	if (repeatedSources.length === 0) return undefined;

	return repeatedSources
		.map(({ note, count }) => {
			const occurrences = count === 2 ? "twice" : `${count} times`;
			return `${note} had ${propertyName} ${occurrences} with the same value; it will be pasted once.`;
		})
		.join(" ");
}

export function addedStatusText(added: number, skipped: number): string {
	if (added === 0) return "No properties will be added. Continue will clear the copied properties.";
	if (skipped === 0) {
		return added === 1
			? "1 property will be added to the note."
			: `${added} properties will be added to the note.`;
	}
	return `${added === 1 ? "1 property" : `${added} properties`} will be added. ${skipped} skipped.`;
}

// Names Obsidian shows in its own Property type menu; "Tags" is the one
// special category. Anything undetermined reads as Text, as Obsidian does.
export function propertyTypeLabel(name: string, isList: boolean, type?: string): string {
	if (name === "tags" || name === "tag") return "Tags";
	if (isList) return "List";
	switch (type) {
		case "number":
			return "Number";
		case "checkbox":
			return "Checkbox";
		case "date":
			return "Date";
		case "datetime":
			return "Date & time";
		case "list":
			return "List";
		default:
			return "Text";
	}
}

const CONFLICTS_INFO_TEXT = "Each property below has different values. Pick one, or skip it.";

// Lucide icons standing in for Obsidian's Properties-panel type icons.
const PROPERTY_TYPE_ICONS: Record<string, string> = {
	Text: "align-left",
	List: "list",
	Number: "binary",
	Checkbox: "check-square",
	Date: "calendar",
	"Date & time": "clock",
	Tags: "tags",
};

function selectedValueStyle(propertyName: string): "plain" | "tag" {
	return propertyName === "tags" || propertyName === "tag" ? "tag" : "plain";
}

export class PropertyNameSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly getSuggestionsList: () => string[],
		private readonly onSelectProperty: (name: string) => void
	) {
		super(app, inputEl);
		this.onSelect((name) => this.onSelectProperty(name));
	}

	getSuggestions(query: string): string[] {
		const lower = query.trim().toLowerCase();
		if (!lower) return [];
		return rankCandidates(query.trim(), this.getSuggestionsList(), 20);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

}

export class SelectPropertiesModal extends Modal {
	readonly propertyStates = new Map<string, PropertyCardState>();
	private listContainerEl: HTMLElement | null = null;
	private submitted = false;
	private hintEl: HTMLElement | null = null;
	private keyboardHintEl: HTMLElement | null = null;
	private doneButton: HTMLButtonElement | null = null;
	private skipAllButton: HTMLButtonElement | null = null;
	private addAllButton: HTMLButtonElement | null = null;
	private propertyPicker: ValuePicker | null = null;
	private navigator: RowNavigator | null = null;
	private addRowEl: HTMLElement | null = null;
	private addHostEl: HTMLElement | null = null;
	private readonly tabHighlighter = new TargetHighlighter();

	constructor(
		app: App,
		private catalog: VaultMetadataCatalog,
		initialProperties: Record<string, unknown>,
		private readonly onSubmit: (selected: Record<string, unknown>) => void,
		private readonly onCancel: () => void,
		private readonly conflictContext: Record<string, ConflictCardContext> = {},
		private readonly options: SelectPropertiesModalOptions = {}
	) {
		super(app);
		// A fresh scope drops Modal's built-in Escape-to-close, which would
		// otherwise win over ours and close the modal from inside a row.
		this.scope = new Scope(app.scope);
		this.initPropertyStates(initialProperties);
	}

	private initPropertyStates(initialProperties: Record<string, unknown>): void {
		for (const [name, val] of Object.entries(initialProperties)) {
			const isExplicitConflict = this.options.conflictNames?.includes(name) ?? false;
			const isList = !isExplicitConflict && isListProperty(this.catalog, name);
			const isTagProp = name === "tags" || name === "tag";

			const rawItems: unknown[] = [];
			if (Array.isArray(val)) {
				for (const item of val) {
					if (item === null || item === undefined) continue;
					if (isTagProp) {
						const normalized = normalizeTag(String(item)).trim();
						if (normalized) rawItems.push(normalized);
					} else if (typeof item === "string") {
						const trimmed = item.trim();
						if (trimmed) rawItems.push(trimmed);
					} else {
						rawItems.push(item);
					}
				}
			} else if (val !== null && val !== undefined) {
				if (isTagProp) {
					const normalized = normalizeTag(String(val)).trim();
					if (normalized) rawItems.push(normalized);
				} else if (typeof val === "string") {
					const trimmed = val.trim();
					if (trimmed) rawItems.push(trimmed);
				} else {
					rawItems.push(val);
				}
			}

			let context = this.conflictContext[name];
			if (context && !context.conflictNotes && context.valueSources?.[name]) {
				const derivedNotes = Array.from(
					new Set(Object.values(context.valueSources[name]).flatMap((sources) => sources.map((s) => s.note)))
				);
				if (derivedNotes.length > 0) {
					context = { ...context, conflictNotes: derivedNotes };
				}
			}

			const vaultType = getPropertyType(this.catalog, name);
			const isKnownType =
				!isList &&
				vaultType &&
				vaultType !== "unknown" &&
				["text", "number", "checkbox", "date", "datetime"].includes(vaultType);

			const candidates: Candidate[] = [];
			if (isKnownType) {
				const targetType = vaultType as ValueType;
				for (const raw of rawItems) {
					const res = coerceToType(raw, targetType);
					if (res.ok) {
						const coercedVal = res.value;
						const key = candidateKey(coercedVal);
						const existing = candidates.find((c) => c.key === key && !c.mismatch);
						if (existing) {
							if (raw !== coercedVal && existing.coercedFrom === undefined) {
								existing.coercedFrom = raw;
							}
						} else {
							candidates.push({
								raw: coercedVal,
								key,
								display: String(coercedVal),
								jsType: jsTypeOf(coercedVal),
								...(raw !== coercedVal ? { coercedFrom: raw } : {}),
							});
						}
					} else {
						const key = candidateKey(raw);
						if (!candidates.some((c) => c.key === key && c.mismatch)) {
							candidates.push({
								raw,
								key,
								display: String(raw),
								jsType: jsTypeOf(raw),
								mismatch: true,
							});
						}
					}
				}
			} else {
				for (const raw of rawItems) {
					const key = candidateKey(raw);
					if (!candidates.some((c) => c.key === key)) {
						candidates.push({
							raw,
							key,
							display: String(raw),
							jsType: jsTypeOf(raw),
						});
					}
				}
			}

			const propertyType = getPropertyType(
				this.catalog,
				name,
				candidates.map((c) => c.display)
			);
			if (propertyType === "date" || propertyType === "datetime") {
				candidates.sort((left, right) => Date.parse(right.display) - Date.parse(left.display));
			} else if (propertyType === "number") {
				candidates.sort((left, right) => Number(left.raw) - Number(right.raw));
			}

			const hasConflict = candidates.length > 1 && (isExplicitConflict || !isList);
			const selected = isList
				? candidates.map((c) => String(c.raw))
				: candidates.length > 0
					? [candidates[0].raw]
				: [];
			const selectedCandidateKey = candidates.length > 0 ? candidates[0].key : undefined;

			this.propertyStates.set(name, {
				name,
				isList,
				candidates,
				selected,
				selectedCandidateKey,
				hasConflict,
				skipped: false,
				notice: duplicateNoticeText(name, context?.valueSources?.[name] ?? {}),
				conflictContext: context,
			});
		}
	}

	get inputEl(): HTMLInputElement | null {
		return this.propertyPicker?.inputEl ?? null;
	}

	onOpen(): void {
		this.submitted = false;
		this.contentEl.empty();
		this.contentEl.addClass("pp-select-properties-modal");
		this.modalEl.addClass("pp-modal");
		this.titleEl.setText(this.options.title ?? "Edit property clipboard");
		if (this.options.subtitle) {
			const badge = this.titleEl.createSpan({
				cls: ["pp-clipboard-mode", "mod-muted"],
				text: this.options.subtitle,
			});
			if (this.options.subtitleHint) badge.setAttribute("title", this.options.subtitleHint);
		}

		const bodyEl = this.contentEl.createDiv({ cls: "pp-select-properties-body" });

		const conflictNames = new Set(
			this.options.conflictNames ??
				Array.from(this.propertyStates.values())
					.filter((state) => state.hasConflict)
					.map((state) => state.name)
		);
		const conflictStates = Array.from(this.propertyStates.values()).filter(
			(state) => conflictNames.has(state.name) && state.hasConflict
		);
		if (conflictStates.length) {
			const section = bodyEl.createDiv({ cls: "pp-conflict-section" });
			const header = section.createDiv({ cls: "pp-conflict-section-header" });
			const icon = header.createSpan({ cls: "pp-conflict-section-icon" });
			setIcon(icon, "git-merge");
			const titleText =
				conflictStates.length === 1
					? "1 property differs between notes"
					: `${conflictStates.length} properties differ between notes`;
			header.createDiv({ cls: "pp-section-title", text: titleText });
			section.createDiv({ cls: "pp-conflict-info", text: CONFLICTS_INFO_TEXT });
			const conflictContainer = section.createDiv({ cls: "pp-properties-list pp-conflicts-list" });
			for (const state of conflictStates) this.renderPropertyCard(state, conflictContainer);
		}

		const otherStates = Array.from(this.propertyStates.values()).filter(
			(state) => !conflictStates.includes(state)
		);
		if (conflictStates.length) {
			const section = bodyEl.createDiv({ cls: "pp-properties-section" });
			section.createDiv({ cls: "pp-section-title", text: "Other properties" });
			section.createDiv({
				cls: "pp-properties-info",
				text: "These properties have no conflicts and need no action. Edit or skip them only if you want.",
			});
			this.renderAddPropertyControl(section);
			this.listContainerEl = section.createDiv({ cls: "pp-properties-list" });
			for (const state of otherStates) this.renderPropertyCard(state, this.listContainerEl);
		} else {
			this.renderAddPropertyControl(bodyEl);
			this.listContainerEl = bodyEl.createDiv({ cls: "pp-properties-list" });
			for (const state of otherStates) this.renderPropertyCard(state, this.listContainerEl);
		}

		// Controls
		const controlsEl = this.contentEl.createDiv({ cls: "pp-multi-select-controls" });
		this.hintEl = controlsEl.createDiv({ cls: "pp-multi-select-hint" });
		this.keyboardHintEl = controlsEl.createDiv({ cls: "pp-keyboard-hint" });
		this.keyboardHintEl.setAttribute("aria-live", "polite");
		const buttonsEl = controlsEl.createDiv({ cls: "pp-multi-select-buttons" });

		this.skipAllButton = buttonsEl.createEl("button", {
			text: "Skip all",
			cls: "pp-skip-all-button",
			type: "button",
		});
		this.skipAllButton.addEventListener("click", () => this.skipAll());

		this.addAllButton = buttonsEl.createEl("button", {
			text: "Add all",
			cls: "pp-add-all-button",
			type: "button",
		});
		this.addAllButton.addEventListener("click", () => this.addAll());

		this.doneButton = buttonsEl.createEl("button", {
			text: this.options.finishText ?? "Continue",
			cls: ["mod-cta", "pp-finish-button"],
			type: "button",
		});
		this.doneButton.addEventListener("click", () => this.submit());

		this.navigator = new RowNavigator({
			root: this.contentEl,
			rowSelector: ".pp-property-card, .pp-add-property-row",
			stopSelector: ".pp-property-card, .pp-add-property-row, .pp-multi-select-buttons button",
			openClass: "is-open",
			openRow: (row) => this.openRow(row),
			onAccept: () => this.submit(),
		});
		this.navigator.attach();
		this.contentEl.addEventListener("focusin", this.handleModalFocus);
		this.scope.register([], "Escape", () => {
			if (!this.navigator?.leaveOpenRow(this.contentEl.ownerDocument.activeElement)) this.close();
			return false;
		});
		this.scope.register(["Mod"], "Enter", () => {
			this.submit();
			return false;
		});
		this.scope.register(["Alt"], "ArrowDown", () => {
			this.focusCard(1);
			return false;
		});
		this.scope.register(["Alt"], "ArrowUp", () => {
			this.focusCard(-1);
			return false;
		});
		// Emacs-style next/previous line, in addition to the arrow keys.
		this.scope.register(["Ctrl"], "n", () => {
			this.stepFocus(1);
			return false;
		});
		this.scope.register(["Ctrl"], "p", () => {
			this.stepFocus(-1);
			return false;
		});

		this.updateControls();
		this.setHint(this.rowHint(null));

		const win = ownerWindow(this.contentEl) ?? window;
		setTimeoutIn(win, () => this.getInitialRow()?.focus(), 0);
	}

	// Conflicts always come first. Otherwise a tag copy opens on tags and
	// everything else on the add-property row.
	private getInitialRow(): HTMLElement | null {
		const states = Array.from(this.propertyStates.values());
		const conflict = states.find((candidate) => candidate.hasConflict);
		if (conflict?.cardEl) return conflict.cardEl;
		if (this.options.initialFocus === "tags") {
			const tags = states.find((candidate) => candidate.name === "tags");
			if (tags?.cardEl) return tags.cardEl;
		}
		return this.addRowEl ?? states[0]?.cardEl ?? null;
	}

	private openRow(row: HTMLElement): void {
		if (row === this.addRowEl) {
			if (this.addHostEl) this.addHostEl.hidden = false;
			this.propertyPicker?.inputEl.focus();
			return;
		}
		(
			row.querySelector<HTMLInputElement>('.pp-conflict-option input:checked') ??
			row.querySelector<HTMLInputElement>('.pp-conflict-option input[type="radio"]') ??
			row.querySelector<HTMLInputElement>(".commons-property-picker-input") ??
			row.querySelector<HTMLButtonElement>("button")
		)?.focus();
	}

	private renderAddPropertyControl(container: HTMLElement): void {
		const row = container.createDiv({ cls: "pp-add-property-row" });
		row.tabIndex = 0;
		row.setAttribute("role", "group");
		row.setAttribute("aria-label", "Add property");
		row.createSpan({ cls: "pp-add-property-label", text: "+ Add property" });
		this.addRowEl = row;
		const searchContainer = row.createDiv({ cls: "pp-search-container" });
		searchContainer.hidden = true;
		this.addHostEl = searchContainer;
		this.propertyPicker = new ValuePicker(this.app, searchContainer, {
			suggestions: () =>
				this.propertyPicker?.inputEl.value.trim()
					? this.catalog.properties.map(({ name }) => name).filter((name) => !this.propertyStates.has(name))
					: [],
			multiple: false,
			showSingleValueChip: true,
			allowCreate: true,
			kind: "property",
			classPrefix: "pp",
			placeholder: "Property name to add…",
			ariaLabel: "Property name to add",
			getCreateLabel: (name) => `Add property "${name}"…`,
			onChange: (values) => {
				const name = values[0];
				if (!name) return;
				const state = this.addProperty(name);
				this.propertyPicker?.setValue([]);
				this.propertyPicker?.refresh();
				state?.picker?.inputEl.focus();
			},
		});
	}

	onClose(): void {
		this.tabHighlighter.clear();
		this.navigator?.detach();
		this.navigator = null;
		this.contentEl.removeEventListener("focusin", this.handleModalFocus);
		for (const state of this.propertyStates.values()) {
			state.picker?.destroy();
		}
		this.propertyPicker?.destroy();
		this.propertyPicker = null;
		this.addRowEl = null;
		this.addHostEl = null;
		this.contentEl.empty();
		if (!this.submitted) this.onCancel();
	}

	addProperty(name: string): PropertyCardState | undefined {
		const trimmed = name.trim();
		if (!trimmed || this.propertyStates.has(trimmed)) return this.propertyStates.get(trimmed);

		const isList = isListProperty(this.catalog, trimmed);
		const state: PropertyCardState = {
			name: trimmed,
			isList,
			candidates: [],
			selected: [],
			hasConflict: false,
			skipped: false,
			typeEditable: this.isUnknownProperty(trimmed),
		};
		this.propertyStates.set(trimmed, state);
		if (this.listContainerEl) {
			this.renderPropertyCard(state, this.listContainerEl);
		}
		this.updateControls();
		state.cardEl?.scrollIntoView?.({ block: "nearest" });
		return state;
	}

	// A property Obsidian has no type for yet: not in the vault, not declared,
	// and not one of the built-in list properties.
	private isUnknownProperty(name: string): boolean {
		const lower = name.toLowerCase();
		if (["tags", "tag", "aliases", "alias"].includes(lower)) return false;
		if (this.catalog.declaredTypes && lower in this.catalog.declaredTypes) return false;
		return !this.catalog.properties.some((property) => property.name.toLowerCase() === lower);
	}

	/** Widgets chosen for new properties that are still added (not skipped). */
	getChosenTypes(): Record<string, string> {
		const types: Record<string, string> = {};
		for (const state of this.propertyStates.values()) {
			if (state.widget && !state.skipped && this.getStateValues(state).length > 0) types[state.name] = state.widget;
		}
		return types;
	}

	private openTypeMenu(state: PropertyCardState, anchor: HTMLElement): void {
		if (!state.typeEditable) return;
		const menu = new Menu();
		for (const choice of TYPE_CHOICES) {
			menu.addItem((item) =>
				item
					.setTitle(choice.label)
					.setIcon(choice.icon)
					.setChecked(choice.widget === state.widget)
					.onClick(() => this.chooseType(state, choice))
			);
		}
		const rect = anchor.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom });
	}

	private chooseType(state: PropertyCardState, choice: TypeChoice): void {
		const key = state.name.toLowerCase();
		const declared = { ...(this.catalog.declaredTypes ?? {}) };
		if (choice.type) declared[key] = choice.type;
		else delete declared[key];
		this.catalog = { ...this.catalog, declaredTypes: declared };
		state.widget = choice.widget;

		const values = this.getStateValues(state);
		state.isList = isListProperty(this.catalog, state.name);
		state.selected = state.isList ? values : values.slice(0, 1);
		this.rerenderCard(state);
	}

	private rerenderCard(state: PropertyCardState): void {
		const old = state.cardEl;
		const container = old?.parentElement;
		if (!old || !container) return;
		const next = old.nextSibling;
		state.picker?.destroy();
		state.picker = undefined;
		old.remove();
		this.renderPropertyCard(state, container);
		if (next && state.cardEl) container.insertBefore(state.cardEl, next);
		this.applySkipped(state);
		this.updateControls();
		state.cardEl?.focus();
	}

	private renderPropertyCard(state: PropertyCardState, container: HTMLElement): void {
		const cardEl = container.createDiv({
			cls: state.hasConflict ? "pp-property-card" : ["pp-property-card", "is-compact"],
		});
		cardEl.setAttribute("role", "group");
		cardEl.tabIndex = 0;
		state.cardEl = cardEl;

		const header = cardEl.createDiv({ cls: "pp-property-header" });
		this.renderSkipControl(state, cardEl, header);
		const titleGroup = header.createDiv({ cls: "pp-property-title-group" });

		const typeLabel = propertyTypeLabel(
			state.name,
			state.isList,
			state.isList ? undefined : getPropertyType(this.catalog, state.name, state.candidates.map((c) => c.display))
		);
		if (state.typeEditable) {
			const choiceLabel = state.widget ? typeLabel : "Automatic";
			const typeButton = titleGroup.createEl("button", {
				cls: ["pp-property-type", "is-editable", state.isList ? "is-list" : "is-scalar"],
				type: "button",
				attr: {
					title: `Type: ${choiceLabel}. Change type (T)`,
					"aria-label": `Property type: ${choiceLabel}. Change type`,
					tabindex: "-1",
				},
			});
			setIcon(typeButton, PROPERTY_TYPE_ICONS[typeLabel] ?? "align-left");
			typeButton.addEventListener("click", () => this.openTypeMenu(state, typeButton));
			cardEl.addEventListener("keydown", (event) => {
				if (event.target !== cardEl || event.key.toLowerCase() !== "t") return;
				if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
				event.preventDefault();
				this.openTypeMenu(state, typeButton);
			});
		} else {
			const typeEl = titleGroup.createSpan({
				cls: ["pp-property-type", state.isList ? "is-list" : "is-scalar"],
				attr: { title: typeLabel, "aria-label": typeLabel, role: "img" },
			});
			setIcon(typeEl, PROPERTY_TYPE_ICONS[typeLabel] ?? "align-left");
		}

		const nameEl = titleGroup.createSpan({ cls: "pp-property-name", text: state.name });
		nameEl.id = `pp-property-name-${++nextPropertyNameId}`;
		cardEl.setAttribute("aria-labelledby", nameEl.id);

		if (state.notice) {
			cardEl.createDiv({ cls: "pp-property-notice", text: state.notice });
		}
		if (state.isList && !state.hasConflict) {
			this.renderListBody(state, cardEl);
		} else {
			this.renderScalarBody(state, cardEl);
		}
	}

	private renderScalarBody(state: PropertyCardState, cardEl: HTMLElement): void {
		const propertyType = getPropertyType(
			this.catalog,
			state.name,
			state.candidates.map((c) => c.display)
		);
		const isDateProperty = propertyType === "date" || propertyType === "datetime";
		const datetimeOptions =
			propertyType === "datetime"
				? datetimePickerOptions(String(state.selected[0] ?? state.candidates[0]?.display ?? ""))
				: undefined;
		const datePickerOptions =
			propertyType === "date"
				? { inputType: "date" as const }
				: datetimeOptions ?? {};
		if (state.hasConflict) {
			const optionsEl = cardEl.createDiv({ cls: "pp-conflict-options" });
			optionsEl.setAttribute("role", "radiogroup");
			optionsEl.setAttribute("aria-label", `Choose ${state.name} value`);
			let pickerHost: HTMLElement | null = null;

			const ensurePicker = (): void => {
				if (!pickerHost) {
					pickerHost = cardEl.createDiv({ cls: "pp-property-picker-host" });
				}
				pickerHost.hidden = false;
				if (state.picker) {
					state.picker.setValue([]);
					state.picker.inputEl.focus();
					return;
				}
				state.picker = new ValuePicker(this.app, pickerHost, {
					...this.buildPickerOptions(state, "conflict-other"),
					value: "",
					multiple: false,
					showSingleValueChip: !isDateProperty,
					selectedValueStyle: selectedValueStyle(state.name),
					...datePickerOptions,
					allowCreate: true,
					onChange: (values) => {
						state.selected = values.slice(0, 1);
						datetimeOptions?.formatInputValue(String(state.selected[0] ?? ""));
						this.updateControls();
					},
				});
				if (isDateProperty) {
					pickerHost.createDiv({
						cls: "pp-property-picker-hint",
						text: "Changing this date replaces the property value; it will not add another date.",
					});
				}
				state.picker.inputEl.focus();
			};

			const candidateRadios: HTMLInputElement[] = [];
			for (const candidate of state.candidates) {
				const option = optionsEl.createEl("label", { cls: "pp-conflict-option" });
				const radio = option.createEl("input", {
					type: "radio",
					attr: {
						name: `pp-${state.name}`,
						value: candidate.display,
						"data-candidate-key": candidate.key,
					},
				});
				candidateRadios.push(radio);
				radio.checked =
					state.selectedCandidateKey === candidate.key ||
					(state.selected.length === 1 && state.selected[0] === candidate.raw);
				option.createSpan({ cls: "pp-conflict-value", text: candidate.display });
				const propSources = state.conflictContext?.valueSources?.[state.name];
				const sources =
					propSources?.[candidate.key] ??
					propSources?.[candidate.display] ??
					propSources?.[String(candidate.raw)] ??
					(candidate.coercedFrom !== undefined
						? propSources?.[String(candidate.coercedFrom)]
						: undefined) ??
					[];
				const sourcesEl = option.createSpan({ cls: "pp-conflict-sources" });
				if (sources.length > 3) {
					sourcesEl.setText(`${sources.length} notes`);
					sourcesEl.setAttribute("title", sources.map((s) => s.note).join(", "));
				} else if (sources.length > 0) {
					sources.forEach(({ note }, index) => {
					if (index > 0) sourcesEl.append(", ");
					const path = this.findPathForNote(state, note);
					this.renderNoteLink(sourcesEl, note, path);
				});
				sourcesEl.setAttribute("title", sources.map((s) => s.note).join(", "));
				}
				const selectCandidate = (): void => {
					if (!radio.checked) return;
					state.selectedCandidateKey = candidate.key;
					state.selected = [candidate.raw];
					datetimeOptions?.formatInputValue(candidate.display);
					if (pickerHost) pickerHost.hidden = true;
					this.updateControls();
				};
				radio.addEventListener("click", selectCandidate);
				radio.addEventListener("change", selectCandidate);
			}

			const otherOption = optionsEl.createEl("label", { cls: "pp-conflict-option" });
			const otherRadio = otherOption.createEl("input", {
				type: "radio",
				attr: {
					name: `pp-${state.name}`,
					value: "other",
				},
			});
			otherOption.createSpan({ cls: "pp-conflict-value", text: "Other value…" });
			otherOption.createSpan({ cls: "pp-conflict-sources" });
			const selectOther = (): void => {
				if (!otherRadio.checked) return;
				state.selectedCandidateKey = undefined;
				state.selected = [];
				datetimeOptions?.formatInputValue("");
				ensurePicker();
				this.updateControls();
			};
			otherRadio.addEventListener("click", selectOther);
			otherRadio.addEventListener("change", selectOther);
			const handleConflictKeydown = (event: KeyboardEvent): void => {
				const target = /^[1-9]$/.test(event.key)
					? candidateRadios[Number(event.key) - 1]
					: event.key.toLowerCase() === "o"
						? otherRadio
						: undefined;
				if (!target) return;
				event.preventDefault();
				target.click();
			};
			for (const radio of [...candidateRadios, otherRadio]) {
				radio.addEventListener("keydown", handleConflictKeydown);
			}
			return;
		}

		const pickerHost = cardEl.createDiv({ cls: "pp-property-picker-host" });
		state.picker = new ValuePicker(this.app, pickerHost, {
			...this.buildPickerOptions(state, "scalar"),
			value: String(state.selected[0] ?? ""),
			multiple: false,
			showSingleValueChip: true,
			selectedValueStyle: selectedValueStyle(state.name),
			...datePickerOptions,
			allowCreate: true,
			onChange: (values) => {
				state.selected = values.slice(0, 1);
				datetimeOptions?.formatInputValue(String(state.selected[0] ?? ""));
				this.updateControls();
			},
		});
	}

	private buildPickerOptions(
		state: PropertyCardState,
		kind: "scalar" | "conflict-other" | "list",
	): Pick<
		ValuePickerOptions,
		| "suggestions"
		| "knownValues"
		| "kind"
		| "context"
		| "classPrefix"
		| "placeholder"
		| "ariaLabel"
		| "getCreateLabel"
		| "suppressNewBadge"
		| "confirmNewEntries"
	> {
		const propertyType =
			kind === "list" ? undefined : getPropertyType(this.catalog, state.name, state.candidates.map((c) => c.display));
		const isDateProperty = propertyType === "date" || propertyType === "datetime";
		const isListPicker = kind === "list";
		return {
			suggestions: getPropertySuggestions(this.catalog, state.name),
			knownValues: state.candidates.map((c) => c.display),
			kind: "value",
			context: state.name,
			classPrefix: "pp",
			placeholder: isListPicker ? `Add ${state.name}…` : `Choose or type ${state.name}…`,
			ariaLabel: `${state.name} ${isListPicker ? "values" : "value"}`,
			getCreateLabel: (value) => `Add "${value}" as a new ${state.name} value…`,
			suppressNewBadge: kind === "list" ? undefined : isDateProperty,
			confirmNewEntries: isListPicker ? undefined : state.isList,
		};
	}

	private renderListBody(state: PropertyCardState, cardEl: HTMLElement): void {
		const isTagProp = selectedValueStyle(state.name) === "tag";
		const pickerHost = cardEl.createDiv({ cls: "pp-property-picker-host" });
		state.picker = new ValuePicker(this.app, pickerHost, {
			...this.buildPickerOptions(state, "list"),
			value: state.selected as string[],
			multiple: true,
			suggestOnEmpty: false,
			selectedValueStyle: isTagProp ? "tag" : "plain",
			focusInputAfterRemove: false,
			allowCreate: true,
			normalizeValue: isTagProp ? normalizeTag : undefined,
			onChange: (values) => {
				state.selected = values;
				this.updateControls();
			},
		});
	}

	// Native checkbox: it already exposes checked state and click/Space to
	// assistive tech, so no ARIA state has to be kept in sync by hand.
	private renderSkipControl(
		state: PropertyCardState,
		cardEl: HTMLElement,
		header: HTMLElement
	): void {
		const label = header.createEl("label", { cls: "pp-property-skip" });
		const checkbox = label.createEl("input", {
			type: "checkbox",
			cls: "pp-property-skip-checkbox",
			attr: { "aria-label": "Skip property", title: "Skip property", tabindex: "-1" },
		});
		state.skipCheckboxEl = checkbox;

		checkbox.addEventListener("change", () => {
			this.setSkipped(state, checkbox.checked);
			cardEl.focus();
		});
		cardEl.addEventListener("keydown", (event) => {
			if (event.target !== cardEl || event.key !== " ") return;
			if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
			event.preventDefault();
			this.setSkipped(state, !state.skipped);
		});
	}

	private applySkipped(state: PropertyCardState): void {
		state.cardEl?.classList.toggle("is-skipped", state.skipped);
		if (state.skipCheckboxEl) {
			state.skipCheckboxEl.checked = state.skipped;
			state.skipCheckboxEl.title = state.skipped ? "Add back" : "Skip property";
		}
	}

	private setSkipped(state: PropertyCardState, skipped: boolean): void {
		state.skipped = skipped;
		this.applySkipped(state);
		this.updateControls();
		if (state.cardEl && this.contentEl.ownerDocument.activeElement === state.cardEl) {
			this.setHint(this.rowHint(state.cardEl));
		}
	}

	private setAllSkipped(skipped: boolean): void {
		for (const state of this.propertyStates.values()) {
			state.skipped = skipped;
			this.applySkipped(state);
		}
		this.updateControls();
	}

	skipAll(): void {
		this.setAllSkipped(true);
	}

	addAll(): void {
		this.setAllSkipped(false);
	}

	submit(): void {
		if (this.submitted) return;
		this.submitted = true;
		this.onSubmit(this.getSelectedProperties());
		this.close();
	}

	getSelectedProperties(): Record<string, unknown> {
		return this.collectProperties(false);
	}

	/** Skipped properties with the values they still hold; they are not pasted. */
	getSkippedProperties(): Record<string, unknown> {
		return this.collectProperties(true);
	}

	private collectProperties(skipped: boolean): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [name, state] of this.propertyStates.entries()) {
			if (state.skipped !== skipped) continue;
			const values = this.getStateValues(state);
			if (values.length === 0) continue;
			if (state.isList) {
				result[name] = values;
			} else {
				const value = values[0];
				const propType = getPropertyType(
					this.catalog,
					name,
					state.candidates.map((c) => c.display)
				);
				if (propType === "checkbox" && (value === "true" || value === "false")) {
					result[name] = value === "true";
				} else if (propType === "number" && typeof value === "string") {
					const coerced = coerceToType(value, "number");
					result[name] = coerced.ok ? coerced.value : value;
				} else {
					result[name] = value;
				}
			}
		}
		return result;
	}

	private updateControls(): void {
		let added = 0;
		let skipped = 0;
		let skippedRows = 0;
		for (const state of this.propertyStates.values()) {
			if (state.skipped) skippedRows++;
			if (this.getStateValues(state).length === 0) continue;
			if (state.skipped) skipped++;
			else added++;
		}

		this.hintEl?.setText(addedStatusText(added, skipped));
		if (this.doneButton) {
			this.doneButton.setText(`${this.options.finishText ?? "Continue"} (${added})`);
			if (added === 0) this.doneButton.title = "Close and clear copied properties";
			else this.doneButton.removeAttribute("title");
		}
		if (this.skipAllButton) this.skipAllButton.disabled = skippedRows === this.propertyStates.size;
		if (this.addAllButton) this.addAllButton.disabled = skippedRows === 0;
	}

	// Ctrl+N / Ctrl+P: the same move as ArrowDown / ArrowUp on a row, or on the
	// choices of a conflict. Inside text inputs they do nothing.
	private stepFocus(delta: 1 | -1): void {
		const active = this.contentEl.ownerDocument.activeElement;
		if (active instanceof HTMLInputElement && active.type === "radio") {
			const radios = Array.from(
				active.closest(".pp-property-card")?.querySelectorAll<HTMLInputElement>('input[type="radio"]') ?? []
			);
			const target = radios[(radios.indexOf(active) + delta + radios.length) % radios.length];
			if (target && target !== active) {
				target.focus();
				target.click();
			}
			return;
		}
		this.navigator?.stepFrom(active, delta);
	}

	focusCard(delta: 1 | -1): void {
		const activeElement = this.contentEl.ownerDocument.activeElement;
		if (!(activeElement instanceof HTMLElement)) return;
		const currentCard = activeElement.closest<HTMLElement>(".pp-property-card");
		if (!currentCard) return;
		const cards = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".pp-property-card"));
		const currentIndex = cards.indexOf(currentCard);
		cards[currentIndex + delta]?.focus();
	}

	private readonly handleModalFocus = (event: FocusEvent): void => {
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		if (this.addHostEl && !this.addRowEl?.contains(target)) this.addHostEl.hidden = true;
		this.highlightConflictTabs(target);
		const hint = this.rowHint(target);
		if (hint !== null) this.setHint(hint);
	};

	// Marks the tabs of the notes behind the focused conflict, so the user can
	// see which note a resolution is about.
	private highlightConflictTabs(target: HTMLElement): void {
		const card = target.closest<HTMLElement>(".pp-property-card");
		const state = Array.from(this.propertyStates.values()).find((candidate) => candidate.cardEl === card);
		const paths = state?.hasConflict ? state.conflictContext?.conflictPaths : undefined;
		this.tabHighlighter.set(
			getTabHeadersForFiles(this.app, paths ?? []).map((el) => ({ el, cls: "pp-conflict-tab" }))
		);
	}

	private setHint(hint: KeyHint[] | null): void {
		if (this.keyboardHintEl && hint) renderKeyHints(this.keyboardHintEl, [hint], "pp");
	}

	// Footer hint for the focused control; null leaves the current hint alone.
	// A null target gives the default row hint shown before anything has focus.
	private rowHint(target: HTMLElement | null): KeyHint[] | null {
		const row = target?.closest<HTMLElement>(".pp-property-card, .pp-add-property-row") ?? null;
		if (target === null || row === target) {
			const state = Array.from(this.propertyStates.values()).find(
				(candidate) => candidate.cardEl === row
			);
			if (row !== null && row === this.addRowEl) {
				return [
					{ key: "Enter", action: "add property" },
					{ key: "Tab", action: "next" },
					{ key: "Esc", action: "cancel" },
				];
			}
			return [
				{ key: "Enter", action: state?.hasConflict ? "choose value" : "edit" },
				{ key: "Tab", action: "next" },
				{ key: "Space", action: state?.skipped ? "add back" : "skip" },
				...(state?.typeEditable ? [{ key: "T", action: "type" }] : []),
				{ key: "Ctrl/Cmd+Enter", action: "continue" },
				{ key: "Esc", action: "cancel" },
			];
		}
		if (row && target.matches('input[type="radio"]')) {
			return [
				{ key: "↑↓, Ctrl+N/P or 1-9", action: "choose" },
				{ key: "O", action: "other value" },
				{ key: "Esc", action: "done" },
				{ key: "Tab", action: "next" },
			];
		}
		if (row) {
			return [
				{ key: "Esc", action: "done" },
				{ key: "Backspace", action: "removes last" },
				{ key: "Tab", action: "next" },
				{ key: "Ctrl/Cmd+Enter", action: "continue" },
			];
		}
		if (target.matches("button")) {
			return [
				{ key: "Enter", action: "press" },
				{ key: "Tab", action: "next" },
				{ key: "Esc", action: "cancel" },
			];
		}
		return null;
	}

	private getStateValues(state: PropertyCardState): unknown[] {
		return state.hasConflict ? state.selected : state.picker ? state.picker.getValue() : state.selected;
	}

	private findPathForNote(state: PropertyCardState, note: string): string | undefined {
		const conflictNotes = state.conflictContext?.conflictNotes;
		const conflictPaths = state.conflictContext?.conflictPaths;
		if (conflictNotes && conflictPaths) {
			const index = conflictNotes.indexOf(note);
			if (index >= 0 && conflictPaths[index]) {
				return conflictPaths[index];
			}
		}
		return undefined;
	}

	private renderNoteLink(container: HTMLElement, note: string, path?: string): HTMLElement {
		const linkEl = container.createEl("a", {
			cls: "pp-note-link internal-link",
			text: note,
			attr: {
				href: path ?? note,
				"data-href": path ?? note,
				target: "_blank",
				rel: "noopener",
			},
		});

		linkEl.addEventListener("click", (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			void this.openNote(note, event, path);
		});

		linkEl.addEventListener("auxclick", (event: MouseEvent) => {
			if (event.button === 1) {
				event.preventDefault();
				event.stopPropagation();
				void this.openNote(note, event, path);
			}
		});

		linkEl.addEventListener("keydown", (event: KeyboardEvent) => {
			if (event.key === "Enter") {
				event.preventDefault();
				event.stopPropagation();
				void this.openNote(note, undefined, path);
			}
		});

		linkEl.addEventListener("mouseover", (event: MouseEvent) => {
			try {
				if (typeof this.app.workspace?.trigger === "function") {
					this.app.workspace.trigger("hover-link", {
						event,
						source: "obsidian-property-porter",
						hoverParent: this.contentEl,
						targetEl: linkEl,
						linktext: path ?? note,
					});
				}
			} catch {
				// best effort hover preview
			}
		});

		return linkEl;
	}

	private async openNote(note: string, event?: MouseEvent, path?: string): Promise<void> {
		const isMod = event && typeof Keymap?.isModEvent === "function" ? Keymap.isModEvent(event) : false;
		let file: TFile | null = null;
		if (path && typeof this.app.vault?.getAbstractFileByPath === "function") {
			const abstractFile = this.app.vault.getAbstractFileByPath(path);
			if (abstractFile instanceof TFile) {
				file = abstractFile;
			}
		}
		if (!file && typeof this.app.metadataCache?.getFirstLinkpathDest === "function") {
			const dest = this.app.metadataCache.getFirstLinkpathDest(note, "");
			if (dest instanceof TFile) {
				file = dest;
			}
		}
		if (!file && typeof this.app.vault?.getAbstractFileByPath === "function") {
			const direct =
				this.app.vault.getAbstractFileByPath(note) ??
				this.app.vault.getAbstractFileByPath(`${note}.md`);
			if (direct instanceof TFile) {
				file = direct;
			}
		}

		if (file) {
			try {
				await openFileInLeaf(this.app, file, {
					reuseExisting: !isMod,
					newLeaf: isMod || "tab",
				});
				return;
			} catch {
				// Fall back to openLinkText below
			}
		}

		if (typeof this.app.workspace?.openLinkText === "function") {
			try {
				await this.app.workspace.openLinkText(path ?? note, "", isMod || false);
			} catch {
				// best effort
			}
		}
	}
}
