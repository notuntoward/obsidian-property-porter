import { App, Modal, AbstractInputSuggest } from "obsidian";
import {
	isListProperty,
	getPropertySuggestions,
	normalizeTag,
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
	/** Notes that contain more than one occurrence of the property. */
	duplicateIn?: string[];
}

// Builds the warning line for a conflict card, naming the notes involved
// so the user knows where each conflicting value came from.
function conflictWarningText(state: PropertyCardState): string {
	const ctx = state.conflictContext;
	if (ctx?.duplicateIn?.length) {
		const notes = ctx.duplicateIn.join(", ");
		return `${notes} ${ctx.duplicateIn.length === 1 ? "has" : "have"} more than one ${state.name} value: select the one to keep`;
	}
	if (ctx?.clipboardOrigin && ctx.conflictNotes?.length) {
		return `Conflicting values between the clipboard (from ${ctx.clipboardOrigin}) and ${ctx.conflictNotes.join(", ")}: select one`;
	}
	if (ctx?.conflictNotes?.length) {
		return `Conflicting values across ${ctx.conflictNotes.join(", ")}: select one`;
	}
	return "Conflicting values across notes: select one";
}

export class PropertyNameSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private readonly getSuggestionsList: () => string[],
		private readonly onSelectProperty: (name: string) => void
	) {
		super(app, inputEl);
	}

	getSuggestions(query: string): string[] {
		const lower = query.trim().toLowerCase();
		const available = this.getSuggestionsList();
		if (!lower) return available.slice(0, 20);
		return available.filter((name) => name.toLowerCase().includes(lower)).slice(0, 20);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.onSelectProperty(value);
	}
}

export class SelectPropertiesModal extends Modal {
	readonly propertyStates = new Map<string, PropertyCardState>();
	private listContainerEl: HTMLElement | null = null;
	private submitted = false;
	private hintEl: HTMLElement | null = null;
	private doneButton: HTMLButtonElement | null = null;
	private clearAllButton: HTMLButtonElement | null = null;
	private addPropertyInput: HTMLInputElement | null = null;
	private addPropertySuggest: PropertyNameSuggest | null = null;

	constructor(
		app: App,
		private readonly catalog: VaultMetadataCatalog,
		initialProperties: Record<string, unknown>,
		private readonly onSubmit: (selected: Record<string, unknown>) => void,
		private readonly onCancel: () => void,
		private readonly conflictContext: Record<string, ConflictCardContext> = {}
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
			// A within-note duplicate is a conflict even for list properties such
			// as tags, and even when both occurrences carry the same value: the
			// user picks which value (or none) should survive.
			const forceConflict = Boolean(context?.duplicateIn?.length);
			const hasConflict = forceConflict || (!isList && candidates.length > 1);
			const selected = isList && !hasConflict
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
				conflictContext: context,
			});
		}
	}

	get inputEl(): HTMLInputElement | null {
		return this.addPropertyInput;
	}

	onOpen(): void {
		this.submitted = false;
		this.contentEl.empty();
		this.contentEl.addClass("pp-select-properties-modal");
		this.titleEl.setText("Select properties to paste");

		// Search / add property container
		const searchContainer = this.contentEl.createDiv({ cls: "pp-search-container" });
		this.addPropertyInput = searchContainer.createEl("input", {
			cls: "pp-search-input",
			type: "text",
			placeholder: "Add property to selection…",
			attr: { "aria-label": "Add property to selection" },
		});

		this.addPropertySuggest = new PropertyNameSuggest(
			this.app,
			this.addPropertyInput,
			() => this.catalog.properties.map((p) => p.name).filter((name) => !this.propertyStates.has(name)),
			(name) => {
				this.addProperty(name);
				if (this.addPropertyInput) this.addPropertyInput.value = "";
			}
		);

		this.addPropertyInput.addEventListener("keydown", (e: KeyboardEvent) => {
			if (e.key === "Enter") {
				const val = this.addPropertyInput?.value.trim();
				if (val) {
					e.preventDefault();
					this.addProperty(val);
					if (this.addPropertyInput) this.addPropertyInput.value = "";
				}
			}
		});

		// Properties list
		this.listContainerEl = this.contentEl.createDiv({ cls: "pp-properties-list" });
		for (const state of this.propertyStates.values()) {
			this.renderPropertyCard(state, this.listContainerEl);
		}

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
			text: "Finish selection",
			cls: ["mod-cta", "pp-finish-button"],
			type: "button",
		});
		this.doneButton.addEventListener("click", () => this.submit());

		this.updateControls();

		const win = ownerWindow(this.contentEl) ?? window;
		setTimeoutIn(win, () => this.addPropertyInput?.focus(), 0);
	}

	onClose(): void {
		for (const state of this.propertyStates.values()) {
			state.picker?.destroy();
		}
		this.addPropertySuggest = null;
		this.contentEl.empty();
		if (!this.submitted) this.onCancel();
	}

	addProperty(name: string): void {
		const trimmed = name.trim();
		if (!trimmed || this.propertyStates.has(trimmed)) return;

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
			text: "Remove",
			type: "button",
			attr: { "aria-label": `Remove ${state.name}` },
		});
		removeBtn.addEventListener("click", () => {
			this.removeProperty(state.name);
		});

		if (state.isList && !state.hasConflict) {
			this.renderListBody(state, cardEl);
		} else {
			this.renderScalarBody(state, cardEl);
		}
	}

	private renderScalarBody(state: PropertyCardState, cardEl: HTMLElement): void {
		let updatePills: (() => void) | undefined;

		if (state.hasConflict) {
			cardEl.createDiv({
				cls: "pp-property-warning",
				text: conflictWarningText(state),
			});

			const optionsEl = cardEl.createDiv({ cls: "pp-options-container" });
			const pillButtons: HTMLButtonElement[] = [];

			for (const candidate of state.candidates) {
				const pill = optionsEl.createEl("button", {
					cls: [
						"pp-option-pill",
						state.selected[0] === candidate ? "is-selected" : "",
					],
					text: candidate,
					type: "button",
				});
				pill.addEventListener("click", () => {
					state.selected = [candidate];
					state.picker?.setValue(candidate);
					updatePills?.();
					this.updateControls();
				});
				pillButtons.push(pill);
			}

			updatePills = () => {
				for (let i = 0; i < state.candidates.length; i++) {
					const c = state.candidates[i];
					const pill = pillButtons[i];
					if (pill) {
						if (state.selected[0] === c) {
							pill.addClass("is-selected");
						} else {
							pill.removeClass("is-selected");
						}
					}
				}
			};
			state.updatePills = updatePills;
		}

		const pickerHost = cardEl.createDiv({ cls: "pp-property-picker-host" });
		state.picker = new ValuePicker(this.app, pickerHost, {
			suggestions: getPropertySuggestions(this.catalog, state.name),
			value: state.selected[0] ?? "",
			multiple: false,
			showSingleValueChip: true,
			allowCreate: true,
			kind: "value",
			context: state.name,
			classPrefix: "pp",
			placeholder: `Choose or type ${state.name}…`,
			ariaLabel: `${state.name} value`,
			onChange: (values) => {
				state.selected = values.slice(0, 1);
				updatePills?.();
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
				const pill = optionsEl.createEl("button", {
					cls: ["pp-option-pill", isSelected ? "is-selected" : ""],
					text: candidate,
					type: "button",
				});
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
			value: state.selected,
			multiple: true,
			allowCreate: true,
			kind: "value",
			context: state.name,
			classPrefix: "pp",
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
		}
		this.updateControls();
	}

	submit(): void {
		if (this.submitted) return;
		this.submitted = true;
		const result: Record<string, unknown> = {};
		for (const [name, state] of this.propertyStates.entries()) {
			const values = state.picker ? state.picker.getValue() : state.selected;
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
			const values = state.picker ? state.picker.getValue() : state.selected;
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
			const values = state.picker ? state.picker.getValue() : state.selected;
			if (values.length > 0) totalPropsWithValues++;
		}

		this.hintEl?.setText(
			totalPropsWithValues === 0
				? "Select or add properties and values to paste."
				: `${totalPropsWithValues} propert${totalPropsWithValues === 1 ? "y" : "ies"} selected with values.`
		);
		if (this.doneButton) {
			this.doneButton.setText(`Finish selection (${totalPropsWithValues})`);
		}
		if (this.clearAllButton) {
			this.clearAllButton.disabled = totalPropsWithValues === 0;
		}
	}
}
