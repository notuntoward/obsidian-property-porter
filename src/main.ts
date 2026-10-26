import {
	App,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	Notice,
	Modal,
	FileView,
	type Menu,
	WorkspaceLeaf,
	parseYaml,
	type SettingDefinitionItem,
} from "obsidian";
import {
	filterFrontmatter,
	mergeFrontmatter,
	mergeArrays,
	unionFrontmatter,
	isEmptyPropertyValue,
	countPropertyValue,
	parseCommaList,
	findOverlappingPropertyFilters,
	removeOverlappingExcludedProperties,
	parseRawFrontmatter,
	getFrontmatterLines,
	applyDuplicateResolution,
	formatRawValue,
	findPasteChanges,
	type PasteChange,
	type PasteMode,
	type DuplicateResolution,
} from "./frontmatter";
import {
	buildNavigationModel,
	getGroupForLeaf,
	getLeafFileKey,
	type NavigationModel,
} from "commons/workspace";
import {
	collectVaultMetadata,
	propertyNamePickerOptions,
	isListProperty,
	ValuePicker,
	collectValueSources,
	setDeclaredPropertyWidget,
	mergeValueSources,
	mergeValueSourcesByMaximumCount,
	type FrontmatterValueSources,
} from "commons/properties";
import { FileSuggestModal } from "commons/modal";
import {
	SelectPropertiesModal,
	type ConflictCardContext,
	type SelectPropertiesModalOptions,
} from "./select-properties-modal";

export class SourceRepairPermissionModal extends Modal {
	private answered = false;

	constructor(app: App, private readonly files: TFile[], private readonly answer: (allow: boolean) => void) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("pp-modal");
		this.titleEl.setText(
			this.files.length === 1
				? "Repair duplicate properties in source note?"
				: "Repair duplicate properties in source notes?"
		);
		this.contentEl.createEl("p", {
			text: "Your chosen values will be copied either way. Allow Property Porter to rewrite these source notes, keeping only your chosen occurrences? Properties you skipped are left as they are.",
		});
		const list = this.contentEl.createEl("ul");
		for (const file of this.files) list.createEl("li", { text: file.path });
		this.contentEl.createEl("p", { text: "Press Esc to copy without repairing." });
		const repairLabel = this.files.length === 1 ? "Repair note and copy" : "Repair notes and copy";
		const buttonsEl = this.contentEl.createDiv({ cls: "pp-modal-buttons" });
		const repairButton = buttonsEl.createEl("button", {
			text: repairLabel,
			cls: "mod-cta",
			type: "button",
		});
		repairButton.addEventListener("click", () => this.finish(true));
		const copyButton = buttonsEl.createEl("button", {
			text: "Copy only",
			type: "button",
		});
		copyButton.addEventListener("click", () => this.finish(false));
		this.contentEl.addEventListener("keydown", this.handleButtonNavigation);
		repairButton.focus();
	}

	private readonly handleButtonNavigation = (event: KeyboardEvent): void => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		const target = event.target;
		if (!(target instanceof HTMLElement)) return;
		const currentButton = target.closest<HTMLButtonElement>("button");
		const buttons = Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>(".pp-modal-buttons button"));
		const currentIndex = currentButton ? buttons.indexOf(currentButton) : -1;
		if (currentIndex < 0 || buttons.length < 2) return;
		const nextIndex =
			event.key === "ArrowRight"
				? (currentIndex + 1) % buttons.length
				: (currentIndex + buttons.length - 1) % buttons.length;
		buttons[nextIndex]!.focus();
		event.preventDefault();
	};

	private finish(allow: boolean): void {
		this.answered = true;
		this.answer(allow);
		this.close();
	}

	onClose(): void {
		this.contentEl.removeEventListener("keydown", this.handleButtonNavigation);
		if (!this.answered) this.answer(false);
		this.contentEl.empty();
	}
}

export interface NotePasteChanges {
	note: string;
	changes: PasteChange[];
}

// Asks before an Overwrite or Skip paste changes or ignores existing values.
// Esc or closing the dialog cancels, so nothing is written.
export class PasteChangesConfirmModal extends Modal {
	private answered = false;

	constructor(
		app: App,
		private readonly mode: "overwrite" | "skip",
		private readonly notes: NotePasteChanges[],
		private readonly answer: (confirmed: boolean) => void
	) {
		super(app);
	}

	onOpen(): void {
		const overwrite = this.mode === "overwrite";
		this.modalEl.addClass("pp-modal");
		this.titleEl.setText(overwrite ? "Overwrite existing properties?" : "Skip existing properties?");
		this.contentEl.createEl("p", {
			text: overwrite
				? "These properties already have a different value and will be replaced."
				: "These properties already have a different value and will be left as they are.",
		});
		const listEl = this.contentEl.createDiv({ cls: "pp-paste-changes" });
		for (const { note, changes } of this.notes) {
			listEl.createDiv({ cls: "pp-paste-changes-note", text: note });
			const list = listEl.createEl("ul");
			for (const { key, from, to } of changes) {
				list.createEl("li", {
					text: overwrite ? `${key}: ${from} → ${to}` : `${key}: keeping ${from}, not pasting ${to}`,
				});
			}
		}
		const buttonsEl = this.contentEl.createDiv({ cls: "pp-modal-buttons" });
		const cancelButton = buttonsEl.createEl("button", { text: "Cancel", type: "button" });
		cancelButton.addEventListener("click", () => this.finish(false));
		const pasteButton = buttonsEl.createEl("button", { text: "Paste", cls: "mod-cta", type: "button" });
		pasteButton.addEventListener("click", () => this.finish(true));
		pasteButton.focus();
	}

	private finish(confirmed: boolean): void {
		this.answered = true;
		this.answer(confirmed);
		this.close();
	}

	onClose(): void {
		if (!this.answered) this.answer(false);
		this.contentEl.empty();
	}
}

interface PropertyPorterSettings {
	onlyInclude: string;
	excludeKeys: string;
	pasteMode: PasteMode;
	confirmOverwrite: boolean;
	confirmSkip: boolean;
}

type FilterOverride = { include: string[]; exclude: string[] };
type ClipboardKind = "properties" | "tags";

const DEFAULT_SETTINGS: PropertyPorterSettings = {
	onlyInclude: "tags",
	excludeKeys: "aliases, created date, modified date",
	pasteMode: "merge",
	confirmOverwrite: true,
	confirmSkip: true,
};

const TAGS_FILTER_OVERRIDE: FilterOverride = { include: ["tags"], exclude: [] };

export const NOTICE_TIMEOUT_MS = 7000;
export const NOTICE_NO_PROPERTIES_TO_PASTE =
	'Property Porter: No properties copied. Use "Copy properties" (not system clipboard).';
export const NOTICE_CLEARED_COPIED_PROPERTIES = "Property Porter: No properties selected. Cleared copied properties.";

function selectedClipboardEntries(payload: Record<string, unknown>): Array<[string, unknown]> {
	return Object.entries(payload).filter(([, value]) => !isEmptyPropertyValue(value));
}

function clipboardDescription(payload: Record<string, unknown>): string {
	const entries = selectedClipboardEntries(payload);
	const valueCount = entries.reduce((count, [, value]) => count + countPropertyValue(value), 0);
	if (entries.length === 1 && ["tag", "tags"].includes(entries[0][0].toLowerCase())) {
		return `${valueCount} tag${valueCount === 1 ? "" : "s"}`;
	}
	return `${entries.length} propert${entries.length === 1 ? "y" : "ies"} (${valueCount} value${
		valueCount === 1 ? "" : "s"
	})`;
}

function pastedClipboardNotice(payload: Record<string, unknown>, destinations: readonly string[]): string {
	const entries = selectedClipboardEntries(payload);
	if (entries.length === 0) return "Property Porter: Nothing pasted; no property values were selected.";
	const destination = destinations.length === 1 ? destinations[0] : `${destinations.length} notes`;
	return `Property Porter: Pasted ${clipboardDescription(payload)} into ${destination}`;
}

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
	/** Name of the note (or notes) the clipboard was copied from, so paste
	 * conflicts can say where the clipboard value came from. */
	clipboardOrigin: string | null = null;
	clipboardKind: ClipboardKind = "properties";
	/** Property types the user picked for new properties; applied on paste. */
	private clipboardTypes: Record<string, string> = {};
	private clipboardValueSources: FrontmatterValueSources = {};
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
			id: "edit-property-clipboard",
			name: "Edit property clipboard",
			callback: () => this.editPropertyClipboard(),
		});

		this.addCommand({
			id: "copy-tags-active-note",
			name: "Copy tags from active note",
			callback: () => this.copyProperties(TAGS_FILTER_OVERRIDE),
		});

		this.addCommand({
			id: "copy-tags-tab-group",
			name: "Copy tags from the active tab group",
			callback: () => this.copyPropertiesFromActiveTabGroup(TAGS_FILTER_OVERRIDE),
		});

		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md") return;
				this.addTagMenuItems(menu, [file]);
			})
		);

		this.registerEvent(
			this.app.workspace.on("files-menu", (menu, files) => {
				const markdownFiles = files.filter(
					(file): file is TFile =>
						file instanceof TFile && file.extension.toLowerCase() === "md"
				);
				if (markdownFiles.length === 0) return;
				this.addTagMenuItems(menu, markdownFiles);
			})
		);

		this.addSettingTab(new PropertyPorterSettingTab(this.app, this));
	}

	onunload(): void {
		this.clipboard = {};
		this.clipboardKind = "properties";
		this.updateStatusBar();
	}

	async loadSettings(): Promise<void> {
		// `autoClear` was removed: paste never clears; copy always replaces.
		const { autoClear: _legacyAutoClear, ...stored } =
			((await this.loadData()) ?? {}) as Partial<PropertyPorterSettings> & { autoClear?: unknown };
		this.settings = Object.assign({}, DEFAULT_SETTINGS, stored);
		const repairedFilters = removeOverlappingExcludedProperties(
			this.settings.onlyInclude,
			this.settings.excludeKeys
		);
		if (repairedFilters.removed.length > 0) {
			this.settings.excludeKeys = repairedFilters.excludeKeys;
			new Notice(
				`Property Porter: removed excluded properties that also appear in Only include properties: ${repairedFilters.removed.join(", ")}.`
			);
			await this.saveData(this.settings);
		}
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
		const label = this.clipboardKind === "tags" ? " tags only" : "";
		this.statusBarItem.setText(count > 0 ? `PP: ${count}${label}` : "");
	}

	getActiveFile(): TFile | null {
		return this.app.workspace.getActiveFile();
	}

	getParsedFrontmatter(file: TFile): Record<string, unknown> {
		const cache = this.app.metadataCache.getFileCache(file);
		if (!cache?.frontmatter) return {};
		return stripPosition(cache.frontmatter);
	}

	private async getFreshParsedFrontmatter(file: TFile): Promise<Record<string, unknown>> {
		const content = await this.readRawFileContent(file);
		return this.parseFrontmatterContent(content, file);
	}

	getFilteredSourceFrontmatter(
		file?: TFile | null,
		filterOverride?: FilterOverride
	): Record<string, unknown> | null {
		const source = file ?? this.getActiveFile();
		if (!source) {
			new Notice("Property Porter: No active file");
			return null;
		}

		const fm = this.getParsedFrontmatter(source);
		return this.filterFrontmatter(fm, filterOverride);
	}

	// Copies the given frontmatter onto the clipboard, refreshes the status
	// bar, and reports how many values were copied. Shared by every copy
	// command so the clipboard-selection rule stays in one place.
	applyClipboard(
		fm: Record<string, unknown>,
		valueSources: FrontmatterValueSources = {},
		clipboardKind: ClipboardKind = "properties"
	): void {
		this.clipboard = fm;
		this.clipboardValueSources = valueSources;
		this.clipboardKind = clipboardKind;
		this.updateStatusBar();
		const count = this.countClipboardValues();
		if (clipboardKind === "tags") {
			new Notice(`Property Porter: Copied ${count} tag${count === 1 ? "" : "s"}`);
			return;
		}
		new Notice(`Property Porter: ${count} propert${count === 1 ? "y" : "ies"} copied`);
	}

	private filterFrontmatter(
		frontmatter: Record<string, unknown>,
		filterOverride?: FilterOverride
	): Record<string, unknown> {
		return filterFrontmatter(
			frontmatter,
			filterOverride?.include.join(", ") ?? this.settings.onlyInclude,
			filterOverride?.exclude.join(", ") ?? this.settings.excludeKeys
		);
	}

	private addTagMenuItems(menu: Menu, files: TFile[]): void {
		menu.addItem((item) =>
			item.setTitle("Copy tags").onClick(() => {
				return this.copyPropertiesFromFiles(files, TAGS_FILTER_OVERRIDE);
			})
		);
		menu.addItem((item) =>
			item.setTitle("Paste tags").onClick(() => {
				return this.pastePropertiesIntoFiles(files, TAGS_FILTER_OVERRIDE);
			})
		);
	}

	// Reads from the vault rather than metadataCache/cachedRead so commands see
	// frontmatter changes immediately, before Obsidian finishes re-indexing.
	private async readRawFileContent(file: TFile): Promise<string> {
		try {
			return await this.app.vault.read(file);
		} catch (error) {
			new Notice(`Property Porter: could not read ${file.basename} frontmatter (${String(error)})`);
			throw error;
		}
	}

	private parseFrontmatterContent(
		content: string,
		file: TFile,
		rawFrontmatter = parseRawFrontmatter(content)
	): Record<string, unknown> {
		const lines = getFrontmatterLines(content);
		if (lines.length === 0) return {};
		const closingLine = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
		if (closingLine === -1) return {};
		const duplicateLines = new Set<number>();
		for (const duplicate of rawFrontmatter.duplicates) {
			for (const [start, end] of duplicate.spans.slice(1)) {
				for (let line = start; line <= end; line++) duplicateLines.add(line);
			}
		}
		const yaml = lines
			.slice(1, closingLine)
			.filter((_, index) => !duplicateLines.has(index + 1))
			.join("\n");

		try {
			const parsed = parseYaml(yaml);
			if (parsed === null || parsed === undefined) return {};
			if (typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("Frontmatter must be a YAML mapping");
			}
			return stripPosition(parsed as Record<string, unknown>);
		} catch (error) {
			new Notice(`Property Porter: could not parse ${file.basename} frontmatter (${String(error)})`);
			throw error;
		}
	}

	// Detects within-note duplicate property keys in the given files and
	// resolves them through the conflict modal, one note at a time so each
	// note's duplicates keep their own resolution. Nothing is written here:
	// the rewrites are staged and returned as `commit`, which the caller must
	// only invoke once the whole operation has succeeded — canceling any
	// later dialog leaves every note untouched. Returns null when no note has
	// duplicates; `cancelled: true` means a dialog was dismissed, aborting the
	// operation with nothing written.
	private async resolveDuplicateKeys(
		files: TFile[],
		askBeforeRepair = false,
		filterOverride?: FilterOverride
	): Promise<{
		cancelled: boolean;
		/** Post-repair frontmatter per note that had duplicates. */
		fullByFile: Map<TFile, Record<string, unknown>>;
		/** User-selected values to include in clipboard copy operations. */
		selectedByFile: Map<TFile, Record<string, unknown>>;
		/** Applies the staged note rewrites. Call only on success. */
		commit: () => Promise<void>;
	}> {
		const staged: Array<{ file: TFile; content: string }> = [];
		const fullByFile = new Map<TFile, Record<string, unknown>>();
		const selectedByFile = new Map<TFile, Record<string, unknown>>();

		for (const file of files) {
			const content = await this.readRawFileContent(file);
			const parsed = parseRawFrontmatter(content);
			const freshFrontmatter = {
				...this.parseFrontmatterContent(content, file, parsed),
				...parsed.map,
			};
			fullByFile.set(file, freshFrontmatter);
			if (parsed.duplicates.length === 0) continue;

			const conflicts: Record<string, unknown[]> = {};
			const context: Record<string, ConflictCardContext> = {};
			const origins: Record<string, Array<{ display: string; value: unknown }>> = {};

			for (const dup of parsed.duplicates) {
				const displays = dup.values.map((value) => {
					const display = formatRawValue(value);
					const ambiguous = dup.values.some((other) =>
						formatRawValue(other) === display && JSON.stringify(other) !== JSON.stringify(value)
					);
					return ambiguous ? `${display} (${Array.isArray(value) ? "list" : typeof value})` : display;
				});
				const candidates = conflicts[dup.key] ?? [];
				origins[dup.key] = origins[dup.key] ?? [];
				const valueSources = context[dup.key]?.valueSources ?? {};
				for (let i = 0; i < displays.length; i++) {
					if (!candidates.includes(displays[i])) {
						candidates.push(displays[i]);
						origins[dup.key].push({ display: displays[i], value: dup.values[i] });
					}
				}
				const sourceValues = collectValueSources([
					{ note: file.basename, frontmatter: { [dup.key]: dup.values } },
				]);
				conflicts[dup.key] = candidates;
				context[dup.key] = {
					...context[dup.key],
					valueSources: mergeValueSources(valueSources, sourceValues),
				};
			}

			const copyCandidates = this.filterFrontmatter(freshFrontmatter, filterOverride);
			const initial = { ...(askBeforeRepair ? copyCandidates : {}), ...conflicts };
			const conflictNames = Object.keys(conflicts);
			const result = await this.openPropertySelectionModal(initial, context, {
				title: "Resolve property conflicts",
				conflictNames,
				finishText: "Continue",
			});
			if (result.cancelled) {
				return {
					cancelled: true,
					fullByFile: new Map(),
					selectedByFile: new Map(),
					commit: async () => {},
				};
			}
			const keep: Record<string, unknown> = {};
			Object.assign(this.clipboardTypes, result.propertyTypes);
			const skippedKeys: string[] = [];
			const decisions: DuplicateResolution[] = [];
			for (const key of Object.keys(conflicts)) {
				if (key in result.skipped || !(key in result.properties)) {
					// Skipped: left out of the copy; the note keeps its duplicates untouched.
					skippedKeys.push(key);
					continue;
				}
				const chosen = result.properties[key];
				const display = Array.isArray(chosen) ? chosen.join(", ") : String(chosen);
				const match = origins[key]?.find((origin) => origin.display === display);
				const value = match ? structuredClone(match.value) : display;
				keep[key] = value;
				decisions.push({ key, keep: value });
			}

			if (askBeforeRepair) {
				const selected = Object.fromEntries(
					Object.entries(result.properties).filter(([key]) => key in copyCandidates)
				);
				for (const key of Object.keys(conflicts)) {
					if (key in keep && key in copyCandidates) selected[key] = keep[key];
					else delete selected[key];
				}
				selectedByFile.set(file, selected);
			}

			if (decisions.length > 0) {
				staged.push({ file, content: applyDuplicateResolution(content, decisions) });
			}
			const full: Record<string, unknown> = { ...freshFrontmatter, ...keep };
			for (const key of skippedKeys) delete full[key];
			fullByFile.set(file, full);
		}

		const commit = async (): Promise<void> => {
			if (
				staged.length > 0 &&
				askBeforeRepair &&
				!(await this.confirmSourceRepair(staged.map(({ file }) => file)))
			)
				return;
			for (const { file, content } of staged) {
				await this.app.vault.modify(file, content);
			}
		};
		return { cancelled: false, fullByFile, selectedByFile, commit };
	}

	confirmSourceRepair(files: TFile[]): Promise<boolean> {
		return new Promise((resolve) => {
			new SourceRepairPermissionModal(this.app, files, resolve).open();
		});
	}

	async copyProperties(filterOverride?: FilterOverride): Promise<void> {
		const source = this.getActiveFile();
		if (!source) {
			new Notice("Property Porter: No active file");
			return;
		}
		const duplicates = await this.resolveDuplicateKeys([source], true, filterOverride);
		if (duplicates?.cancelled) return;
		const full = duplicates.fullByFile.get(source) ?? (await this.getFreshParsedFrontmatter(source));
		const filtered =
			duplicates.selectedByFile.get(source) ??
			this.filterFrontmatter(full, filterOverride);
		await duplicates.commit();
		this.clipboardOrigin = source.basename;
		this.applyClipboard(
			filtered,
			collectValueSources([{ note: source.basename, frontmatter: filtered }]),
			this.getClipboardKind(filterOverride)
		);
	}

	// Copies properties from a note the user picks via the same file selector
	// used by "Paste properties into another note", then applies the same
	// copy logic as `copyProperties`.
	async copyPropertiesFrom(filterOverride?: FilterOverride): Promise<void> {
		const file = await this.pickTargetFile();
		if (!file) return;
		const duplicates = await this.resolveDuplicateKeys([file], true, filterOverride);
		if (duplicates?.cancelled) return;
		const full = duplicates.fullByFile.get(file) ?? (await this.getFreshParsedFrontmatter(file));
		const filtered =
			duplicates.selectedByFile.get(file) ??
			this.filterFrontmatter(full, filterOverride);
		await duplicates.commit();
		this.clipboardOrigin = file.basename;
		this.applyClipboard(
			filtered,
			collectValueSources([{ note: file.basename, frontmatter: filtered }]),
			this.getClipboardKind(filterOverride)
		);
	}

	// Collects properties from every note in the active tab group, reusing the
	// same group resolution and per-note filtering as the other commands, then
	// unions them into a single clipboard payload (list properties accumulate
	// every distinct value across the notes).
	async copyPropertiesFromActiveTabGroup(filterOverride?: FilterOverride): Promise<void> {
		const files = this.getActiveTabGroupFiles();
		if (files.length === 0) {
			new Notice("Property Porter: No markdown files in the active tab group");
			return;
		}
		await this.copyPropertiesFromFiles(files, filterOverride);
	}

	async copyPropertiesFromFiles(files: TFile[], filterOverride?: FilterOverride): Promise<void> {
		const markdownFiles = this.uniqueMarkdownFiles(files);
		if (markdownFiles.length === 0) {
			new Notice("Property Porter: No markdown files selected");
			return;
		}

		const duplicates = await this.resolveDuplicateKeys(markdownFiles, true, filterOverride);
		if (duplicates?.cancelled) return; // leave every note and the clipboard untouched

		const fulls: Record<string, unknown>[] = [];
		for (const file of markdownFiles) {
			const full = duplicates.fullByFile.get(file);
			if (!full) throw new Error(`Missing frontmatter snapshot for ${file.path}`);
			fulls.push(full);
		}
		const collected = markdownFiles.map((file, index) =>
			duplicates.selectedByFile.get(file) ??
			this.filterFrontmatter(fulls[index], filterOverride)
		);
		const valueSources = collectValueSources(
			markdownFiles.map((file, index) => ({ note: file.basename, frontmatter: collected[index] }))
		);

		// Gather scalar collisions across the group and resolve them in one
		// place before anything reaches the clipboard. When no key conflicts,
		// the union is copied silently, as before.
		const union = unionFrontmatter(collected, { gatherConflicts: true });
		const conflicts = this.extractScalarConflicts(union);
		if (Object.keys(conflicts).length > 0) {
			const context = this.buildCrossNoteConflictContext(markdownFiles, fulls, conflicts, valueSources);
			const resolved = await this.resolveConflicts({ ...union }, conflicts, context);
			if (resolved === null) return; // cancelled: notes stay unrepaired, clipboard untouched
			await duplicates.commit();
			this.clipboardOrigin = markdownFiles.map((file) => file.basename).join(", ");
			this.applyClipboard(resolved, valueSources, this.getClipboardKind(filterOverride));
			return;
		}
		await duplicates.commit();
		this.clipboardOrigin = markdownFiles.map((file) => file.basename).join(", ");
		this.applyClipboard(union, valueSources, this.getClipboardKind(filterOverride));
	}

	private getClipboardKind(filterOverride?: FilterOverride): ClipboardKind {
		return filterOverride?.include.length === 1 &&
			filterOverride.include[0]?.trim().toLowerCase() === "tags" &&
			filterOverride.exclude.length === 0
			? "tags"
			: "properties";
	}

	private uniqueMarkdownFiles(files: TFile[]): TFile[] {
		const seen = new Set<string>();
		return files.filter((file) => {
			if (!(file instanceof TFile) || file.extension.toLowerCase() !== "md" || seen.has(file.path)) {
				return false;
			}
			seen.add(file.path);
			return true;
		});
	}

	clearClipboard(): void {
		this.clipboard = {};
		this.clipboardOrigin = null;
		this.clipboardValueSources = {};
		this.clipboardTypes = {};
		this.clipboardKind = "properties";
		this.updateStatusBar();
	}

	// Gives new properties the type the user picked. Types the vault already
	// knows are left alone, so a stale choice can never override them.
	private applyClipboardTypes(payload: Record<string, unknown>): void {
		const declared = collectVaultMetadata(this.app).declaredTypes ?? {};
		for (const [name, widget] of Object.entries(this.clipboardTypes)) {
			if (!(name in payload) || name.toLowerCase() in declared) continue;
			setDeclaredPropertyWidget(this.app, name, widget);
		}
	}

	hasClipboardContent(): boolean {
		return Object.values(this.clipboard).some((value) => !isEmptyPropertyValue(value));
	}

	async pasteProperties(
		targetFile?: TFile | null,
		filterOverride?: FilterOverride
	): Promise<void> {
		if (!this.hasClipboardContent()) {
			new Notice(NOTICE_NO_PROPERTIES_TO_PASTE, NOTICE_TIMEOUT_MS);
			return;
		}

		const file = targetFile ?? (await this.pickTargetFile());
		if (!file) return;
		await this.pastePropertiesIntoFiles([file], filterOverride);
	}

	async pastePropertiesIntoFiles(files: TFile[], filterOverride?: FilterOverride): Promise<void> {
		if (!this.hasClipboardContent()) {
			new Notice(NOTICE_NO_PROPERTIES_TO_PASTE, NOTICE_TIMEOUT_MS);
			return;
		}
		const markdownFiles = this.uniqueMarkdownFiles(files);
		if (markdownFiles.length === 0) {
			new Notice("Property Porter: No markdown files selected");
			return;
		}
		let payload = filterOverride
			? this.filterFrontmatter(this.clipboard, filterOverride)
			: structuredClone(this.clipboard);
		if (selectedClipboardEntries(payload).length === 0) {
			new Notice("Property Porter: Nothing pasted; no property values were selected.");
			return;
		}

		// Duplicate keys in the target are conflicts in every paste mode:
		// resolve them before pasting. The repair is only written once the
		// whole paste has succeeded.
		const duplicates = await this.resolveDuplicateKeys(markdownFiles);
		if (duplicates?.cancelled) return;
		const overrides = new Map(
			markdownFiles
				.map((file) => [file, duplicates.fullByFile.get(file)] as const)
				.filter((entry): entry is [TFile, Record<string, unknown>] => Boolean(entry[1]))
		);

		// A merge-mode scalar collision is ambiguous: ask once before writing.
		// Overwrite and skip modes already encode the user's choice.
		const { conflicts, context } = await this.gatherPasteConflicts(markdownFiles, overrides, payload);
		if (Object.keys(conflicts).length > 0) {
			const resolved = await this.resolveConflicts(payload, conflicts, context);
			if (resolved === null) return; // cancelled: target stays untouched
			payload = resolved;
		}
		const forceTagMerge =
			this.clipboardKind === "tags" ||
			filterOverride?.include.some((key) => ["tag", "tags"].includes(key.trim().toLowerCase())) === true;

		// Overwrite and Skip silently change or ignore existing values; show
		// exactly which ones, and ask first unless the user turned that off.
		const noteChanges = await this.gatherPasteChanges(markdownFiles, overrides, payload, forceTagMerge);
		const mode = this.settings.pasteMode;
		const confirmChanges =
			mode === "overwrite" ? this.settings.confirmOverwrite : mode === "skip" && this.settings.confirmSkip;
		if (noteChanges.length > 0 && confirmChanges && mode !== "merge") {
			const confirmed = await new Promise<boolean>((resolve) => {
				new PasteChangesConfirmModal(this.app, mode, noteChanges, resolve).open();
			});
			if (!confirmed) return; // nothing written, notes stay untouched
		}
		await duplicates.commit();
		this.applyClipboardTypes(payload);
		for (const file of markdownFiles) {
			await this.writeProperties(file, payload, forceTagMerge);
		}
		new Notice(pastedClipboardNotice(payload, markdownFiles.map(({ basename }) => basename)));
		if (noteChanges.length > 0 && !confirmChanges && mode !== "merge") {
			const count = noteChanges.reduce((sum, { changes }) => sum + changes.length, 0);
			const properties = `${count} propert${count === 1 ? "y" : "ies"}`;
			const notes = `${noteChanges.length} note${noteChanges.length === 1 ? "" : "s"}`;
			new Notice(
				mode === "overwrite"
					? `Property Porter: Overwrote ${properties} in ${notes}.`
					: `Property Porter: Skipped ${properties} that already had a different value in ${notes}.`,
				NOTICE_TIMEOUT_MS
			);
		}
	}

	// The existing values an Overwrite or Skip paste would replace or ignore,
	// per note. Tags pasted with a tags command are always unioned, so they
	// never count as changes.
	private async gatherPasteChanges(
		files: TFile[],
		overrides: Map<TFile, Record<string, unknown>>,
		payload: Record<string, unknown>,
		forceTagMerge: boolean
	): Promise<NotePasteChanges[]> {
		if (this.settings.pasteMode === "merge") return [];
		const comparable = forceTagMerge
			? Object.fromEntries(
					Object.entries(payload).filter(([key]) => !["tag", "tags"].includes(key.toLowerCase()))
				)
			: payload;
		const result: NotePasteChanges[] = [];
		for (const file of files) {
			const target = overrides.get(file) ?? (await this.getFreshParsedFrontmatter(file));
			const changes = findPasteChanges(comparable, target, this.settings.pasteMode);
			if (changes.length > 0) result.push({ note: file.basename, changes });
		}
		return result;
	}

	// Writes the clipboard into one file. Each call gets its own deep copy so
	// pasted notes never share array/object references with the clipboard or
	// with each other.
	private async writeProperties(
		file: TFile,
		payload: Record<string, unknown> = this.clipboard,
		forceTagMerge = false
	): Promise<void> {
		const data = structuredClone(payload);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const destination = stripPosition(frontmatter);
			const merged = this.mergeFrontmatter(data, destination);
			if (forceTagMerge) {
				for (const key of Object.keys(data)) {
					if (!["tag", "tags"].includes(key.toLowerCase())) continue;
					const destinationValue = destination[key];
					const destinationTags = Array.isArray(destinationValue)
						? destinationValue
						: destinationValue === null || destinationValue === undefined || destinationValue === ""
							? []
							: [destinationValue];
					const sourceValue = data[key];
					const sourceTags = Array.isArray(sourceValue) ? sourceValue : [sourceValue];
					merged[key] = mergeArrays(sourceTags, mergeArrays(destinationTags, []));
				}
			}
			for (const [key, value] of Object.entries(merged)) {
				frontmatter[key] = value;
			}
		});
	}

	async pasteIntoActive(filterOverride?: FilterOverride): Promise<void> {
		const active = this.getActiveFile();
		if (!active) {
			new Notice("Property Porter: No active file");
			return;
		}
		await this.pasteProperties(active, filterOverride);
	}

	buildNavigationModel(activeLeaf: WorkspaceLeaf | null = null): NavigationModel {
		return buildNavigationModel(this.app, activeLeaf);
	}

	// Returns the markdown files open in the same canonical tab group
	// (window + parent) as the active leaf, excluding sidebar leaves.
	// Pop-out windows are handled automatically because the group identity
	// is (native window, WorkspaceParent), not just the parent object.
	getActiveTabGroupFiles(): TFile[] {
		const workspace = this.app.workspace;
		const currentLeaf = workspace.activeLeaf ?? null;
		const model = buildNavigationModel(this.app, currentLeaf);
		const activeFile = workspace.getActiveFile?.() ?? null;
		const activeFileLeaf = activeFile
			? model.tabs.find(
					({ leaf }) => leaf.view instanceof FileView && leaf.view.file?.path === activeFile.path
				)?.leaf ?? null
			: null;
		const activeLeaf =
			activeFileLeaf ?? currentLeaf;
		const activeGroup = getGroupForLeaf(model, activeLeaf);

		if (!activeGroup) return [];

		const files: TFile[] = [];
		const seen = new Set<string>();

		for (const leaf of activeGroup.leaves) {
			// Tabs not yet loaded after startup have a placeholder view, so the
			// file comes from view state rather than `leaf.view`.
			const loaded = leaf.view instanceof FileView ? leaf.view.file : null;
			const path = loaded?.path ?? getLeafFileKey(leaf);
			if (!path || seen.has(path)) continue;
			const file = loaded ?? this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				seen.add(path);
				files.push(file);
			}
		}

		return files;
	}

	async pasteIntoActiveTabGroup(filterOverride?: FilterOverride): Promise<void> {
		if (!this.hasClipboardContent()) {
			new Notice(NOTICE_NO_PROPERTIES_TO_PASTE, NOTICE_TIMEOUT_MS);
			return;
		}

		const files = this.getActiveTabGroupFiles();
		if (files.length === 0) {
			new Notice("Property Porter: No markdown files in the active tab group");
			return;
		}
		await this.pastePropertiesIntoFiles(files, filterOverride);
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

			new FileSuggestModal(
				this.app,
				files,
				(file) => resolve(file),
				{ searchMode: "substring", limit: 20 }
			).open();
		});
	}

	private selectionModal: SelectPropertiesModal | null = null;

	// Opens the shared property-selection modal seeded with `initial`.
	// A scalar seeded with an array of candidates renders as a conflict the
	// user must resolve. Returns the edited selection, or `cancelled: true`
	// when the modal is dismissed without finishing. Only one such modal is
	// open at a time (in any window); opening another cancels the older one.
	async openPropertySelectionModal(
		initial: Record<string, unknown>,
		conflictContext: Record<string, ConflictCardContext> = {},
		options: SelectPropertiesModalOptions = {}
	): Promise<{
		properties: Record<string, unknown>;
		skipped: Record<string, unknown>;
		propertyTypes: Record<string, string>;
		cancelled: boolean;
	}> {
		const catalog = collectVaultMetadata(this.app);
		this.selectionModal?.close();
		return new Promise((resolve) => {
			const modal: SelectPropertiesModal = new SelectPropertiesModal(
				this.app,
				catalog,
				initial,
				(selected) => {
					if (this.selectionModal === modal) this.selectionModal = null;
					resolve({
						properties: selected,
						skipped: modal.getSkippedProperties(),
						propertyTypes: modal.getChosenTypes(),
						cancelled: false,
					});
				},
				() => {
					if (this.selectionModal === modal) this.selectionModal = null;
					resolve({ properties: {}, skipped: {}, propertyTypes: {}, cancelled: true });
				},
				conflictContext,
				options
			);
			this.selectionModal = modal;
			modal.open();
		});
	}

	// Extracts the scalar keys whose conflicting values were gathered into
	// candidate arrays by `unionFrontmatter(..., { gatherConflicts: true })`.
	private extractScalarConflicts(union: Record<string, unknown>): Record<string, unknown[]> {
		const catalog = collectVaultMetadata(this.app);
		const conflicts: Record<string, unknown[]> = {};
		for (const [key, value] of Object.entries(union)) {
			if (Array.isArray(value) && !isListProperty(catalog, key)) {
				conflicts[key] = value;
			}
		}
		return conflicts;
	}

	// Builds the conflict-card context for a tab-group copy: for each
	// conflicting key, the notes that actually carry that key.
	private buildCrossNoteConflictContext(
		files: TFile[],
		fulls: Record<string, unknown>[],
		conflicts: Record<string, unknown[]>,
		valueSources: FrontmatterValueSources
	): Record<string, ConflictCardContext> {
		const context: Record<string, ConflictCardContext> = {};
		for (const key of Object.keys(conflicts)) {
			const notes: string[] = [];
			const paths: string[] = [];
			files.forEach((file, index) => {
				const value = fulls[index]?.[key];
				if (
					value !== null &&
					value !== undefined &&
					!Array.isArray(value) &&
					!isEmptyPropertyValue(value)
				) {
					notes.push(file.basename);
					paths.push(file.path);
				}
			});
			context[key] = {
				...(notes.length > 0 ? { conflictNotes: notes, conflictPaths: paths } : {}),
				...(valueSources[key] ? { valueSources: { [key]: valueSources[key] } } : {}),
			};
		}
		return context;
	}

	// Detects scalar collisions between the clipboard and the given target
	// notes. Only "merge" paste mode is ambiguous enough to ask; "overwrite"
	// and "skip" already encode the user's choice. For each conflicting key
	// the candidates are the clipboard value plus every distinct target value.
	// `overrides` replace a target's cached frontmatter (used after a
	// duplicate-key repair, which the metadata cache may not reflect yet).
	private async gatherPasteConflicts(
		files: TFile[],
		overrides?: Map<TFile, Record<string, unknown>>,
		payload: Record<string, unknown> = this.clipboard
	): Promise<{ conflicts: Record<string, unknown[]>; context: Record<string, ConflictCardContext> }> {
		const conflicts: Record<string, unknown[]> = {};
		const context: Record<string, ConflictCardContext> = {};
		if (this.settings.pasteMode !== "merge") return { conflicts, context };

		const targetFrontmatters = await Promise.all(
			files.map(async (file) => ({
				note: file.basename,
				path: file.path,
				frontmatter: overrides?.get(file) ?? (await this.getFreshParsedFrontmatter(file)),
			}))
		);
		const fallbackClipboardSources: FrontmatterValueSources = this.clipboardOrigin
			? collectValueSources([{ note: this.clipboardOrigin, frontmatter: payload }])
			: {};
		for (const key of Object.keys(this.clipboardValueSources)) {
			if (key in payload) delete fallbackClipboardSources[key];
		}
		const clipboardValueSources = Object.fromEntries(
			Object.entries(this.clipboardValueSources).filter(([key]) => key in payload)
		);
		const valueSources = mergeValueSourcesByMaximumCount(
			clipboardValueSources,
			fallbackClipboardSources,
			collectValueSources(targetFrontmatters)
		);
		for (const [key, propertySources] of Object.entries(valueSources)) {
			context[key] = { valueSources: { [key]: propertySources } };
		}

		const catalog = collectVaultMetadata(this.app);
		for (const { note, path, frontmatter: target } of targetFrontmatters) {
			for (const [key, clipValue] of Object.entries(payload)) {
				if (isEmptyPropertyValue(clipValue) || Array.isArray(clipValue)) continue;
				if (isListProperty(catalog, key)) continue;

				const targetValue = target[key];
				if (
					targetValue === null ||
					targetValue === undefined ||
					isEmptyPropertyValue(targetValue) ||
					Array.isArray(targetValue)
				)
					continue;

				const clipStr = String(clipValue).trim();
				const targetStr = String(targetValue).trim();
				if (clipStr === targetStr) continue;

				const candidates = conflicts[key] ?? [clipStr];
				if (!candidates.includes(targetStr)) candidates.push(targetStr);
				conflicts[key] = candidates;

				const ctx =
					context[key] ??
					{ clipboardOrigin: this.clipboardOrigin ?? undefined, conflictNotes: [] };
				ctx.clipboardOrigin = this.clipboardOrigin ?? undefined;
				ctx.conflictNotes ??= [];
				if (!ctx.conflictNotes?.includes(note)) ctx.conflictNotes?.push(note);
				ctx.conflictPaths ??= [];
				if (!ctx.conflictPaths.includes(path)) ctx.conflictPaths.push(path);
				context[key] = ctx;
			}
		}
		return { conflicts, context };
	}

	// Lets the user resolve `conflicts` in the shared modal and folds the
	// resolution into `payload` (mutated in place). A conflicting key the
	// user cleared is removed from the payload. Returns null when the user
	// dismisses the modal, aborting the operation that called this.
	private async resolveConflicts(
		payload: Record<string, unknown>,
		conflicts: Record<string, unknown[]>,
		context: Record<string, ConflictCardContext> = {}
	): Promise<Record<string, unknown> | null> {
		const result = await this.openPropertySelectionModal(
			{ ...payload, ...conflicts },
			context,
			{
				title: "Resolve property conflicts",
				conflictNames: Object.keys(conflicts),
				finishText: "Continue",
			}
		);
		if (result.cancelled) return null;
		Object.assign(this.clipboardTypes, result.propertyTypes);
		return result.properties;
	}

	async editPropertyClipboard(): Promise<void> {
		const context = Object.fromEntries(
			Object.entries(this.clipboardValueSources).map(([key, valueSources]) => [
				key,
				{ valueSources: { [key]: valueSources } },
			])
		);
		const result = await this.openPropertySelectionModal(
			{ ...this.clipboard },
			context,
			{
				title: "Edit property clipboard",
				initialFocus: this.clipboardKind === "tags" ? "tags" : "add",
				subtitle: this.clipboardKind === "tags" ? "Tag copy" : "Property copy",
				subtitleHint:
					this.clipboardKind === "tags"
						? "Copied with a tags command. On paste, tags are always merged (union) whatever the Paste mode; other properties follow the Paste mode."
						: "Copied with a properties command. On paste, the Paste mode setting applies to every property.",
			}
		);

		if (result.cancelled) return;

		const previousClipboard = this.clipboard;
		this.clipboard = result.properties;
		this.clipboardTypes = result.propertyTypes ?? {};
		this.clipboardOrigin = null;
		const previousSources = this.clipboardValueSources;
		this.clipboardValueSources = Object.fromEntries(
			Object.entries(result.properties).flatMap(([key, selected]) => {
				const previousValues = new Set(
					[previousClipboard[key]].flat().map((item) => String(item).trim())
				);
				const kept = previousSources[key] ?? {};
				const entries: Array<[string, (typeof kept)[string]]> = [];
				for (const item of [selected].flat()) {
					const value = String(item).trim();
					if (kept[value]) entries.push([value, kept[value]]);
					else if (!previousValues.has(value))
						entries.push([value, [{ note: "Edited clipboard", count: 1 }]]);
				}
				return entries.length ? [[key, Object.fromEntries(entries)]] : [];
			})
		);
		this.updateStatusBar();
		const count = this.countClipboardValues();
		if (count === 0) {
			new Notice(NOTICE_CLEARED_COPIED_PROPERTIES);
			return;
		}
		new Notice(`Property Porter: ${clipboardDescription(this.clipboard)} ready to paste`);
	}

	async selectPropertiesToPaste(): Promise<void> {
		await this.editPropertyClipboard();
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

export class PropertyPorterSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: PropertyPorter
	) {
		super(app, plugin);
	}

	setControlValue(key: string, value: unknown): void {
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		void this.plugin.saveSettings();
		// The confirm toggles only apply to some paste modes.
		this.refreshDomState();
	}

	getSettingDefinitions(): SettingDefinitionItem<keyof PropertyPorterSettings>[] {
		const propertyPickerDefinition = (key: "onlyInclude" | "excludeKeys") => {
			const isIncludePicker = key === "onlyInclude";
			return {
				name: isIncludePicker ? "Only include properties" : "Exclude properties",
				desc: isIncludePicker
					? "Choose existing properties or confirm new names to copy. Cannot overlap with Exclude properties."
					: "Choose existing properties or confirm new names to skip. Cannot overlap with Only include properties.",
				render: (setting: Setting) => {
					setting.settingEl.classList.add("commons-property-list-setting");
					const catalog = collectVaultMetadata(this.app);
					const picker = new ValuePicker(this.app, setting.controlEl, {
						...propertyNamePickerOptions(() => catalog),
						appearance: "property",
						selectedLayout: "rows",
						value: parseCommaList(this.plugin.settings[key]),
						multiple: true,
						allowCreate: true,
						kind: "property",
						classPrefix: "pp",
						placeholder: "Add a property",
						ariaLabel: isIncludePicker
							? "Only include properties"
							: "Exclude properties",
						onChange: (values) => {
							const includes = isIncludePicker ? values.join(", ") : this.plugin.settings.onlyInclude;
							const excludes = isIncludePicker ? this.plugin.settings.excludeKeys : values.join(", ");
							const overlaps = findOverlappingPropertyFilters(includes, excludes);
							if (overlaps.length > 0) {
								const names = overlaps.join(", ");
								new Notice(
									`Property Porter: ${names} ${overlaps.length === 1 ? "is" : "are"} already ${
										isIncludePicker ? "excluded" : "included"
									} and cannot also be ${isIncludePicker ? "included" : "excluded"}.`
								);
								picker.setValue(parseCommaList(this.plugin.settings[key]));
								return;
							}
							this.plugin.settings[key] = values.join(", ");
							void this.plugin.saveSettings();
						},
					});

					return () => {
						picker.destroy();
					};
				},
			};
		};

		return [
			{
				type: "group",
				heading: "Property filters (property-copy commands)",
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
						desc: "Controls how clipboard properties are applied. For a tags-only copy, tags are always unioned; other properties added in the clipboard editor follow this setting, with scalar conflicts resolved normally in Merge mode.",
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
					{
						name: "Confirm before overwriting",
						desc: "Before an Overwrite paste replaces existing values, list each note's changes and ask first. When off, a notice reports what was overwritten.",
						visible: () => this.plugin.settings.pasteMode === "overwrite",
						control: {
							type: "toggle",
							key: "confirmOverwrite" satisfies keyof PropertyPorterSettings,
						},
					},
					{
						name: "Confirm before skipping",
						desc: "Before a Skip existing paste leaves different existing values unchanged, list each note's skipped properties and ask first. When off, a notice reports what was skipped.",
						visible: () => this.plugin.settings.pasteMode === "skip",
						control: {
							type: "toggle",
							key: "confirmSkip" satisfies keyof PropertyPorterSettings,
						},
					},
				],
			},
		];
	}
}
