import { App, Modal, AbstractInputSuggest, Notice, Scope } from "obsidian";
import { RowNavigator } from "commons/modal";
import {
	isListProperty,
	getPropertySuggestions,
	getPropertyType,
	normalizeTag,
	rankCandidates,
	ValuePicker,
	datetimePickerOptions,
	type FrontmatterValueSources,
	type ValuePickerOptions,
	type VaultMetadataCatalog,
} from "commons/properties";
import { setTimeoutIn, ownerWindow } from "commons/windows";

let nextPropertyNameId = 0;

export interface PropertyCardState {
	name: string;
	isList: boolean;
	candidates: string[];
	selected: string[];
	hasConflict: boolean;
	notice?: string;
	conflictContext?: ConflictCardContext;
	cardEl?: HTMLElement;
	picker?: ValuePicker;
}

// Describes where a conflict came from so the card can name the notes
// involved instead of leaving the user guessing.
export interface ConflictCardContext {
	/** Notes the conflicting values came from. */
	conflictNotes?: string[];
	/** Note the clipboard value was copied from, when known. */
	clipboardOrigin?: string;
	/** Notes and occurrence counts for each candidate value. */
	valueSources?: FrontmatterValueSources;
}

export interface SelectPropertiesModalOptions {
	title?: string;
	subtitle?: string;
	/** Tooltip for the subtitle badge. */
	subtitleHint?: string;
	conflictNames?: readonly string[];
	finishText?: string;
}

function conflictWarningText(state: PropertyCardState): string {
	return `Choose which ${state.name} value to keep.`;
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
	private clearAllButton: HTMLButtonElement | null = null;
	private propertyPicker: ValuePicker | null = null;
	private navigator: RowNavigator | null = null;
	private addRowEl: HTMLElement | null = null;
	private addHostEl: HTMLElement | null = null;

	constructor(
		app: App,
		private readonly catalog: VaultMetadataCatalog,
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
			let candidates: string[] = [];

			if (Array.isArray(val)) {
				const isTagProp = name === "tags" || name === "tag";
				const seen = new Set<string>();
				for (const item of val) {
					if (item === null || item === undefined) continue;
					const s = isTagProp ? normalizeTag(String(item)).trim() : String(item).trim();
					if (s && !seen.has(s)) {
						seen.add(s);
						candidates.push(s);
					}
				}
			} else if (val !== null && val !== undefined) {
				const s = String(val).trim();
				if (s) candidates = [s];
			}

			const context = this.conflictContext[name];
			const propertyType = getPropertyType(this.catalog, name, candidates);
			if (propertyType === "date" || propertyType === "datetime") {
				candidates.sort((left, right) => Date.parse(right) - Date.parse(left));
			}
			const hasConflict = candidates.length > 1 && (isExplicitConflict || !isList);
			const selected = isList
				? [...candidates]
				: candidates.length > 0
					? [candidates[0]]
				: [];

			this.propertyStates.set(name, {
				name,
				isList,
				candidates,
				selected,
				hasConflict,
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
			section.createEl("h3", { text: "Resolve Property Conflicts" });
			section.createDiv({
				cls: "pp-conflict-info",
				text: "Select one value for each conflicting property before continuing.",
			});
			const conflictContainer = section.createDiv({ cls: "pp-properties-list pp-conflicts-list" });
			for (const state of conflictStates) this.renderPropertyCard(state, conflictContainer);
		}

		const otherStates = Array.from(this.propertyStates.values()).filter(
			(state) => !conflictStates.includes(state)
		);
		if (conflictStates.length) {
			const section = bodyEl.createDiv({ cls: "pp-properties-section" });
			section.createEl("h3", { text: "Other properties" });
			section.createDiv({
				cls: "pp-properties-info",
				text: "These properties have no conflicts and need no action. Edit or exclude them only if you want.",
			});
			this.listContainerEl = section.createDiv({ cls: "pp-properties-list" });
			for (const state of otherStates) this.renderPropertyCard(state, this.listContainerEl);
			this.renderAddPropertyControl(section);
		} else {
			this.listContainerEl = bodyEl.createDiv({ cls: "pp-properties-list" });
			for (const state of otherStates) this.renderPropertyCard(state, this.listContainerEl);
			this.renderAddPropertyControl(bodyEl);
		}

		// Controls
		const controlsEl = this.contentEl.createDiv({ cls: "pp-multi-select-controls" });
		this.hintEl = controlsEl.createDiv({ cls: "pp-multi-select-hint" });
		this.keyboardHintEl = controlsEl.createDiv({ cls: "pp-keyboard-hint" });
		this.keyboardHintEl.setAttribute("aria-live", "polite");
		const buttonsEl = controlsEl.createDiv({ cls: "pp-multi-select-buttons" });

		this.clearAllButton = buttonsEl.createEl("button", {
			text: "Clear all",
			cls: "pp-clear-all-button",
			type: "button",
		});
		this.clearAllButton.addEventListener("click", () => this.clearAll());

		this.doneButton = buttonsEl.createEl("button", {
			text: this.options.finishText ?? "Finish selection",
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
			isSuggestionOpen: () => !!this.contentEl.ownerDocument.querySelector(".suggestion-container"),
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
		this.scope.register(["Alt"], "X", (event) => {
			const target = event.target;
			if (!(target instanceof HTMLElement)) return;
			const cardEl = target.closest<HTMLElement>(".pp-property-card");
			const state = Array.from(this.propertyStates.values()).find(
				(candidate) => candidate.cardEl === cardEl
			);
			if (!state) return;
			this.removeProperty(state.name);
			new Notice(`Property Porter: Excluded ${state.name}`);
			return false;
		});
		this.scope.register(["Mod"], "Backspace", (event) => {
			const target = event.target;
			if (
				!(target instanceof HTMLInputElement) ||
				(target.type !== "radio" && target.value !== "")
			) {
				return;
			}
			this.clearAll();
			return false;
		});

		this.updateControls();

		const win = ownerWindow(this.contentEl) ?? window;
		setTimeoutIn(win, () => this.getInitialRow()?.focus(), 0);
	}

	// Conflicts come first, then tags (the usual reason to open this), then
	// whatever is first, then the add-property row.
	private getInitialRow(): HTMLElement | null {
		const states = Array.from(this.propertyStates.values());
		const state =
			states.find((candidate) => candidate.hasConflict) ??
			states.find((candidate) => candidate.name === "tags") ??
			states[0];
		return state?.cardEl ?? this.addRowEl;
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
		};
		this.propertyStates.set(trimmed, state);
		if (this.listContainerEl) {
			this.renderPropertyCard(state, this.listContainerEl);
		}
		this.updateControls();
		state.cardEl?.scrollIntoView?.({ block: "nearest" });
		return state;
	}

	removeProperty(name: string): void {
		const state = this.propertyStates.get(name);
		if (!state) return;
		const cards = Array.from(this.contentEl.querySelectorAll<HTMLElement>(".pp-property-card"));
		const cardIndex = state.cardEl ? cards.indexOf(state.cardEl) : -1;
		const nextFocusTarget = cards[cardIndex + 1] ?? this.addRowEl;
		state.picker?.destroy();
		state.cardEl?.remove();
		this.propertyStates.delete(name);
		this.updateControls();
		nextFocusTarget?.focus();
	}

	private renderPropertyCard(state: PropertyCardState, container: HTMLElement): void {
		const cardEl = container.createDiv({ cls: "pp-property-card" });
		cardEl.setAttribute("role", "group");
		cardEl.tabIndex = 0;
		state.cardEl = cardEl;

		const header = cardEl.createDiv({ cls: "pp-property-header" });
		const titleGroup = header.createDiv({ cls: "pp-property-title-group" });
		const nameEl = titleGroup.createSpan({ cls: "pp-property-name", text: state.name });
		nameEl.id = `pp-property-name-${++nextPropertyNameId}`;
		cardEl.setAttribute("aria-labelledby", nameEl.id);

		const badgeText =
			state.name === "tags" || state.name === "tag"
				? "Tags"
				: state.isList
					? "List"
					: "Scalar";
		titleGroup.createSpan({
			cls: ["pp-property-badge", state.isList ? "is-list" : "is-scalar"],
			text: badgeText,
		});

		const removeBtn = header.createEl("button", {
			cls: "pp-property-remove-btn",
			text: "Exclude",
			type: "button",
			attr: {
				"aria-label": `Exclude ${state.name}`,
				title: "Exclude this property from the selection",
			},
		});
		removeBtn.addEventListener("click", () => {
			this.removeProperty(state.name);
		});

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
		const propertyType = getPropertyType(this.catalog, state.name, state.candidates);
		const isDateProperty = propertyType === "date" || propertyType === "datetime";
		const datetimeOptions =
			propertyType === "datetime"
				? datetimePickerOptions(state.selected[0] ?? state.candidates[0] ?? "")
				: undefined;
		const datePickerOptions =
			propertyType === "date"
				? { inputType: "date" as const }
				: datetimeOptions ?? {};
		if (state.hasConflict) {
			cardEl.createDiv({
				cls: "pp-property-warning",
				text: conflictWarningText(state),
			});

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
						datetimeOptions?.formatInputValue(state.selected[0] ?? "");
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
						value: candidate,
					},
				});
				candidateRadios.push(radio);
				radio.checked = state.selected[0] === candidate;
				option.createSpan({ cls: "pp-conflict-value", text: candidate });
				const sources = state.conflictContext?.valueSources?.[state.name]?.[candidate] ?? [];
				option.createSpan({
					cls: "pp-conflict-sources",
					text: sources.map(({ note }) => note).join(", "),
				});
				const selectCandidate = (): void => {
					if (!radio.checked) return;
					if (state.selected.length === 1 && state.selected[0] === candidate && !pickerHost?.hidden) return;
					state.selected = [candidate];
					datetimeOptions?.formatInputValue(candidate);
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
				if (state.selected.length === 0 && pickerHost && !pickerHost.hidden) return;
				datetimeOptions?.formatInputValue(state.selected[0] ?? "");
				state.selected = [];
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
			value: state.selected[0] ?? "",
			multiple: false,
			showSingleValueChip: true,
			selectedValueStyle: selectedValueStyle(state.name),
			...datePickerOptions,
			allowCreate: true,
			onChange: (values) => {
				state.selected = values.slice(0, 1);
				datetimeOptions?.formatInputValue(state.selected[0] ?? "");
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
			kind === "list" ? undefined : getPropertyType(this.catalog, state.name, state.candidates);
		const isDateProperty = propertyType === "date" || propertyType === "datetime";
		const isListPicker = kind === "list";
		return {
			suggestions: getPropertySuggestions(this.catalog, state.name),
			knownValues: state.candidates,
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
			value: state.selected,
			multiple: true,
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

	clearAll(): void {
		for (const state of this.propertyStates.values()) {
			state.selected = [];
			state.picker?.setValue([]);
			state.cardEl?.querySelectorAll<HTMLInputElement>('.pp-conflict-options input[type="radio"]')
				.forEach((radio) => {
					radio.checked = false;
				});
			const pickerHost = state.cardEl?.querySelector<HTMLElement>(".pp-property-picker-host");
			if (state.hasConflict && pickerHost) pickerHost.hidden = true;
		}
		this.updateControls();
	}

	submit(): void {
		if (this.submitted) return;
		const unresolved = this.getUnresolvedConflict();
		if (unresolved) {
			unresolved.cardEl?.focus();
			return;
		}
		this.submitted = true;
		this.onSubmit(this.getSelectedProperties());
		this.close();
	}

	getSelectedProperties(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [name, state] of this.propertyStates.entries()) {
			const values = this.getStateValues(state);
			if (values.length === 0) continue;
			if (state.isList) {
				result[name] = values;
			} else {
				const value = values[0];
				result[name] =
					getPropertyType(this.catalog, name, state.candidates) === "checkbox" &&
					(value === "true" || value === "false")
						? value === "true"
						: value;
			}
		}
		return result;
	}

	private updateControls(): void {
		let totalPropsWithValues = 0;
		for (const state of this.propertyStates.values()) {
			const values = this.getStateValues(state);
			if (values.length > 0) totalPropsWithValues++;
		}

		this.hintEl?.setText(
			totalPropsWithValues === 0
				? "Choose properties and values to include."
				: `${totalPropsWithValues} propert${totalPropsWithValues === 1 ? "y" : "ies"} selected with values.`
		);
		if (this.doneButton) {
			this.doneButton.setText(`${this.options.finishText ?? "Save clipboard"} (${totalPropsWithValues})`);
			this.doneButton.disabled = this.hasUnresolvedConflicts();
		}
		if (this.clearAllButton) {
			this.clearAllButton.disabled = totalPropsWithValues === 0;
		}
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
		if (!this.keyboardHintEl) return;
		const row = target.closest<HTMLElement>(".pp-property-card, .pp-add-property-row");
		let hint: string;
		if (row === target) {
			hint =
				target === this.addRowEl
					? "Enter add property · Tab next · Esc cancel"
					: "Enter edit · Tab next · Alt+X exclude · Ctrl/Cmd+Enter save · Esc cancel";
		} else if (row && target.matches('input[type="radio"]')) {
			hint = "↑↓ or 1-9 choose · O other value · Esc done · Tab next";
		} else if (row) {
			hint = "Esc done · Backspace removes last · Tab next · Ctrl/Cmd+Enter save";
		} else if (target.matches("button")) {
			hint = "Enter press · Tab next · Esc cancel";
		} else {
			return;
		}
		this.keyboardHintEl.setText(hint);
	};

	private getUnresolvedConflict(): PropertyCardState | undefined {
		return Array.from(this.propertyStates.values()).find(
			(state) => state.hasConflict && state.selected.length !== 1
		);
	}

	private hasUnresolvedConflicts(): boolean {
		return this.getUnresolvedConflict() !== undefined;
	}

	private getStateValues(state: PropertyCardState): string[] {
		return state.hasConflict ? state.selected : state.picker ? state.picker.getValue() : state.selected;
	}
}
