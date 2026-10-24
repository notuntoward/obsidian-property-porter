import { App, Modal, AbstractInputSuggest } from "obsidian";
import {
	isListProperty,
	getPropertySuggestions,
	getPropertyType,
	normalizeTag,
	rankCandidates,
	ValuePicker,
	type VaultMetadataCatalog,
} from "commons/properties";
import { setTimeoutIn, ownerWindow } from "commons/windows";

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
	updatePills?: () => void;
}

// Describes where a conflict came from so the card can name the notes
// involved instead of leaving the user guessing.
export interface ConflictCardContext {
	/** Notes the conflicting values came from. */
	conflictNotes?: string[];
	/** Note the clipboard value was copied from, when known. */
	clipboardOrigin?: string;
	/** Notes and occurrence counts for each candidate value. */
	valueSources?: Record<string, Record<string, { note: string; count: number }[]>>;
}

export interface SelectPropertiesModalOptions {
	title?: string;
	conflictNames?: readonly string[];
	finishText?: string;
}

function conflictWarningText(state: PropertyCardState): string {
	const ctx = state.conflictContext;
	const sourceNotes = [
		...new Set(
			Object.values(ctx?.valueSources ?? {}).flatMap((values) =>
				Object.values(values).flatMap((sources) => sources.map(({ note }) => note))
			)
		),
	];
	if (sourceNotes.length > 0) {
		return `Choose which ${state.name} to keep. Notes differ: ${sourceNotes.join(", ")}`;
	}
	if (ctx?.clipboardOrigin && ctx.conflictNotes?.length) {
		return `Conflicting values between the clipboard (from ${ctx.clipboardOrigin}) and ${ctx.conflictNotes.join(", ")}: select one`;
	}
	if (ctx?.conflictNotes?.length) {
		return `Conflicting values across ${ctx.conflictNotes.join(", ")}: select one`;
	}
	return "Conflicting values across notes: select one";
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

function getDateTimeOffset(value: string): string {
	return value.match(/(Z|[+-]\d{2}:\d{2})$/i)?.[1] ?? "";
}

function preserveDateTimeOffset(value: string, offset: string): string {
	return getDateTimeOffset(value) ? value : `${value}${offset}`;
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
	private doneButton: HTMLButtonElement | null = null;
	private clearAllButton: HTMLButtonElement | null = null;
	private propertyPicker: ValuePicker | null = null;

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
		this.initPropertyStates(initialProperties);
	}

	private initPropertyStates(initialProperties: Record<string, unknown>): void {
		for (const [name, val] of Object.entries(initialProperties)) {
			const isList = isListProperty(this.catalog, name);
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
			const hasConflict = !isList && candidates.length > 1;
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

		// Search / add property container
		const searchContainer = this.contentEl.createDiv({ cls: "pp-search-container" });
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
			placeholder: "Search or add a property…",
			ariaLabel: "Search or add a property to the clipboard",
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
			const section = this.contentEl.createDiv({ cls: "pp-conflict-section" });
			section.createEl("h3", { text: "Resolve conflicts" });
			const conflictContainer = section.createDiv({ cls: "pp-properties-list pp-conflicts-list" });
			for (const state of conflictStates) this.renderPropertyCard(state, conflictContainer);
		}

		const otherStates = Array.from(this.propertyStates.values()).filter(
			(state) => !conflictStates.includes(state)
		);
		if (conflictStates.length) {
			const section = this.contentEl.createDiv({ cls: "pp-properties-section" });
			section.createEl("h3", { text: "Properties to paste" });
			this.listContainerEl = section.createDiv({ cls: "pp-properties-list" });
		} else {
			this.listContainerEl = this.contentEl.createDiv({ cls: "pp-properties-list" });
		}
		for (const state of otherStates) this.renderPropertyCard(state, this.listContainerEl);

		// Controls
		const controlsEl = this.contentEl.createDiv({ cls: "pp-multi-select-controls" });
		this.hintEl = controlsEl.createDiv({ cls: "pp-multi-select-hint" });
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
		this.contentEl.addEventListener("keydown", this.handleConflictEnter, true);

		this.updateControls();

		const win = ownerWindow(this.contentEl) ?? window;
		setTimeoutIn(win, () => {
			if (conflictStates.length) {
				const conflictInput = this.contentEl.querySelector<HTMLInputElement>(".pp-conflict-option input");
				(conflictInput ?? this.doneButton)?.focus();
				return;
			}
			this.propertyPicker?.inputEl.focus();
		}, 0);
	}

	onClose(): void {
		this.contentEl.removeEventListener("keydown", this.handleConflictEnter, true);
		for (const state of this.propertyStates.values()) {
			state.picker?.destroy();
		}
		this.propertyPicker?.destroy();
		this.propertyPicker = null;
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
		state.picker?.destroy();
		state.cardEl?.remove();
		this.propertyStates.delete(name);
		this.updateControls();
	}

	private renderPropertyCard(state: PropertyCardState, container: HTMLElement): void {
		const cardEl = container.createDiv({ cls: "pp-property-card" });
		state.cardEl = cardEl;

		const header = cardEl.createDiv({ cls: "pp-property-header" });
		const titleGroup = header.createDiv({ cls: "pp-property-title-group" });
		titleGroup.createSpan({ cls: "pp-property-name", text: state.name });

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
			text: "Don't paste",
			type: "button",
			attr: {
				"aria-label": `Exclude ${state.name}`,
				title: "Exclude this whole property from the paste",
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
		const dateTimeOffset = { value: getDateTimeOffset(state.selected[0] ?? state.candidates[0] ?? "") };
		const datePickerOptions =
			propertyType === "date"
				? { inputType: "date" as const }
				: propertyType === "datetime"
					? {
							inputType: "datetime-local" as const,
							parseInputValue: (value: string) => preserveDateTimeOffset(value, dateTimeOffset.value),
						}
					: {};
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
					suggestions: getPropertySuggestions(this.catalog, state.name),
					knownValues: state.candidates,
					value: "",
					multiple: false,
					showSingleValueChip: true,
					suppressNewBadge: isDateProperty,
					confirmNewEntries: !isDateProperty,
					...datePickerOptions,
					allowCreate: true,
					kind: "value",
					context: state.name,
					classPrefix: "pp",
					getCreateLabel: (value) => `Add "${value}" as a new ${state.name} value…`,
					placeholder: `Choose or type ${state.name}…`,
					ariaLabel: `${state.name} value`,
					onChange: (values) => {
						state.selected = values.slice(0, 1);
						dateTimeOffset.value =
							getDateTimeOffset(state.selected[0] ?? "") || dateTimeOffset.value;
						this.updateControls();
					},
				});
				state.picker.inputEl.focus();
			};

			for (const candidate of state.candidates) {
				const option = optionsEl.createEl("label", { cls: "pp-conflict-option" });
				const radio = option.createEl("input", {
					type: "radio",
					attr: {
						name: `pp-${state.name}`,
						value: candidate,
					},
				});
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
					dateTimeOffset.value = getDateTimeOffset(candidate);
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
				dateTimeOffset.value =
					getDateTimeOffset(state.selected[0] ?? "") || dateTimeOffset.value;
				state.selected = [];
				ensurePicker();
				this.updateControls();
			};
			otherRadio.addEventListener("click", selectOther);
			otherRadio.addEventListener("change", selectOther);
			return;
		}

		const pickerHost = cardEl.createDiv({ cls: "pp-property-picker-host" });
		state.picker = new ValuePicker(this.app, pickerHost, {
			suggestions: getPropertySuggestions(this.catalog, state.name),
			knownValues: state.candidates,
			value: state.selected[0] ?? "",
			multiple: false,
			showSingleValueChip: true,
			suppressNewBadge: isDateProperty,
			confirmNewEntries: !isDateProperty,
			...datePickerOptions,
			allowCreate: true,
			kind: "value",
			context: state.name,
			classPrefix: "pp",
			getCreateLabel: (value) => `Add "${value}" as a new ${state.name} value…`,
			placeholder: `Choose or type ${state.name}…`,
			ariaLabel: `${state.name} value`,
			onChange: (values) => {
				state.selected = values.slice(0, 1);
				dateTimeOffset.value = getDateTimeOffset(state.selected[0] ?? "") || dateTimeOffset.value;
				this.updateControls();
			},
		});
	}

	private renderListBody(state: PropertyCardState, cardEl: HTMLElement): void {
		let updatePills: (() => void) | undefined;

		if (state.candidates.length > 0) {
			const actionsEl = cardEl.createDiv({ cls: "pp-list-actions" });
			const selectAllBtn = actionsEl.createEl("button", {
				text: "Select all",
				cls: ["pp-list-action-btn", "pp-select-all-btn"],
				type: "button",
			});
			selectAllBtn.addEventListener("click", () => {
				state.selected = [...state.candidates];
				state.picker?.setValue(state.selected);
				updatePills?.();
				this.updateControls();
			});

			const clearBtn = actionsEl.createEl("button", {
				text: "Clear",
				cls: ["pp-list-action-btn", "pp-clear-btn"],
				type: "button",
			});
			clearBtn.addEventListener("click", () => {
				state.selected = [];
				state.picker?.setValue([]);
				updatePills?.();
				this.updateControls();
			});

			const optionsEl = cardEl.createDiv({ cls: "pp-options-container" });
			const candidatePills: HTMLButtonElement[] = [];

			for (const candidate of state.candidates) {
				const isSelected = state.selected.includes(candidate);
				const optionEl = optionsEl.createDiv({ cls: "pp-list-option" });
				const pill = optionEl.createEl("button", {
					cls: ["pp-option-pill", isSelected ? "is-selected" : ""],
					text: candidate,
					type: "button",
				});
				const sources = state.conflictContext?.valueSources?.[state.name]?.[candidate] ?? [];
				const totalCount = sources.reduce((total, source) => total + source.count, 0);
				if (totalCount > 1) {
					optionEl.createSpan({
						cls: "pp-list-candidate-sources",
						text: `×${totalCount} in ${sources.map(({ note }) => note).join(", ")}`,
					});
				}
				pill.addEventListener("click", () => {
					if (state.selected.includes(candidate)) {
						state.selected = state.selected.filter((x) => x !== candidate);
					} else {
						state.selected.push(candidate);
					}
					state.picker?.setValue(state.selected);
					updatePills?.();
					this.updateControls();
				});
				candidatePills.push(pill);
			}

			updatePills = () => {
				for (let i = 0; i < state.candidates.length; i++) {
					const c = state.candidates[i];
					const pill = candidatePills[i];
					if (pill) {
						if (state.selected.includes(c)) {
							pill.addClass("is-selected");
						} else {
							pill.removeClass("is-selected");
						}
					}
				}
			};
			state.updatePills = updatePills;
		}

		const isTagProp = state.name === "tags" || state.name === "tag";
		const pickerHost = cardEl.createDiv({ cls: "pp-property-picker-host" });
		state.picker = new ValuePicker(this.app, pickerHost, {
			suggestions: getPropertySuggestions(this.catalog, state.name),
			knownValues: state.candidates,
			value: state.selected,
			multiple: true,
			allowCreate: true,
			kind: "value",
			context: state.name,
			classPrefix: "pp",
			getCreateLabel: (value) => `Add "${value}" as a new ${state.name} value…`,
			normalizeValue: isTagProp ? normalizeTag : undefined,
			placeholder: `Add ${state.name}…`,
			ariaLabel: `${state.name} values`,
			onChange: (values) => {
				state.selected = values;
				updatePills?.();
				this.updateControls();
			},
		});
	}

	clearAll(): void {
		for (const state of this.propertyStates.values()) {
			state.selected = [];
			state.picker?.setValue([]);
			state.updatePills?.();
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
		this.submitted = true;
		const result: Record<string, unknown> = {};
		for (const [name, state] of this.propertyStates.entries()) {
			const values = state.hasConflict ? state.selected : state.picker ? state.picker.getValue() : state.selected;
			if (values.length === 0) continue;
			if (state.isList) {
				result[name] = values;
			} else {
				result[name] = values[0];
			}
		}
		this.onSubmit(result);
		this.close();
	}

	getSelectedProperties(): Record<string, unknown> {
		const result: Record<string, unknown> = {};
		for (const [name, state] of this.propertyStates.entries()) {
			const values = state.hasConflict ? state.selected : state.picker ? state.picker.getValue() : state.selected;
			if (values.length === 0) continue;
			if (state.isList) {
				result[name] = values;
			} else {
				result[name] = values[0];
			}
		}
		return result;
	}

	private updateControls(): void {
		let totalPropsWithValues = 0;
		for (const state of this.propertyStates.values()) {
			const values = state.hasConflict ? state.selected : state.picker ? state.picker.getValue() : state.selected;
			if (values.length > 0) totalPropsWithValues++;
		}

		this.hintEl?.setText(
			totalPropsWithValues === 0
				? "Select or add properties and values to paste."
				: `${totalPropsWithValues} propert${totalPropsWithValues === 1 ? "y" : "ies"} selected with values.`
		);
		if (this.doneButton) {
			this.doneButton.setText(`${this.options.finishText ?? "Save clipboard"} (${totalPropsWithValues})`);
		}
		if (this.clearAllButton) {
			this.clearAllButton.disabled = totalPropsWithValues === 0;
		}
	}

	private readonly handleConflictEnter = (event: KeyboardEvent): void => {
		if (event.key !== "Enter") return;
		if (!(event.target instanceof HTMLInputElement)) return;
		if (!event.target.matches('.pp-conflict-option input[type="radio"]')) return;
		event.preventDefault();
		event.stopPropagation();
		this.submit();
	};
}
