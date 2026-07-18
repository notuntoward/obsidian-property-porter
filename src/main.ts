import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	Notice,
	FuzzySuggestModal,
	Modal,
	FileView,
	WorkspaceTabs,
	getAllTags,
} from "obsidian";
import {
	filterFrontmatter,
	mergeFrontmatter,
	unionFrontmatter,
	isEmptyPropertyValue,
	countPropertyValue,
	parseCommaList,
	stripHashTag,
	type PasteMode,
} from "./frontmatter";

interface PropertyPorterSettings {
	onlyInclude: string;
	excludeKeys: string;
	pasteMode: PasteMode;
	autoClear: boolean;
}

const DEFAULT_SETTINGS: PropertyPorterSettings = {
	onlyInclude: "tags",
	excludeKeys: "aliases, created date, modified date",
	pasteMode: "merge",
	autoClear: false,
};

// Obsidian injects a positional cache object (`position`) into frontmatter
// read from metadataCache/processFrontMatter; strip it before copy/paste so
// we never write it back and corrupt the destination file's internal
// tracking data.
function stripPosition(
	fm: Record<string, unknown>
): Record<string, unknown> {
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
			name: "Clear properties",
			callback: () => this.clearClipboard(),
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
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
		return filterFrontmatter(
			fm,
			this.settings.onlyInclude,
			this.settings.excludeKeys
		);
	}

	// Copies the given frontmatter onto the clipboard, refreshes the status
	// bar, and reports how many values were copied. Shared by every copy
	// command so the clipboard-selection rule stays in one place.
	applyClipboard(fm: Record<string, unknown>): void {
		this.clipboard = fm;
		this.updateStatusBar();
		const count = this.countClipboardValues();
		new Notice(
			`Property Porter: ${count} propert${count === 1 ? "y" : "ies"} copied`
		);
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
		return Object.values(this.clipboard).some(
			(value) => !isEmptyPropertyValue(value)
		);
	}

	async pasteProperties(targetFile?: TFile | null): Promise<void> {
		if (!this.hasClipboardContent()) {
			new Notice("Property Porter: Clipboard is empty");
			return;
		}

		const file = targetFile ?? await this.pickTargetFile();
		if (!file) return;

		// Use Obsidian's native fileManager to safely read/write frontmatter
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const existingFm = stripPosition(frontmatter);
			const merged = this.mergeFrontmatter(this.clipboard, existingFm);

			// Apply the merged properties back onto the mutated object
			for (const [key, value] of Object.entries(merged)) {
				frontmatter[key] = value;
			}
		});

		new Notice(`Property Porter: Pasted properties into ${file.basename}`);

		if (this.settings.autoClear) {
			this.clearClipboard();
		}
	}

	async pasteIntoActive(): Promise<void> {
		const active = this.getActiveFile();
		if (!active) {
			new Notice("Property Porter: No active file");
			return;
		}
		await this.pasteProperties(active);
	}

	// Returns the markdown files open in the same tab group (stack of tabs)
	// as the active leaf. Resolves the active leaf's parent `WorkspaceTabs`
	// and collects every leaf in that group whose view is a `FileView`,
	// matching how Obsidian groups tabs. Falls back to the active window's
	// root for pop-out windows where the parent isn't a `WorkspaceTabs`.
	getActiveTabGroupFiles(): TFile[] {
		const activeLeaf = this.app.workspace.activeLeaf;
		if (!activeLeaf) return [];

		const files: TFile[] = [];
		const seen = new Set<string>();

		const activeParent = activeLeaf.parent;
		if (activeParent instanceof WorkspaceTabs) {
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.parent !== activeParent) return;
				if (!(leaf.view instanceof FileView)) return;
				const file = leaf.view.file;
				if (file && !seen.has(file.path)) {
					seen.add(file.path);
					files.push(file);
				}
			});
		} else {
			const activeWindowRoot = activeLeaf.getRoot();
			this.app.workspace.iterateAllLeaves((leaf) => {
				if (leaf.getRoot() !== activeWindowRoot) return;
				if (!(leaf.view instanceof FileView)) return;
				const file = leaf.view.file;
				if (file && !seen.has(file.path)) {
					seen.add(file.path);
					files.push(file);
				}
			});
		}
		return files;
	}

	async pasteIntoActiveTabGroup(): Promise<void> {
		if (!this.hasClipboardContent()) {
			new Notice("Property Porter: Clipboard is empty");
			return;
		}

		const files = this.getActiveTabGroupFiles();
		if (files.length === 0) {
			new Notice("Property Porter: No markdown files in the active tab group");
			return;
		}

		for (const file of files) {
			await this.pasteProperties(file);
		}
		new Notice(
			`Property Porter: Pasted properties into ${files.length} note${
				files.length === 1 ? "" : "s"
			}`
		);

		if (this.settings.autoClear) {
			this.clearClipboard();
		}
	}

	async pickTargetFile(): Promise<TFile | null> {
		return new Promise((resolve) => {
			const files = this.app.vault.getMarkdownFiles().filter(
				(f) => f !== this.getActiveFile()
			);
			if (files.length === 0) {
				new Notice("Property Porter: No other markdown files found");
				resolve(null);
				return;
			}

			new SuggestFilesModal(this.app, files, (file) => {
				resolve(file);
			}).open();
		});
	}

	getKnownTagsForPicking(): string[] {
		// Delegate to Obsidian's own tag extraction (getAllTags) instead of
		// re-parsing frontmatter.tags by hand: it already covers the
		// `tags`/`tag` frontmatter key aliases, both array and
		// comma-separated string forms, and inline #tags in the note body.
		const seen = new Set<string>();
		const files = this.app.vault.getMarkdownFiles();
		for (const file of files) {
			const cache = this.app.metadataCache.getFileCache(file);
			if (!cache) continue;
			const tags = getAllTags(cache);
			if (!tags) continue;
			for (const tag of tags) {
				const trimmed = stripHashTag(tag);
				if (trimmed.length > 0) seen.add(trimmed);
			}
		}
		return Array.from(seen).sort((a, b) =>
			a.toLowerCase().localeCompare(b.toLowerCase())
		);
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
		const onlyList = parseCommaList(this.settings.onlyInclude);
		const isTagsOnly =
			onlyList.length === 1 && onlyList[0].toLowerCase() === "tags";

		if (!isTagsOnly) {
			new Notice(
				"Property Porter: 'Select tags to paste' requires 'Only include' to be exactly 'tags' in settings"
			);
			return;
		}

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
				(selectedItems) =>
					resolve({ items: selectedItems, cancelled: false }),
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
			new Notice("Property Porter: No tags selected. Cleared tags from clipboard.");
			return;
		}
		new Notice(
			`Property Porter: ${selected.length} tag${
				selected.length === 1 ? "" : "s"
			} ready to paste`
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

export class SuggestFilesModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private readonly files: TFile[], private readonly onSelect: (file: TFile) => void) {
		super(app);
	}

	getItems(): TFile[] {
		return this.files;
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onSelect(file);
	}
}

export class MultiSelectSuggestModal extends Modal {
	private readonly selected: string[] = [];
	private submitted = false;
	private query = "";
	private activeIndex = 0;
	private filtered: string[] = [];

	private chipsContainerEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private listEl: HTMLElement | null = null;
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
		for (const value of initialSelected) {
			if (!this.selected.includes(value)) this.selected.push(value);
		}
	}

	getSelectedValues(): string[] {
		return [...this.selected];
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pp-multi-select-modal");

		this.chipsContainerEl = contentEl.createDiv({
			cls: "pp-selected-chips-container",
		});

		this.inputEl = contentEl.createEl("input", {
			type: "text",
			cls: "pp-multi-select-input",
		});
		this.inputEl.placeholder =
			"Type to filter, Enter to add, Enter again to finish";

		this.inputEl.addEventListener("input", () => {
			this.query = this.inputEl?.value ?? "";
			this.activeIndex = 0;
			this.renderList();
		});
		this.inputEl.addEventListener("keydown", (e) => this.handleKeydown(e));

		const controlsEl = contentEl.createDiv({
			cls: "pp-multi-select-controls",
		});
		this.hintEl = controlsEl.createDiv({ cls: "pp-multi-select-hint" });
		const buttonsEl = controlsEl.createDiv({
			cls: "pp-multi-select-buttons",
		});
		this.clearAllButton = buttonsEl.createEl("button", {
			text: "Clear all",
			cls: "pp-clear-all-button",
		});
		this.clearAllButton.addEventListener("click", () => this.clearAll());
		this.doneButton = buttonsEl.createEl("button", {
			text: "Finish selection (0)",
			cls: ["mod-cta", "pp-finish-button"],
		});
		this.doneButton.addEventListener("click", () => this.submit());

		this.listEl = contentEl.createDiv({ cls: "pp-multi-select-list" });

		this.renderChips();
		this.renderList();
		this.updateHint();

		window.setTimeout(() => this.inputEl?.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.submitted) this.onCancel();
	}

	private getFiltered(query: string): string[] {
		const q = query.trim().toLowerCase();
		const pool = this.values.filter((v) => !this.selected.includes(v));
		if (q === "") return pool.slice(0, 100);

		const ranked: { value: string; rank: number }[] = [];
		for (const value of pool) {
			const lower = value.toLowerCase();
			let rank: number;
			if (lower === q) rank = 0;
			else if (lower.startsWith(q)) rank = 1;
			else if (lower.includes(q)) rank = 2;
			else continue;
			ranked.push({ value, rank });
		}
		ranked.sort((a, b) => {
			if (a.rank !== b.rank) return a.rank - b.rank;
			return a.value.toLowerCase().localeCompare(b.value.toLowerCase());
		});
		return ranked.map((r) => r.value).slice(0, 100);
	}

	private renderList(): void {
		if (!this.listEl) return;
		this.filtered = this.getFiltered(this.query);
		if (this.activeIndex >= this.filtered.length) {
			this.activeIndex = Math.max(0, this.filtered.length - 1);
		}
		this.listEl.empty();
		this.filtered.forEach((value, index) => {
			const item = this.listEl!.createDiv({
				cls: "pp-multi-select-item",
			});
			if (index === this.activeIndex) item.addClass("is-active");
			item.createSpan({ text: `${this.prefix}${value}` });
			item.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.addValue(value);
			});
			item.addEventListener("mouseenter", () => {
				if (this.activeIndex === index) return;
				this.activeIndex = index;
				this.renderList();
			});
		});

		// When the query doesn't match any known tag, surface a row that lets
		// the user create the tag verbatim. Enter already adds the typed text
		// in this case; this makes the affordance visible.
		const typed = this.query.trim();
		if (typed !== "" && this.filtered.length === 0) {
			const createItem = this.listEl.createDiv({
				cls: "pp-multi-select-item pp-create-item",
			});
			createItem.createSpan({
				text: `Create new tag: ${this.prefix}${typed}`,
			});
			createItem.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.addValue(typed);
			});
		}
	}

	private handleKeydown(e: KeyboardEvent): void {
		if (e.key === "ArrowDown") {
			e.preventDefault();
			if (this.filtered.length > 0) {
				this.activeIndex = Math.min(
					this.activeIndex + 1,
					this.filtered.length - 1
				);
				this.renderList();
			}
			return;
		}
		if (e.key === "ArrowUp") {
			e.preventDefault();
			if (this.filtered.length > 0) {
				this.activeIndex = Math.max(this.activeIndex - 1, 0);
				this.renderList();
			}
			return;
		}
		if (e.key === "Enter") {
			e.preventDefault();
			const typed = (this.inputEl?.value ?? "").trim();
			if (typed === "") {
				if (this.selected.length > 0) this.submit();
				return;
			}
			// When the typed text matches a suggestion, prefer the exact
			// (properly-cased) value; otherwise add the tag verbatim so users
			// can enter tags that don't yet exist anywhere in the vault.
			if (this.filtered.length > 0) {
				this.addValue(this.filtered[this.activeIndex]);
			} else {
				this.addValue(typed);
			}
			return;
		}
		if (
			e.key === "Backspace" &&
			(this.inputEl?.value ?? "") === "" &&
			this.selected.length > 0
		) {
			e.preventDefault();
			if (e.ctrlKey || e.metaKey) {
				this.clearAll();
			} else {
				this.removeValue(this.selected[this.selected.length - 1]);
			}
			return;
		}
	}

	private addValue(value: string): void {
		if (!this.selected.includes(value)) {
			this.selected.push(value);
		}
		this.query = "";
		if (this.inputEl) this.inputEl.value = "";
		this.activeIndex = 0;
		this.refreshSelectionUI();
		this.inputEl?.focus();
	}

	private removeValue(value: string): void {
		const idx = this.selected.indexOf(value);
		if (idx >= 0) this.selected.splice(idx, 1);
		this.refreshSelectionUI();
	}

	private clearAll(): void {
		if (this.selected.length === 0) return;
		this.selected.length = 0;
		this.refreshSelectionUI();
		this.inputEl?.focus();
	}

	// Every mutation of `selected` (add/remove/clear) needs the same three
	// views kept in sync: the chip strip, the suggestion list (which
	// excludes already-selected values), and the hint/button labels.
	private refreshSelectionUI(): void {
		this.renderChips();
		this.renderList();
		this.updateHint();
	}

	private renderChips(): void {
		if (!this.chipsContainerEl) return;
		this.chipsContainerEl.empty();
		if (this.selected.length === 0) {
			this.chipsContainerEl.style.display = "none";
			return;
		}
		this.chipsContainerEl.style.display = "flex";
		const label = this.chipsContainerEl.createDiv({
			cls: "pp-selected-chips-label",
		});
		label.setText(`${this.selected.length} selected:`);
		for (const value of this.selected) {
			const chip = this.chipsContainerEl.createDiv({
				cls: "pp-selected-chip",
			});
			chip.createSpan({ text: this.prefix + value });
			const removeBtn = chip.createSpan({
				cls: "pp-selected-chip-remove",
				text: "×",
			});
			removeBtn.addEventListener("click", (e) => {
				e.stopPropagation();
				this.removeValue(value);
			});
		}
	}

	private updateHint(): void {
		if (this.hintEl) {
			const selectedText =
				this.selected.length === 0
					? "Type to filter, click or press Enter to add a tag."
					: "Press Enter on an empty box, or click Finish selection, when done. Backspace removes the last tag; Ctrl/Cmd+Backspace clears all.";
			this.hintEl.setText(selectedText);
		}
		if (this.doneButton) {
			this.doneButton.setText(
				`Finish selection (${this.selected.length})`
			);
		}
		if (this.clearAllButton) {
			this.clearAllButton.disabled = this.selected.length === 0;
		}
	}

	private submit(): void {
		this.submitted = true;
		this.onSubmit(this.getSelectedValues());
		this.close();
	}
}

export class PropertyPorterSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: PropertyPorter) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Only include")
			.setDesc(
				"Comma-separated list of properties to copy. Mutually exclusive with Exclude keys."
			)
			.addText((text) => {
				text
					.setPlaceholder("tags, status")
					.setValue(this.plugin.settings.onlyInclude)
					.onChange(async (value) => {
						this.plugin.settings.onlyInclude = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Exclude keys")
			.setDesc(
				"Comma-separated list of properties to ignore. Disabled when Only include is populated."
			)
			.addText((text) => {
				text
					.setPlaceholder("aliases, created date, modified date")
					.setValue(this.plugin.settings.excludeKeys)
					.setDisabled(this.plugin.settings.onlyInclude.trim().length > 0)
					.onChange(async (value) => {
						this.plugin.settings.excludeKeys = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Paste mode")
			.setDesc("How copied properties merge into the destination note.")
			.addDropdown((dropdown) => {
				dropdown
					.addOption("overwrite", "Overwrite")
					.addOption("skip", "Skip existing")
					.addOption("merge", "Merge")
					.setValue(this.plugin.settings.pasteMode)
					.onChange(async (value: PropertyPorterSettings["pasteMode"]) => {
						this.plugin.settings.pasteMode = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto-clear clipboard after successful paste")
			.setDesc("Automatically clear copied properties after pasting.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.autoClear)
					.onChange(async (value) => {
						this.plugin.settings.autoClear = value;
						await this.plugin.saveSettings();
					});
			});
	}
}