import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	Notice,
	Modal,
	FileView,
	WorkspaceLeaf,
	type SettingDefinitionItem,
} from "obsidian";
import {
	filterFrontmatter,
	mergeFrontmatter,
	unionFrontmatter,
	isEmptyPropertyValue,
	countPropertyValue,
	parseCommaList,
	type PasteMode,
} from "./frontmatter";
import {
	buildNavigationModel,
	getGroupForLeaf,
	type NavigationModel,
} from "commons/workspace";
import { setTimeoutIn, ownerWindow } from "commons/windows";
import {
	collectVaultMetadata,
	getPropertySuggestions,
	normalizeTag,
	ValuePicker,
} from "commons/properties";
import { FileSuggestModal } from "./utils/modal";
import { SelectPropertiesModal } from "./select-properties-modal";

interface PropertyPorterSettings {
	onlyInclude: string;
	excludeKeys: string;
	pasteMode: PasteMode;
}

const DEFAULT_SETTINGS: PropertyPorterSettings = {
	onlyInclude: "tags",
	excludeKeys: "aliases, created date, modified date",
	pasteMode: "merge",
};

export const NOTICE_TIMEOUT_MS = 7000;
export const NOTICE_NO_PROPERTIES_TO_PASTE =
	'Property Porter: No properties copied. Use "Copy properties" (not system clipboard).';
export const NOTICE_CLEARED_COPIED_TAGS = "Property Porter: No tags selected. Cleared copied tags.";
export const NOTICE_CLEARED_COPIED_PROPERTIES = "Property Porter: No properties selected. Cleared copied properties.";

// Obsidian injects a positional cache object (`position`) into frontmatter
// read from metadataCache/processFrontMatter; strip it before copy/paste so
// we never write it back and corrupt the destination file's internal
// tracking data.
function stripPosition(fm: Record<string, unknown>): Record<string, unknown> {
	const copy = { ...fm };
	delete copy.position;
	return copy;
}

export default class PropertyPorter extends Plugin {
	settings: PropertyPorterSettings = DEFAULT_SETTINGS;
	clipboard: Record<string, unknown> = {};
	statusBarItem: HTMLElement;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar();

		this.addCommand({
			id: "copy-properties",
			name: "Copy properties from active note",
			callback: () => this.copyProperties(),
		});

		this.addCommand({
			id: "copy-properties-from",
			name: "Copy properties from another note",
			callback: () => this.copyPropertiesFrom(),
		});

		this.addCommand({
			id: "paste-properties",
			name: "Paste properties into another note",
			callback: () => this.pasteProperties(),
		});

		this.addCommand({
			id: "paste-into-active",
			name: "Paste properties into active note",
			callback: () => this.pasteIntoActive(),
		});

		this.addCommand({
			id: "paste-into-active-tab-group",
			name: "Paste properties into the active tab group",
			callback: () => this.pasteIntoActiveTabGroup(),
		});

		this.addCommand({
			id: "copy-from-active-tab-group",
			name: "Copy properties from the active tab group",
			callback: () => this.copyPropertiesFromActiveTabGroup(),
		});

		this.addCommand({
			id: "clear-clipboard",
			name: "Clear properties clipboard",
			callback: () => this.clearClipboard(),
		});

		this.addCommand({
			id: "select-properties-to-paste",
			name: "Select properties to paste",
			callback: () => this.selectPropertiesToPaste(),
		});

		this.addCommand({
			id: "select-tags-to-paste",
			name: "Select tags to paste",
			callback: () => this.selectTagsToPaste(),
		});

		this.addSettingTab(new PropertyPorterSettingTab(this.app, this));
	}

	onunload(): void {
		this.clipboard = {};
		this.updateStatusBar();
	}

	async loadSettings(): Promise<void> {
		// `autoClear` was removed: paste never clears; copy always replaces.
		const { autoClear: _legacyAutoClear, ...stored } =
			((await this.loadData()) ?? {}) as Partial<PropertyPorterSettings> & { autoClear?: unknown };
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.updateStatusBar();
	}

	countClipboardValues(): number {
		let sum = 0;
		for (const value of Object.values(this.clipboard)) {
			sum += countPropertyValue(value);
		}
		return sum;
	}

	updateStatusBar(): void {
		const count = this.countClipboardValues();
		this.statusBarItem.setText(count > 0 ? `PP: ${count}` : "");
	}

	getActiveFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	getParsedFrontmatter(file: TFile): Record<string, unknown> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) return {};
		return stripPosition(cache.frontmatter);
	}

	getFilteredSourceFrontmatter(file?: TFile | null): Record<string, unknown> | null {
		const source = file ?? this.getActiveFile();
		if (!source) {
			new Notice("Property Porter: No active file");
			return null;
		}

		const fm = this.getParsedFrontmatter(source);
		return filterFrontmatter(fm, this.settings.onlyInclude, this.settings.excludeKeys);
	}

	// Copies the given frontmatter onto the clipboard, refreshes the status
	// bar, and reports how many values were copied. Shared by every copy
	// command so the clipboard-selection rule stays in one place.
	applyClipboard(fm: Record<string, unknown>): void {
		this.clipboard = fm;
		this.updateStatusBar();
		const count = this.countClipboardValues();
		new Notice(`Property Porter: ${count} propert${count === 1 ? "y" : "ies"} copied`);
	}

	async copyProperties(): Promise<void> {
		const fm = this.getFilteredSourceFrontmatter();
		if (!fm) return;
		this.applyClipboard(fm);
	}

	// Copies properties from a note the user picks via the same file selector
	// used by "Paste properties into another note", then applies the same
	// copy logic as `copyProperties`.
	async copyPropertiesFrom(): Promise<void> {
		const file = await this.pickTargetFile();
		if (!file) return;
		const fm = this.getFilteredSourceFrontmatter(file);
		if (!fm) return;
		this.applyClipboard(fm);
	}

	// Collects properties from every note in the active tab group, reusing the
	// same group resolution and per-note filtering as the other commands, then
	// unions them into a single clipboard payload (list properties accumulate
	// every distinct value across the notes).
	async copyPropertiesFromActiveTabGroup(): Promise<void> {
		const files = this.getActiveTabGroupFiles();
		if (files.length === 0) {
			new Notice("Property Porter: No markdown files in the active tab group");
			return;
		}

		const collected = files
			.map((file) => this.getFilteredSourceFrontmatter(file))
			.filter((fm): fm is Record<string, unknown> => fm !== null);
		if (collected.length === 0) return;

		this.applyClipboard(unionFrontmatter(collected));
	}

	clearClipboard(): void {
		this.clipboard = {};
		this.updateStatusBar();
	}

	hasClipboardContent(): boolean {
		return Object.values(this.clipboard).some((value) => !isEmptyPropertyValue(value));
	}

	async pasteProperties(targetFile?: TFile | null): Promise<void> {
		if (!this.hasClipboardContent()) {
			new Notice(NOTICE_NO_PROPERTIES_TO_PASTE, NOTICE_TIMEOUT_MS);
			return;
		}

		const file = targetFile ?? (await this.pickTargetFile());
		if (!file) return;

		await this.writeProperties(file);
		new Notice(`Property Porter: Pasted properties into ${file.basename}`);
	}

	// Writes the clipboard into one file. Each call gets its own deep copy so
	// pasted notes never share array/object references with the clipboard or
	// with each other.
	private async writeProperties(file: TFile): Promise<void> {
		const payload = structuredClone(this.clipboard);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const merged = this.mergeFrontmatter(payload, stripPosition(frontmatter));
			for (const [key, value] of Object.entries(merged)) {
				frontmatter[key] = value;
			}
		});
	}

	async pasteIntoActive(): Promise<void> {
		const active = this.getActiveFile();
		if (!active) {
			new Notice("Property Porter: No active file");
			return;
		}
		await this.pasteProperties(active);
	}

	buildNavigationModel(activeLeaf: WorkspaceLeaf | null = null): NavigationModel {
		return buildNavigationModel(this.app, activeLeaf);
	}

	// Returns the markdown files open in the same canonical tab group
	// (window + parent) as the active leaf, excluding sidebar leaves.
	// Pop-out windows are handled automatically because the group identity
	// is (native window, WorkspaceParent), not just the parent object.
	getActiveTabGroupFiles(): TFile[] {
		const activeLeaf = this.app.workspace.activeLeaf;
		if (!activeLeaf) return [];

		const activeGroup = getGroupForLeaf(buildNavigationModel(this.app, activeLeaf), activeLeaf);

		if (!activeGroup) return [];

		const files: TFile[] = [];
		const seen = new Set<string>();

		for (const leaf of activeGroup.leaves) {
			if (!(leaf.view instanceof FileView)) continue;
			const file = leaf.view.file;
			if (file && !seen.has(file.path)) {
				seen.add(file.path);
				files.push(file);
			}
		}

		return files;
	}

	async pasteIntoActiveTabGroup(): Promise<void> {
		if (!this.hasClipboardContent()) {
			new Notice(NOTICE_NO_PROPERTIES_TO_PASTE, NOTICE_TIMEOUT_MS);
			return;
		}

		const files = this.getActiveTabGroupFiles();
		if (files.length === 0) {
			new Notice("Property Porter: No markdown files in the active tab group");
			return;
		}

		for (const file of files) {
			await this.writeProperties(file);
		}
		new Notice(
			`Property Porter: Pasted properties into ${files.length} note${
				files.length === 1 ? "" : "s"
			}`
		);
	}

	async pickTargetFile(): Promise<TFile | null> {
		return new Promise((resolve) => {
			const files = this.app.vault
				.getMarkdownFiles()
				.filter((f) => f !== this.getActiveFile());
			if (files.length === 0) {
				new Notice("Property Porter: No other markdown files found");
				resolve(null);
				return;
			}

			new FileSuggestModal(this.app, files, (file) => {
				resolve(file);
			}).open();
		});
	}

	getKnownTagsForPicking(): string[] {
		return getPropertySuggestions(collectVaultMetadata(this.app), "tags");
	}

	getClipboardTags(): string[] {
		const value = this.clipboard["tags"];
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		for (const v of value) {
			if (typeof v === "string" && v.length > 0) seen.add(v);
		}
		return Array.from(seen);
	}

	async selectTagsToPaste(): Promise<void> {
		const knownTags = this.getKnownTagsForPicking();
		const existingTags = this.getClipboardTags();
		const result = await new Promise<{
			items: string[];
			cancelled: boolean;
		}>((resolve) => {
			new MultiSelectSuggestModal(
				this.app,
				knownTags,
				"",
				(selectedItems) => resolve({ items: selectedItems, cancelled: false }),
				() => resolve({ items: [], cancelled: true }),
				existingTags
			).open();
		});

		// Escape/close without finishing is a true cancel: leave any
		// existing clipboard untouched and stay silent.
		if (result.cancelled) return;

		// Clicking "Finish selection" always commits, even with zero tags,
		// since that's how the user clears a previously accumulated
		// selection (e.g. "Clear all" then "Finish selection (0)").
		const selected = result.items;
		this.clipboard = { tags: selected };
		this.updateStatusBar();
		if (selected.length === 0) {
			new Notice(NOTICE_CLEARED_COPIED_TAGS);
			return;
		}
		new Notice(
			`Property Porter: ${selected.length} tag${
				selected.length === 1 ? "" : "s"
			} ready to paste`
		);
	}

	async selectPropertiesToPaste(): Promise<void> {
		const catalog = collectVaultMetadata(this.app);
		const tabFiles = this.getActiveTabGroupFiles();
		let initialProperties: Record<string, unknown> = {};

		if (tabFiles.length > 1) {
			const collected = tabFiles
				.map((f) => this.getFilteredSourceFrontmatter(f))
				.filter((fm): fm is Record<string, unknown> => fm !== null);
			initialProperties = unionFrontmatter(collected, { gatherConflicts: true });
		} else if (this.hasClipboardContent()) {
			initialProperties = { ...this.clipboard };
		} else {
			const active = this.getActiveFile();
			if (active) {
				const fm = this.getFilteredSourceFrontmatter(active);
				if (fm) initialProperties = { ...fm };
			}
		}

		const result = await new Promise<{
			properties: Record<string, unknown>;
			cancelled: boolean;
		}>((resolve) => {
			new SelectPropertiesModal(
				this.app,
				catalog,
				initialProperties,
				(selected) => resolve({ properties: selected, cancelled: false }),
				() => resolve({ properties: {}, cancelled: true })
			).open();
		});

		if (result.cancelled) return;

		this.clipboard = result.properties;
		this.updateStatusBar();
		const count = this.countClipboardValues();
		if (count === 0) {
			new Notice(NOTICE_CLEARED_COPIED_PROPERTIES);
			return;
		}
		new Notice(
			`Property Porter: ${count} propert${count === 1 ? "y" : "ies"} ready to paste`
		);
	}

	mergeFrontmatter(
		source: Record<string, unknown>,
		destination: Record<string, unknown>
	): Record<string, unknown> {
		return mergeFrontmatter(source, destination, this.settings.pasteMode);
	}

	deepMerge(_source: unknown, _destination: unknown): unknown {
		throw new Error(
			"deepMerge is extracted to ./frontmatter and should not be called on the plugin instance."
		);
	}

	mergeArrays(_source: unknown[], _destination: unknown[]): unknown[] {
		throw new Error(
			"mergeArrays is extracted to ./frontmatter and should not be called on the plugin instance."
		);
	}

	normalizeArrayItems(_arr: unknown[]): unknown[] {
		throw new Error(
			"normalizeArrayItems is extracted to ./frontmatter and should not be called on the plugin instance."
		);
	}
}

export { FileSuggestModal, FileSuggestModal as SuggestFilesModal, SelectPropertiesModal };

export class MultiSelectSuggestModal extends Modal {
	private picker: ValuePicker | null = null;
	private selected: string[];
	private submitted = false;
	private hintEl: HTMLElement | null = null;
	private doneButton: HTMLButtonElement | null = null;
	private clearAllButton: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private readonly values: string[],
		private readonly prefix: string,
		private readonly onSubmit: (selected: string[]) => void,
		private readonly onCancel: () => void,
		initialSelected: string[] = []
	) {
		super(app);
		this.selected = [
			...new Set(initialSelected.map((value) => normalizeTag(value).trim()).filter(Boolean)),
		];
	}

	get inputEl(): HTMLInputElement {
		if (!this.picker) throw new Error("Tag picker is not open");
		return this.picker.inputEl;
	}

	getSelectedValues(): string[] {
		return this.picker?.getValue() ?? [...this.selected];
	}

	onOpen(): void {
		this.submitted = false;
		this.contentEl.empty();
		this.contentEl.addClass("pp-multi-select-modal");

		const pickerHost = this.contentEl.createDiv({ cls: "pp-tag-picker" });
		this.picker = new ValuePicker(this.app, pickerHost, {
			suggestions: this.values,
			value: this.selected,
			multiple: true,
			allowCreate: true,
			kind: "value",
			context: "tags",
			classPrefix: "pp",
			normalizeValue: normalizeTag,
			placeholder: "Search tags or type a new tag…",
			ariaLabel: "Tags to paste",
			getCreateLabel: (value) =>
				`Create new tag: ${this.prefix}${normalizeTag(value).trim()}`,
			onChange: (values) => {
				this.selected = values;
				this.updateControls();
			},
		});
		this.selected = this.picker.getValue();
		this.inputEl.addEventListener("keydown", this.handleInputKeydown, true);

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
			text: "Finish selection (0)",
			cls: ["mod-cta", "pp-finish-button"],
			type: "button",
		});
		this.doneButton.addEventListener("click", () => this.submit());
		this.updateControls();

		const win = ownerWindow(this.contentEl) ?? window;
		setTimeoutIn(win, () => this.picker?.inputEl.focus(), 0);
	}

	onClose(): void {
		if (this.picker) {
			this.picker.inputEl.removeEventListener("keydown", this.handleInputKeydown, true);
			this.picker.destroy();
			this.picker = null;
		}
		this.contentEl.empty();
		if (!this.submitted) this.onCancel();
	}

	addValue(value: string): void {
		const normalized = normalizeTag(value).trim();
		if (!normalized) return;
		if (!this.selected.includes(normalized)) this.selected.push(normalized);
		this.picker?.setValue(this.selected);
		this.updateControls();
	}

	clearAll(): void {
		this.selected = [];
		this.picker?.setValue([]);
		this.updateControls();
		this.picker?.inputEl.focus();
	}

	submit(): void {
		if (this.submitted) return;
		this.submitted = true;
		this.onSubmit(this.getSelectedValues());
		this.close();
	}

	private readonly handleInputKeydown = (event: KeyboardEvent): void => {
		if (this.inputEl.value.trim() !== "") return;

		if (event.key === "Enter") {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (this.getSelectedValues().length > 0) this.submit();
			return;
		}

		if (event.key === "Backspace" && (event.ctrlKey || event.metaKey)) {
			event.preventDefault();
			event.stopImmediatePropagation();
			if (this.getSelectedValues().length > 0) this.clearAll();
		}
	};

	private updateControls(): void {
		const count = this.getSelectedValues().length;
		this.hintEl?.setText(
			count === 0
				? "Choose existing tags or type a tag and confirm it before adding."
				: "Empty Enter finishes. Backspace removes the last tag; Ctrl/Cmd+Backspace clears all."
		);
		if (this.doneButton) this.doneButton.setText(`Finish selection (${count})`);
		if (this.clearAllButton) this.clearAllButton.disabled = count === 0;
	}
}

export class PropertyPorterSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: PropertyPorter
	) {
		super(app, plugin);
	}

	private isExcludeKeysDisabled(): boolean {
		return parseCommaList(this.plugin.settings.onlyInclude).length > 0;
	}

	getSettingDefinitions(): SettingDefinitionItem<keyof PropertyPorterSettings>[] {
		const propertyNames = collectVaultMetadata(this.app).properties.map(({ name }) => name);
		let excludeFieldset: HTMLFieldSetElement | null = null;

		const propertyPickerDefinition = (key: "onlyInclude" | "excludeKeys") => {
			const isIncludePicker = key === "onlyInclude";
			return {
				name: isIncludePicker ? "Only include" : "Exclude keys",
				desc: isIncludePicker
					? "Properties to copy (only for non-tag commands). Mutually exclusive with Exclude keys."
					: "Properties to ignore (only for non-tag commands). Disabled when Only include is populated.",
				render: (setting: Setting) => {
					let pickerHost: HTMLElement = setting.controlEl;
					let fieldset: HTMLFieldSetElement | null = null;
					if (!isIncludePicker) {
						fieldset = setting.controlEl.createEl("fieldset", {
							cls: "pp-property-picker-fieldset",
						});
						fieldset.disabled = this.isExcludeKeysDisabled();
						excludeFieldset = fieldset;
						pickerHost = fieldset;
					}

					const picker = new ValuePicker(this.app, pickerHost, {
						suggestions: propertyNames,
						value: parseCommaList(this.plugin.settings[key]),
						multiple: true,
						allowCreate: true,
						kind: "property",
						classPrefix: "pp",
						placeholder: isIncludePicker
							? "Add properties to include…"
							: "Add properties to exclude…",
						ariaLabel: isIncludePicker
							? "Only include properties"
							: "Exclude properties",
						onChange: (values) => {
							this.plugin.settings[key] = values.join(", ");
							if (isIncludePicker && excludeFieldset) {
								excludeFieldset.disabled = this.isExcludeKeysDisabled();
							}
							void this.plugin.saveSettings();
						},
					});

					return () => {
						picker.destroy();
						fieldset?.remove();
					};
				},
			};
		};

		return [
			{
				type: "group",
				heading: "Property filters (non-tag commands)",
				items: [
					propertyPickerDefinition("onlyInclude"),
					propertyPickerDefinition("excludeKeys"),
				],
			},
			{
				type: "group",
				heading: "Paste behavior",
				items: [
					{
						name: "Paste mode",
						desc: "How copied properties merge into the destination note.",
						control: {
							type: "dropdown",
							key: "pasteMode" satisfies keyof PropertyPorterSettings,
							options: {
								overwrite: "Overwrite",
								skip: "Skip existing",
								merge: "Merge",
							},
						},
					},
				],
			},
		];
	}
}
