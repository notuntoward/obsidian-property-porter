import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, SuggestModal } from "obsidian";
import {
	filterFrontmatter,
	mergeFrontmatter,
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
			id: "clear-clipboard",
			name: "Clear clipboard",
			callback: () => this.clearClipboard(),
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

	updateStatusBar(): void {
		const count = Object.keys(this.clipboard).length;
		this.statusBarItem.setText(count > 0 ? `PP: ${count}` : "");
	}

	getActiveFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	getParsedFrontmatter(file: TFile): Record<string, unknown> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) return {};
		
		const fm = { ...cache.frontmatter };
		// Obsidian injects a positional cache object; we don't want to copy/paste it
		delete fm.position; 
		return fm;
	}

	getFilteredSourceFrontmatter(): Record<string, unknown> | null {
		const active = this.getActiveFile();
		if (!active) {
			new Notice("Property Porter: No active file");
			return null;
		}

		const fm = this.getParsedFrontmatter(active);
		return filterFrontmatter(
			fm,
			this.settings.onlyInclude,
			this.settings.excludeKeys
		);
	}

	async copyProperties(): Promise<void> {
		const fm = this.getFilteredSourceFrontmatter();
		if (!fm) return;
		this.clipboard = fm;
		this.updateStatusBar();
		new Notice(
			`Property Porter: ${Object.keys(this.clipboard).length} properties copied`
		);
	}

	clearClipboard(): void {
		this.clipboard = {};
		this.updateStatusBar();
	}

	async pasteProperties(targetFile?: TFile | null): Promise<void> {
		if (Object.keys(this.clipboard).length === 0) {
			new Notice("Property Porter: Clipboard is empty");
			return;
		}

		const file = targetFile ?? await this.pickTargetFile();
		if (!file) return;

		// Use Obsidian's native fileManager to safely read/write frontmatter
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const existingFm = { ...frontmatter };
			delete existingFm.position;

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

export class SuggestFilesModal extends SuggestModal<TFile> {
	constructor(app: App, private readonly files: TFile[], private readonly onSelect: (file: TFile) => void) {
		super(app);
	}

	getSuggestions(query: string): TFile[] {
		const q = query.toLowerCase();
		return this.files.filter((f) => f.path.toLowerCase().includes(q));
	}

	renderSuggestion(file: TFile, el: HTMLElement): void {
		el.createEl("div", { text: file.basename });
		el.createEl("small", { text: file.path });
	}

	onChooseSuggestion(file: TFile): void {
		this.onSelect(file);
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