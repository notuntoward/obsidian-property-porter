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
	collectValueSources,
	mergeValueSources,
	isEmptyPropertyValue,
	countPropertyValue,
	parseCommaList,
	parseRawFrontmatter,
	applyDuplicateResolution,
	formatRawValue,
	type PasteMode,
	type FrontmatterValueSources,
	type RawFrontmatter,
	type DuplicateResolution,
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
	isListProperty,
	normalizeTag,
	ValuePicker,
} from "commons/properties";
import { FileSuggestModal } from "./utils/modal";
import { SelectPropertiesModal, type ConflictCardContext } from "./select-properties-modal";

export class SourceRepairPermissionModal extends Modal {
	private answered = false;

	constructor(app: App, private readonly files: TFile[], private readonly answer: (allow: boolean) => void) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Repair duplicate properties in source notes?");
		this.contentEl.createEl("p", {
			text: "Your chosen values will be copied either way. Allow Property Porter to rewrite these source notes, keeping only your chosen occurrences and removing any properties you cleared?",
		});
		const list = this.contentEl.createEl("ul");
		for (const file of this.files) list.createEl("li", { text: file.path });
		for (const [label, allow] of [["Copy only", false], ["Repair notes and copy", true]] as const) {
			const button = this.contentEl.createEl("button", { text: label });
			button.addEventListener("click", () => {
				this.answered = true;
				this.answer(allow);
				this.close();
			});
		}
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
	/** Name of the note (or notes) the clipboard was copied from, so paste
	 * conflicts can say where the clipboard value came from. */
	clipboardOrigin: string | null = null;
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
	applyClipboard(fm: Record<string, unknown>, valueSources: FrontmatterValueSources = {}): void {
		this.clipboard = fm;
		this.clipboardValueSources = valueSources;
		this.updateStatusBar();
		const count = this.countClipboardValues();
		new Notice(`Property Porter: ${count} propert${count === 1 ? "y" : "ies"} copied`);
	}

	// Reads the raw text of a file. Duplicate-key detection cannot use the
	// metadata cache because Obsidian can return no frontmatter at all for a
	// note with duplicated keys.
	private async readRawFileContent(file: TFile): Promise<string> {
		try {
			return (await this.app.vault.cachedRead?.(file)) ?? "";
		} catch (error) {
			new Notice(
				`Property Porter: could not read ${file.basename} to check for duplicate properties (${String(error)})`
			);
			return "";
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
	private async resolveDuplicateKeys(files: TFile[], askBeforeRepair = false): Promise<{
		cancelled: boolean;
		/** Post-repair frontmatter per note that had duplicates. */
		fullByFile: Map<TFile, Record<string, unknown>>;
		/** Applies the staged note rewrites. Call only on success. */
		commit: () => Promise<void>;
	} | null> {
		const staged: Array<{ file: TFile; content: string }> = [];
		const fullByFile = new Map<TFile, Record<string, unknown>>();

		for (const file of files) {
			const content = await this.readRawFileContent(file);
			const parsed = parseRawFrontmatter(content);
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

			const result = await this.openPropertySelectionModal({ ...conflicts }, context);
			if (result.cancelled) return { cancelled: true, fullByFile: new Map(), commit: async () => {} };

			const keep: Record<string, unknown> = {};
			const remove: string[] = [];
			const decisions: DuplicateResolution[] = [];
			for (const key of Object.keys(conflicts)) {
				if (!(key in result.properties)) {
					// Cleared: remove the property from the note entirely.
					remove.push(key);
					decisions.push({ key, remove: true });
					continue;
				}
				const chosen = result.properties[key];
				const display = Array.isArray(chosen) ? chosen.join(", ") : String(chosen);
				const match = origins[key]?.find((origin) => origin.display === display);
				const value = match ? structuredClone(match.value) : display;
				keep[key] = value;
				decisions.push({ key, keep: value });
			}

			staged.push({ file, content: applyDuplicateResolution(content, decisions) });
			const full: Record<string, unknown> = { ...parsed.map, ...keep };
			for (const key of remove) delete full[key];
			fullByFile.set(file, full);
		}

		if (staged.length === 0) return null;

		const commit = async (): Promise<void> => {
			if (askBeforeRepair && !(await this.confirmSourceRepair(staged.map(({ file }) => file)))) return;
			for (const { file, content } of staged) {
				await this.app.vault.modify(file, content);
			}
		};
		return { cancelled: false, fullByFile, commit };
	}

	confirmSourceRepair(files: TFile[]): Promise<boolean> {
		return new Promise((resolve) => {
			new SourceRepairPermissionModal(this.app, files, resolve).open();
		});
	}

	async copyProperties(): Promise<void> {
		const source = this.getActiveFile();
		if (!source) {
			new Notice("Property Porter: No active file");
			return;
		}
		const duplicates = await this.resolveDuplicateKeys([source], true);
		if (duplicates?.cancelled) return;
		const full = duplicates?.fullByFile.get(source) ?? this.getParsedFrontmatter(source);
		const filtered = filterFrontmatter(full, this.settings.onlyInclude, this.settings.excludeKeys);
		await duplicates?.commit();
		this.clipboardOrigin = source.basename;
		this.applyClipboard(
			filtered,
			collectValueSources([{ note: source.basename, frontmatter: filtered }])
		);
	}

	// Copies properties from a note the user picks via the same file selector
	// used by "Paste properties into another note", then applies the same
	// copy logic as `copyProperties`.
	async copyPropertiesFrom(): Promise<void> {
		const file = await this.pickTargetFile();
		if (!file) return;
		const duplicates = await this.resolveDuplicateKeys([file], true);
		if (duplicates?.cancelled) return;
		const full = duplicates?.fullByFile.get(file) ?? this.getParsedFrontmatter(file);
		const filtered = filterFrontmatter(full, this.settings.onlyInclude, this.settings.excludeKeys);
		await duplicates?.commit();
		this.clipboardOrigin = file.basename;
		this.applyClipboard(filtered, collectValueSources([{ note: file.basename, frontmatter: filtered }]));
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

		const duplicates = await this.resolveDuplicateKeys(files, true);
		if (duplicates?.cancelled) return; // leave every note and the clipboard untouched

		const fulls: Record<string, unknown>[] = [];
		const collected = files.map((file) => {
			const full = duplicates?.fullByFile.get(file) ?? this.getParsedFrontmatter(file);
			fulls.push(full);
			return filterFrontmatter(full, this.settings.onlyInclude, this.settings.excludeKeys);
		});
		const valueSources = collectValueSources(
			files.map((file, index) => ({ note: file.basename, frontmatter: collected[index] }))
		);

		// Gather scalar collisions across the group and resolve them in one
		// place before anything reaches the clipboard. When no key conflicts,
		// the union is copied silently, as before.
		const union = unionFrontmatter(collected, { gatherConflicts: true });
		const conflicts = this.extractScalarConflicts(union);
		if (Object.keys(conflicts).length > 0) {
			const context = this.buildCrossNoteConflictContext(files, fulls, conflicts, valueSources);
			const resolved = await this.resolveConflicts({ ...union }, conflicts, context);
			if (resolved === null) return; // cancelled: notes stay unrepaired, clipboard untouched
			await duplicates?.commit();
			this.clipboardOrigin = files.map((file) => file.basename).join(", ");
			this.applyClipboard(resolved, valueSources);
			return;
		}
		await duplicates?.commit();
		this.clipboardOrigin = files.map((file) => file.basename).join(", ");
		this.applyClipboard(union, valueSources);
	}

	clearClipboard(): void {
		this.clipboard = {};
		this.clipboardOrigin = null;
		this.clipboardValueSources = {};
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

		// Duplicate keys in the target are conflicts in every paste mode:
		// resolve them before pasting. The repair is only written once the
		// whole paste has succeeded.
		const duplicates = await this.resolveDuplicateKeys([file]);
		if (duplicates?.cancelled) return;
		const repaired = duplicates?.fullByFile.get(file);
		const overrides = repaired ? new Map([[file, repaired]]) : undefined;

		// A merge-mode scalar collision is ambiguous: ask once before writing.
		// Overwrite and skip modes already encode the user's choice.
		const payload = structuredClone(this.clipboard);
		const { conflicts, context } = this.gatherPasteConflicts([file], overrides);
		if (Object.keys(conflicts).length > 0) {
			const resolved = await this.resolveConflicts(payload, conflicts, context);
			if (resolved === null) return; // cancelled: target stays untouched
			await duplicates?.commit();
			await this.writeProperties(file, resolved);
		} else {
			await duplicates?.commit();
			await this.writeProperties(file, payload);
		}
		new Notice(`Property Porter: Pasted properties into ${file.basename}`);
	}

	// Writes the clipboard into one file. Each call gets its own deep copy so
	// pasted notes never share array/object references with the clipboard or
	// with each other.
	private async writeProperties(
		file: TFile,
		payload: Record<string, unknown> = this.clipboard
	): Promise<void> {
		const data = structuredClone(payload);
		await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
			const merged = this.mergeFrontmatter(data, stripPosition(frontmatter));
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

		// Resolve every conflict in the group once, in one place, and apply
		// the same resolution to every note. Duplicate keys in any target are
		// conflicts in every paste mode: resolve them before pasting. Repairs
		// are only written once the whole paste has succeeded.
		const duplicates = await this.resolveDuplicateKeys(files);
		if (duplicates?.cancelled) return;
		const overrides = duplicates
			? new Map(
					files
						.map((file) => [file, duplicates.fullByFile.get(file)] as const)
						.filter((entry): entry is [TFile, Record<string, unknown>] => Boolean(entry[1]))
				)
			: undefined;

		const { conflicts, context } = this.gatherPasteConflicts(files, overrides);
		let payload: Record<string, unknown> | null = structuredClone(this.clipboard);
		if (Object.keys(conflicts).length > 0) {
			payload = await this.resolveConflicts(payload, conflicts, context);
			if (payload === null) return; // cancelled: nothing is written, notes stay unrepaired
		}

		await duplicates?.commit();
		for (const file of files) {
			await this.writeProperties(file, payload);
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
		this.clipboardOrigin = null;
		this.clipboardValueSources = {};
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

	// Opens the shared property-selection modal seeded with `initial`.
	// A scalar seeded with an array of candidates renders as a conflict the
	// user must resolve. Returns the edited selection, or `cancelled: true`
	// when the modal is dismissed without finishing.
	async openPropertySelectionModal(
		initial: Record<string, unknown>,
		conflictContext: Record<string, ConflictCardContext> = {}
	): Promise<{ properties: Record<string, unknown>; cancelled: boolean }> {
		const catalog = collectVaultMetadata(this.app);
		return new Promise((resolve) => {
			new SelectPropertiesModal(
				this.app,
				catalog,
				initial,
				(selected) => resolve({ properties: selected, cancelled: false }),
				() => resolve({ properties: {}, cancelled: true }),
				conflictContext
			).open();
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
			files.forEach((file, index) => {
				const value = fulls[index]?.[key];
				if (
					value !== null &&
					value !== undefined &&
					!Array.isArray(value) &&
					!isEmptyPropertyValue(value)
				) {
					notes.push(file.basename);
				}
			});
			context[key] = {
				...(notes.length > 0 ? { conflictNotes: notes } : {}),
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
	private gatherPasteConflicts(
		files: TFile[],
		overrides?: Map<TFile, Record<string, unknown>>
	): { conflicts: Record<string, unknown[]>; context: Record<string, ConflictCardContext> } {
		const conflicts: Record<string, unknown[]> = {};
		const context: Record<string, ConflictCardContext> = {};
		if (this.settings.pasteMode !== "merge") return { conflicts, context };

		const targetFrontmatters = files.map((file) => ({
			note: file.basename,
			frontmatter: overrides?.get(file) ?? this.getParsedFrontmatter(file),
		}));
		const fallbackClipboardSources: FrontmatterValueSources = this.clipboardOrigin
			? collectValueSources([{ note: this.clipboardOrigin, frontmatter: this.clipboard }])
			: {};
		for (const key of Object.keys(this.clipboardValueSources)) {
			delete fallbackClipboardSources[key];
		}
		const valueSources = mergeValueSources(
			this.clipboardValueSources,
			fallbackClipboardSources,
			collectValueSources(targetFrontmatters)
		);
		for (const [key, propertySources] of Object.entries(valueSources)) {
			context[key] = { valueSources: { [key]: propertySources } };
		}

		const catalog = collectVaultMetadata(this.app);
		for (const { note, frontmatter: target } of targetFrontmatters) {
			for (const [key, clipValue] of Object.entries(this.clipboard)) {
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
		const result = await this.openPropertySelectionModal({ ...conflicts }, context);
		if (result.cancelled) return null;
		for (const key of Object.keys(conflicts)) {
			if (key in result.properties) payload[key] = result.properties[key];
			else delete payload[key];
		}
		return payload;
	}

	// Edits the properties clipboard directly. The modal shows exactly what
	// is in the clipboard (empty when nothing has been copied yet), so this
	// doubles as a debugging check on the current clipboard state. Conflict
	// resolution happens on copy and paste instead, not here.
	async selectPropertiesToPaste(): Promise<void> {
		const context = Object.fromEntries(
			Object.entries(this.clipboardValueSources).map(([key, valueSources]) => [
				key,
				{ valueSources: { [key]: valueSources } },
			])
		);
		const result = await this.openPropertySelectionModal({ ...this.clipboard }, context);

		if (result.cancelled) return;

		this.clipboard = result.properties;
		this.clipboardValueSources = Object.fromEntries(
			Object.entries(this.clipboardValueSources)
				.filter(([key]) => key in result.properties)
				.map(([key, values]) => [
					key,
					Object.fromEntries(
						Object.entries(values).filter(([value]) => {
							const selected = result.properties[key];
							return Array.isArray(selected)
								? selected.some((item) => String(item).trim() === value)
								: String(selected).trim() === value;
						})
					),
				])
		);
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
