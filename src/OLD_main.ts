import { App, Plugin, PluginSettingTab, Setting, TFile, Notice, SuggestModal } from "obsidian";

interface PropertyPorterSettings {
	onlyInclude: string;
	excludeKeys: string;
	pasteMode: "overwrite" | "skip" | "merge";
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
		return cache?.frontmatter ? { ...cache.frontmatter } : {};
	}

	hasFrontmatter(raw: string): boolean {
		return /^---\r?\n/.test(raw);
	}

	extractBody(raw: string): string {
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
		return match ? match[2] : raw;
	}

	getFilteredSourceFrontmatter(): Promise<Record<string, unknown> | null> {
		const active = this.getActiveFile();
		if (!active) {
			new Notice("Property Porter: No active file");
			return Promise.resolve(null);
		}

		const fm = this.getParsedFrontmatter(active);

		const onlyInclude = this.settings.onlyInclude
			.split(",")
			.map((s) => s.trim())
			.filter(Boolean);

		let result: Record<string, unknown> = {};

		if (onlyInclude.length > 0) {
			for (const key of onlyInclude) {
				if (key in fm) result[key] = fm[key];
			}
		} else {
			const exclude = this.settings.excludeKeys
				.split(",")
				.map((s) => s.trim().toLowerCase())
				.filter(Boolean);
			result = { ...fm };
			for (const key of Object.keys(result)) {
				if (exclude.includes(key.toLowerCase())) delete result[key];
			}
		}

		return Promise.resolve(result);
	}


	stringifyFrontmatter(fm: Record<string, unknown>): string {
		const lines: string[] = ["---"];
		for (const [key, value] of Object.entries(fm)) {
			lines.push(`${key}: ${this.serializeValue(value)}`);
		}
		lines.push("---");
		return lines.join("\n");
	}

	serializeValue(value: unknown): string {
		if (value === null || value === undefined) return "";
		if (Array.isArray(value)) {
			const items = value.map((v) => this.serializeScalar(v)).join(", ");
			return `[${items}]`;
		}
		if (typeof value === "object") {
			const inner = Object.entries(value as Record<string, unknown>)
				.map(([k, v]) => `${k}: ${this.serializeScalar(v)}`)
				.join(", ");
			return `{ ${inner} }`;
		}
		return this.serializeScalar(value);
	}

	serializeScalar(value: unknown): string {
		if (typeof value === "string") {
			if (
				/[:\{\}\[\],#&\*!\|>'"%@`\n]/.test(value) ||
				value.includes(" ") ||
				value === ""
			) {
				return `"${value.replace(/"/g, '\\"')}"`;
			}
			return value;
		}
		if (typeof value === "number" || typeof value === "boolean") return String(value);
		if (value === null) return "null";
		return String(value);
	}

	async getFileContent(file: TFile): Promise<string> {
		return this.app.vault.cachedRead(file);
	}

	copyProperties(): void {
		const fmPromise = this.getFilteredSourceFrontmatter();
		fmPromise.then((fm) => {
			if (!fm) return;
			this.clipboard = fm;
			this.updateStatusBar();
			new Notice(
				`Porter clipboard: ${Object.keys(this.clipboard).length} properties copied`
			);
		});
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

		let file = targetFile;
		if (!file) {
			file = await this.pickTargetFile();
		}
		if (!file) return;

		const raw = await this.getFileContent(file);
		const existingFm = this.getParsedFrontmatter(file);
		const hasExisting = this.hasFrontmatter(raw);
		const body = this.extractBody(raw);

		const merged = this.mergeFrontmatter(this.clipboard, existingFm);

		const fmLines: string[] = [];
		for (const [key, value] of Object.entries(merged)) {
			if (Array.isArray(value)) {
				fmLines.push(`${key}:`);
				for (const item of value) {
					fmLines.push(`  - ${this.serializeScalar(item)}`);
				}
			} else {
				fmLines.push(`${key}: ${this.serializeValue(value)}`);
			}
		}
		const fmContent = fmLines.join("\n");

		const newContent = hasExisting
			? `---\n${fmContent}\n---\n${body}`
			: `---\n${fmContent}\n---\n\n${raw}`;

		await this.app.vault.process(file, () => newContent);
		new Notice(
			`Property Porter: Pasted ${Object.keys(merged).length} properties into ${file.basename}`
		);

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
		const mode = this.settings.pasteMode;
		const result: Record<string, unknown> = { ...destination };

		for (const key of Object.keys(source)) {
			if (mode === "skip" && key in destination) continue;

			if (mode === "merge") {
				result[key] = this.deepMerge(source[key], destination[key]);
			} else {
				result[key] = source[key];
			}
		}

		return result;
	}

	deepMerge(source: unknown, destination: unknown): unknown {
		if (
			source === null ||
			source === undefined ||
			source === "" ||
			(Array.isArray(source) && (source as unknown[]).length === 0)
		) {
			return destination;
		}
		if (
			destination === null ||
			destination === undefined ||
			destination === "" ||
			(Array.isArray(destination) && (destination as unknown[]).length === 0)
		) {
			return source;
		}

		const sourceArray = Array.isArray(source);
		const destArray = Array.isArray(destination);

		if (sourceArray && destArray) {
			return this.mergeArrays(
				source as unknown[],
				destination as unknown[]
			);
		}
		if (sourceArray || destArray) {
			return source;
		}
		if (typeof source === "object" && typeof destination === "object") {
			const destObj = destination as Record<string, unknown>;
			const sourceObj = source as Record<string, unknown>;
			const out: Record<string, unknown> = { ...destObj };
			for (const key of Object.keys(sourceObj)) {
				if (key in destObj) {
					out[key] = this.deepMerge(sourceObj[key], destObj[key]);
				} else {
					out[key] = sourceObj[key];
				}
			}
			return out;
		}
		return source;
	}

	mergeArrays(source: unknown[], destination: unknown[]): unknown[] {
		const seen = new Set(destination.map((v) => JSON.stringify(v)));
		const result = [...destination];
		for (const item of source) {
			const key = JSON.stringify(item);
			if (!seen.has(key)) {
				result.push(item);
				seen.add(key);
			}
		}
		return result;
	}
}

class SuggestFilesModal extends SuggestModal<TFile> {
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

class PropertyPorterSettingTab extends PluginSettingTab {
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
