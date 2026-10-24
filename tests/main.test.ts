// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as obsidianMock from "obsidian";
import { registerEmacsMotionKeys } from "../src/utils/modal";
import PropertyPorter, {
	SuggestFilesModal,
	FileSuggestModal,
	PropertyPorterSettingTab,
	MultiSelectSuggestModal,
	NOTICE_NO_PROPERTIES_TO_PASTE,
	NOTICE_CLEARED_COPIED_TAGS,
	NOTICE_TIMEOUT_MS,
} from "../src/main";

function getInputSuggest(input: HTMLInputElement): any {
	const suggestClass = obsidianMock.AbstractInputSuggest as any;
	return suggestClass.instances.find((instance: any) => instance.inputEl === input);
}

function selectInputSuggestion(input: HTMLInputElement, query: string, value: string): void {
	const suggester = getInputSuggest(input);
	const option = suggester
		.suggestions(query)
		.find((candidate: any) => candidate.kind === "suggestion" && candidate.value === value);
	expect(option).toBeDefined();
	suggester.select(option);
}

function createApp(options: any = {}) {
	const activeFile = options.activeFile ?? null;
	const markdownFiles = options.markdownFiles ?? [];
	const fileCache: Record<string, any> = options.fileCache ?? {};

	// Build workspace leaves for the active-tab-group feature. Each entry in
	// `leaves` is { file, group? }; leaves sharing the same `group` value are
	// considered part of the same tab group. The active leaf is leaves[0].
	// Leaves in the same group share a single WorkspaceTabs instance so the
	// `leaf.parent === activeParent` identity check works like real Obsidian.
	const groupMap = new Map<string, any>();
	const leaves: any[] = (options.leaves ?? []).map((leaf: any) => {
		const groupId = leaf.group ?? "default";
		let group = groupMap.get(groupId);
		if (!group) {
			group = new obsidianMock.WorkspaceTabs(groupId);
			groupMap.set(groupId, group);
		}
		return {
			parent: group,
			view: new obsidianMock.FileView(leaf.file),
			getRoot: () => group,
			getContainer: () => ({ win: globalThis.window }),
		};
	});

	const app = new obsidianMock.App({
		workspace: {
			getActiveFile: () => activeFile,
			activeLeaf: leaves[0] ?? null,
			iterateAllLeaves: (cb: (leaf: any) => void) => {
				for (const leaf of leaves) cb(leaf);
			},
		},
		metadataCache: {
			getFileCache: (file: obsidianMock.TFile) => fileCache[file.path] ?? null,
		},
		vault: { getMarkdownFiles: () => markdownFiles },
		fileManager: {
			processFrontMatter: async (file: obsidianMock.TFile, processor: (fm: any) => void) => {
				const existing = fileCache[file.path]?.frontmatter ?? {};
				const fm = { ...existing };
				processor(fm);
				fileCache[file.path] = { frontmatter: fm };
			},
		},
	});
	return { app, activeFile, markdownFiles, fileCache };
}

function createPlugin(options: any = {}) {
	const { app, ...rest } = createApp(options);
	const plugin = new PropertyPorter(app as any, {
		id: "property-porter",
		name: "Property Porter",
		version: "0.0.0",
	});
	return { plugin, app, ...rest };
}

const originalSuggestModalOpen = obsidianMock.SuggestModal.prototype.open;
const originalModalOpen = obsidianMock.Modal.prototype.open;

afterEach(() => {
	obsidianMock.SuggestModal.prototype.open = originalSuggestModalOpen;
	obsidianMock.Modal.prototype.open = originalModalOpen;
	vi.restoreAllMocks();
});

describe("PropertyPorter", () => {
	let originalSuggestOpen: () => void;

	beforeEach(() => {
		originalSuggestOpen = obsidianMock.SuggestModal.prototype.open;
		obsidianMock.Setting.clearInstances();
		vi.restoreAllMocks();
	});

	afterEach(() => {
		obsidianMock.SuggestModal.prototype.open = originalSuggestOpen;
	});

	describe("lifecycle", () => {
		it("loads settings, status bar, commands and settings tab on load", async () => {
			const { plugin } = createPlugin();
			const loadSettings = vi.spyOn(plugin, "loadSettings");
			const addCommand = vi.spyOn(plugin, "addCommand");
			const addSettingTab = vi.spyOn(plugin, "addSettingTab");

			await plugin.onload();

			expect(loadSettings).toHaveBeenCalled();
			expect(plugin.statusBarItem).toBeDefined();
			expect(addCommand).toHaveBeenCalledTimes(9);
			expect(addSettingTab).toHaveBeenCalledWith(expect.any(PropertyPorterSettingTab));
		});

		it("registered command callbacks delegate to plugin methods", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const run = (id: string) => {
				const call = addCommand.mock.calls.find((c) => c[0].id === id);
				return call?.[0].callback();
			};

			const copyProperties = vi.spyOn(plugin, "copyProperties").mockResolvedValue();
			const pasteProperties = vi.spyOn(plugin, "pasteProperties").mockResolvedValue();
			const pasteIntoActive = vi.spyOn(plugin, "pasteIntoActive").mockResolvedValue();
			const clearClipboard = vi.spyOn(plugin, "clearClipboard");

			await run("copy-properties");
			expect(copyProperties).toHaveBeenCalled();

			await run("paste-properties");
			expect(pasteProperties).toHaveBeenCalledWith();

			await run("paste-into-active");
			expect(pasteIntoActive).toHaveBeenCalled();

			run("clear-clipboard");
			expect(clearClipboard).toHaveBeenCalled();

			const selectTagsToPaste = vi.spyOn(plugin, "selectTagsToPaste").mockResolvedValue();
			await run("select-tags-to-paste");
			expect(selectTagsToPaste).toHaveBeenCalled();

			const selectPropertiesToPaste = vi.spyOn(plugin, "selectPropertiesToPaste").mockResolvedValue();
			await run("select-properties-to-paste");
			expect(selectPropertiesToPaste).toHaveBeenCalled();
		});

		it("registers the select-properties-to-paste command with 'Select properties to paste' name", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const call = addCommand.mock.calls.find((c) => c[0].id === "select-properties-to-paste");
			expect(call?.[0].name).toBe("Select properties to paste");
		});

		it("registers the clear command with 'Clear properties clipboard' name", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const call = addCommand.mock.calls.find((c) => c[0].id === "clear-clipboard");
			expect(call?.[0].name).toBe("Clear properties clipboard");
		});

		it("registers the tag-picker command with an accurate 'Select tags to paste' name, not the misleading 'properties' wording", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const call = addCommand.mock.calls.find((c) => c[0].id === "select-tags-to-paste");
			expect(call?.[0].name).toBe("Select tags to paste");
		});

		it("clears clipboard and updates status bar on unload", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { a: 1 };
			const spy = vi.spyOn(plugin, "updateStatusBar");

			plugin.onunload();

			expect(plugin.clipboard).toEqual({});
			expect(spy).toHaveBeenCalled();
		});
	});

	describe("settings", () => {
		it("merges defaults with stored data", async () => {
			const { plugin } = createPlugin();
			vi.spyOn(plugin, "loadData").mockResolvedValue({
				pasteMode: "overwrite",
				onlyInclude: "status",
			});

			await plugin.loadSettings();

			expect(plugin.settings.pasteMode).toBe("overwrite");
			expect(plugin.settings.onlyInclude).toBe("status");
			expect(plugin.settings.excludeKeys).toBe("aliases, created date, modified date");
			expect(plugin.settings).not.toHaveProperty("autoClear");
		});

		it("drops a stale autoClear value left in stored data", async () => {
			const { plugin } = createPlugin();
			vi.spyOn(plugin, "loadData").mockResolvedValue({ autoClear: true });

			await plugin.loadSettings();

			expect(plugin.settings).not.toHaveProperty("autoClear");
		});

		it("persists settings and refreshes status bar", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			const saveData = vi.spyOn(plugin, "saveData").mockResolvedValue(undefined);
			const update = vi.spyOn(plugin, "updateStatusBar");

			plugin.settings.onlyInclude = "custom";
			await plugin.saveSettings();

			expect(saveData).toHaveBeenCalledWith(plugin.settings);
			expect(update).toHaveBeenCalled();
		});
	});

	describe("status bar", () => {
		it("shows count when clipboard has items and blank when empty", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();

			plugin.clipboard = {};
			plugin.updateStatusBar();
			expect(plugin.statusBarItem.textContent).toBe("");

			plugin.clipboard = { a: 1, b: 2 };
			plugin.updateStatusBar();
			expect(plugin.statusBarItem.textContent).toBe("PP: 2");
		});
	});

	describe("file access", () => {
		it("returns the active file", () => {
			const active = new obsidianMock.TFile("folder/note.md");
			const { plugin } = createPlugin({ activeFile: active });
			expect(plugin.getActiveFile()).toBe(active);
		});

		it("returns parsed frontmatter without position", () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin, fileCache } = createPlugin();
			fileCache[file.path] = {
				frontmatter: { tags: ["a"], position: { start: { line: 0 } } },
			};

			expect(plugin.getParsedFrontmatter(file)).toEqual({ tags: ["a"] });
		});

		it("returns empty object when no frontmatter", () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin } = createPlugin();
			expect(plugin.getParsedFrontmatter(file)).toEqual({});
		});
	});

	describe("copy", () => {
		it("shows notice and returns null when no active file", () => {
			const { plugin } = createPlugin();
			const spy = vi.spyOn(obsidianMock, "Notice");

			const result = plugin.getFilteredSourceFrontmatter();

			expect(result).toBeNull();
			expect(spy).toHaveBeenCalledWith("Property Porter: No active file");
		});

		it("filters source frontmatter by settings", () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin, fileCache } = createPlugin({ activeFile: file });
			fileCache[file.path] = {
				frontmatter: { tags: ["a"], status: "x", aliases: "me" },
			};
			plugin.settings.onlyInclude = "tags, status";

			expect(plugin.getFilteredSourceFrontmatter()).toEqual({
				tags: ["a"],
				status: "x",
			});
		});

		it("copies filtered frontmatter and updates status, counting individual tag values not keys", async () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin, fileCache } = createPlugin({ activeFile: file });
			await plugin.onload();
			fileCache[file.path] = {
				frontmatter: { tags: ["a", "b"], status: "done" },
			};
			plugin.settings.onlyInclude = "tags";
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyProperties();

			expect(plugin.clipboard).toEqual({ tags: ["a", "b"] });
			expect(plugin.statusBarItem.textContent).toBe("PP: 2");
			expect(spy).toHaveBeenCalledWith("Property Porter: 2 properties copied");
		});

		it("uses singular wording when exactly one value is copied", async () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin, fileCache } = createPlugin({ activeFile: file });
			await plugin.onload();
			fileCache[file.path] = { frontmatter: { tags: ["solo"] } };
			plugin.settings.onlyInclude = "tags";
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyProperties();

			expect(spy).toHaveBeenCalledWith("Property Porter: 1 property copied");
		});

		it("counts individual values across multiple included properties", async () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin, fileCache } = createPlugin({ activeFile: file });
			await plugin.onload();
			fileCache[file.path] = {
				frontmatter: {
					tags: ["a", "b", "c"],
					status: "done",
					aliases: [],
				},
			};
			plugin.settings.onlyInclude = "tags, status, aliases";
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyProperties();

			// 3 tags + 1 scalar status + 0 from the empty aliases array = 4
			expect(spy).toHaveBeenCalledWith("Property Porter: 4 properties copied");
			expect(plugin.statusBarItem.textContent).toBe("PP: 4");
		});

		it("shows 0 properties copied when the only included property is an empty array", async () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin, fileCache } = createPlugin({ activeFile: file });
			await plugin.onload();
			fileCache[file.path] = { frontmatter: { tags: [] } };
			plugin.settings.onlyInclude = "tags";
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyProperties();

			expect(spy).toHaveBeenCalledWith("Property Porter: 0 properties copied");
			expect(plugin.statusBarItem.textContent).toBe("");
		});

		it("does nothing when filtered source is null", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { a: 1 };

			await plugin.copyProperties();

			expect(plugin.clipboard).toEqual({ a: 1 });
		});

		it("copies from a note chosen via the file selector", async () => {
			const active = new obsidianMock.TFile("active.md");
			const source = new obsidianMock.TFile("source.md");
			const { plugin, fileCache } = createPlugin({
				activeFile: active,
				markdownFiles: [active, source],
			});
			await plugin.onload();
			fileCache[source.path] = { frontmatter: { status: "from-source" } };
			plugin.settings.onlyInclude = "status";
			obsidianMock.SuggestModal.prototype.open = function (this: any) {
				this.onChooseItem(source);
			};
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyPropertiesFrom();

			expect(plugin.clipboard).toEqual({ status: "from-source" });
			expect(spy).toHaveBeenCalledWith("Property Porter: 1 property copied");
		});

		it("does nothing when there are no other markdown files to pick from", async () => {
			const active = new obsidianMock.TFile("active.md");
			const { plugin } = createPlugin({
				activeFile: active,
				markdownFiles: [active],
			});
			await plugin.onload();
			plugin.clipboard = { a: 1 };
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyPropertiesFrom();

			// pickTargetFile resolves null when no *other* markdown files
			// exist, so the clipboard is left untouched.
			expect(plugin.clipboard).toEqual({ a: 1 });
			expect(spy).toHaveBeenCalledWith("Property Porter: No other markdown files found");
		});
	});

	describe("clipboard", () => {
		it("clears clipboard and status", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { a: 1 };

			plugin.clearClipboard();

			expect(plugin.clipboard).toEqual({});
			expect(plugin.statusBarItem.textContent).toBe("");
		});
	});

	describe("paste", () => {
		it("shows notice when clipboard is empty", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteProperties(new obsidianMock.TFile("dest.md"));

			expect(spy).toHaveBeenCalledWith(NOTICE_NO_PROPERTIES_TO_PASTE, NOTICE_TIMEOUT_MS);
		});

		it("shows notice when clipboard has a key but its value is effectively empty, and does not touch the target", async () => {
			const target = new obsidianMock.TFile("dest.md");
			const { plugin, fileCache } = createPlugin();
			await plugin.onload();
			// Clipboard has a key ("tags") but its value is an empty array,
			// so nothing meaningful would actually be pasted.
			plugin.clipboard = { tags: [] };
			fileCache[target.path] = { frontmatter: { title: "T" } };
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteProperties(target);

			expect(spy).toHaveBeenCalledWith(NOTICE_NO_PROPERTIES_TO_PASTE, NOTICE_TIMEOUT_MS);
			expect(spy).not.toHaveBeenCalledWith(expect.stringContaining("Pasted properties into"));
			expect(fileCache[target.path].frontmatter).toEqual({ title: "T" });
		});

		it("hasClipboardContent reflects effectively-empty clipboard values", () => {
			const { plugin } = createPlugin();
			plugin.clipboard = {};
			expect(plugin.hasClipboardContent()).toBe(false);
			plugin.clipboard = { tags: [] };
			expect(plugin.hasClipboardContent()).toBe(false);
			plugin.clipboard = { tags: [], title: "" };
			expect(plugin.hasClipboardContent()).toBe(false);
			plugin.clipboard = { tags: ["a"] };
			expect(plugin.hasClipboardContent()).toBe(true);
			plugin.clipboard = { tags: [], title: "T" };
			expect(plugin.hasClipboardContent()).toBe(true);
		});

		it("merges clipboard into provided target", async () => {
			const target = new obsidianMock.TFile("dest.md");
			const { plugin, fileCache } = createPlugin();
			await plugin.onload();
			plugin.settings.pasteMode = "merge";
			plugin.clipboard = { tags: ["#a"] };
			fileCache[target.path] = { frontmatter: { tags: ["b"] } };
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteProperties(target);

			expect(fileCache[target.path].frontmatter).toEqual({ tags: ["b", "a"] });
			expect(spy).toHaveBeenCalledWith("Property Porter: Pasted properties into dest");
		});

		it("keeps the clipboard after a paste so it can be pasted again", async () => {
			const t1 = new obsidianMock.TFile("one.md");
			const t2 = new obsidianMock.TFile("two.md");
			const { plugin, fileCache } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { tags: ["a"] };

			await plugin.pasteProperties(t1);
			await plugin.pasteProperties(t2);

			expect(plugin.clipboard).toEqual({ tags: ["a"] });
			expect(fileCache[t1.path].frontmatter).toEqual({ tags: ["a"] });
			expect(fileCache[t2.path].frontmatter).toEqual({ tags: ["a"] });
		});

		it("does not share clipboard array references with pasted notes", async () => {
			const t1 = new obsidianMock.TFile("one.md");
			const t2 = new obsidianMock.TFile("two.md");
			const { plugin, fileCache } = createPlugin();
			await plugin.onload();
			plugin.settings.pasteMode = "overwrite";
			plugin.clipboard = { tags: ["a"] };

			await plugin.pasteProperties(t1);
			await plugin.pasteProperties(t2);
			fileCache[t1.path].frontmatter.tags.push("mutated");

			expect(fileCache[t2.path].frontmatter.tags).toEqual(["a"]);
			expect(plugin.clipboard).toEqual({ tags: ["a"] });
		});

		it("shows notice when no target files exist", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { a: 1 };
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteProperties();

			expect(spy).toHaveBeenCalledWith("Property Porter: No other markdown files found");
		});

		it("uses modal selection when no target provided", async () => {
			const active = new obsidianMock.TFile("active.md");
			const other = new obsidianMock.TFile("other.md");
			const { plugin, fileCache } = createPlugin({
				activeFile: active,
				markdownFiles: [active, other],
			});
			await plugin.onload();
			plugin.clipboard = { tags: ["a"] };
			obsidianMock.SuggestModal.prototype.open = function (this: any) {
				this.onChooseItem(other);
			};

			await plugin.pasteProperties();

			expect(fileCache[other.path].frontmatter).toEqual({ tags: ["a"] });
		});
	});

	describe("pasteIntoActive", () => {
		it("shows notice when no active file", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteIntoActive();

			expect(spy).toHaveBeenCalledWith("Property Porter: No active file");
		});

		it("pastes into active file", async () => {
			const active = new obsidianMock.TFile("active.md");
			const { plugin, fileCache } = createPlugin({ activeFile: active });
			await plugin.onload();
			plugin.clipboard = { status: "done" };

			await plugin.pasteIntoActive();

			expect(fileCache[active.path].frontmatter).toEqual({ status: "done" });
		});
	});

	describe("pasteIntoActiveTabGroup", () => {
		it("shows notice when clipboard is empty", async () => {
			const active = new obsidianMock.TFile("active.md");
			const { plugin } = createPlugin({
				leaves: [{ file: active, group: "g1" }],
			});
			await plugin.onload();
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteIntoActiveTabGroup();

			expect(spy).toHaveBeenCalledWith(NOTICE_NO_PROPERTIES_TO_PASTE, NOTICE_TIMEOUT_MS);
		});

		it("shows notice when the active tab group has no open files", async () => {
			const { plugin } = createPlugin({
				leaves: [],
			});
			await plugin.onload();
			plugin.clipboard = { tags: ["a"] };
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteIntoActiveTabGroup();

			expect(spy).toHaveBeenCalledWith(
				"Property Porter: No markdown files in the active tab group"
			);
		});

		it("pastes into every file in the active tab group", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const other = new obsidianMock.TFile("other.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
					{ file: other, group: "g2" },
				],
			});
			await plugin.onload();
			plugin.clipboard = { tags: ["a"] };

			await plugin.pasteIntoActiveTabGroup();

			expect(fileCache[f1.path].frontmatter).toEqual({ tags: ["a"] });
			expect(fileCache[f2.path].frontmatter).toEqual({ tags: ["a"] });
			expect(fileCache[other.path]).toBeUndefined();
		});

		it("shows exactly one summary notice and keeps the clipboard", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const { plugin } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
				],
			});
			await plugin.onload();
			plugin.clipboard = { tags: ["a"] };
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteIntoActiveTabGroup();

			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith("Property Porter: Pasted properties into 2 notes");
			expect(plugin.clipboard).toEqual({ tags: ["a"] });
		});

		it("does not paste into duplicates of the same file in the group", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f1, group: "g1" },
				],
			});
			await plugin.onload();
			plugin.clipboard = { tags: ["a"] };

			await plugin.pasteIntoActiveTabGroup();

			expect(fileCache[f1.path].frontmatter).toEqual({ tags: ["a"] });
		});
	});

	describe("copyPropertiesFromActiveTabGroup", () => {
		it("shows notice when the active tab group has no open files", async () => {
			const { plugin } = createPlugin({ leaves: [] });
			await plugin.onload();
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyPropertiesFromActiveTabGroup();

			expect(spy).toHaveBeenCalledWith(
				"Property Porter: No markdown files in the active tab group"
			);
		});

		it("unions list properties across the group and keeps first scalar", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const other = new obsidianMock.TFile("other.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
					{ file: other, group: "g2" },
				],
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "tags, status";
			fileCache[f1.path] = { frontmatter: { tags: ["x"], status: "one" } };
			fileCache[f2.path] = { frontmatter: { tags: ["y", "x"], status: "two" } };

			await plugin.copyPropertiesFromActiveTabGroup();

			// tags union across the group (f1, f2); "other" is a different group
			// and must be excluded. status is a scalar, so the first note wins.
			expect(plugin.clipboard).toEqual({
				tags: ["x", "y"],
				status: "one",
			});
		});

		it("does not read duplicates of the same file in the group twice", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f1, group: "g1" },
				],
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "tags";
			fileCache[f1.path] = { frontmatter: { tags: ["x"] } };

			await plugin.copyPropertiesFromActiveTabGroup();

			expect(plugin.clipboard).toEqual({ tags: ["x"] });
		});
	});

	describe("pickTargetFile", () => {
		it("returns null when no other markdown files", async () => {
			const active = new obsidianMock.TFile("active.md");
			const { plugin } = createPlugin({
				activeFile: active,
				markdownFiles: [active],
			});
			const spy = vi.spyOn(obsidianMock, "Notice");

			const result = await plugin.pickTargetFile();

			expect(result).toBeNull();
			expect(spy).toHaveBeenCalledWith("Property Porter: No other markdown files found");
		});

		it("opens modal and returns selected file", async () => {
			const active = new obsidianMock.TFile("active.md");
			const other = new obsidianMock.TFile("other.md");
			const { plugin } = createPlugin({
				activeFile: active,
				markdownFiles: [active, other],
			});
			obsidianMock.SuggestModal.prototype.open = function (this: any) {
				this.onChooseItem(other);
			};

			const result = await plugin.pickTargetFile();

			expect(result).toBe(other);
		});
	});

	describe("delegated helpers", () => {
		it("mergeFrontmatter delegates to frontmatter helper", () => {
			const { plugin } = createPlugin();
			plugin.settings.pasteMode = "skip";

			const result = plugin.mergeFrontmatter({ a: 1, b: 2 }, { a: 3, c: 4 });

			expect(result).toEqual({ a: 3, b: 2, c: 4 });
		});

		it("throws when extracted helpers are called on the plugin", () => {
			const { plugin } = createPlugin();

			expect(() => plugin.deepMerge({}, {})).toThrow("deepMerge is extracted");
			expect(() => plugin.mergeArrays([], [])).toThrow("mergeArrays is extracted");
			expect(() => plugin.normalizeArrayItems([])).toThrow(
				"normalizeArrayItems is extracted"
			);
		});
	});
});

describe("FileSuggestModal", () => {
	it("lists all candidate files", () => {
		const files = [new obsidianMock.TFile("a.md"), new obsidianMock.TFile("notes/b.md")];
		const modal = new FileSuggestModal(new obsidianMock.App(), files, () => {});

		expect(modal.getItems()).toEqual(files);
	});

	it("uses the file path as the suggestion text", () => {
		const file = new obsidianMock.TFile("folder/note.md");
		const modal = new FileSuggestModal(new obsidianMock.App(), [], vi.fn());

		expect(modal.getItemText(file)).toBe(file.path);
	});

	it("invokes callback when suggestion is chosen", () => {
		const file = new obsidianMock.TFile("x.md");
		const onSelect = vi.fn();
		const modal = new FileSuggestModal(new obsidianMock.App(), [file], onSelect);

		modal.onChooseItem(file);

		expect(onSelect).toHaveBeenCalledWith(file);
	});

	it("registers Emacs motion keys on open", () => {
		const file = new obsidianMock.TFile("x.md");
		const modal = new FileSuggestModal(new obsidianMock.App(), [file], () => {});

		modal.onOpen();

		expect(modal.scope.register).toHaveBeenCalled();
		const calls = modal.scope.register.mock.calls;
		const keys = calls.map((c) => c[1]);
		expect(keys).toContain("N");
		expect(keys).toContain("P");
		expect(keys).toContain("A");
		expect(keys).toContain("E");
		expect(keys).toContain("F");
		expect(keys).toContain("B");
	});

	it("prioritizes note basename over folder path when suggesting files", () => {
		const file1 = new obsidianMock.TFile("archive/meeting/unrelated.md");
		const file2 = new obsidianMock.TFile("work/meeting.md");
		const modal = new FileSuggestModal(new obsidianMock.App(), [file1, file2], vi.fn());

		const suggestions = modal.getSuggestions("meeting");
		expect(suggestions.length).toBe(2);
		expect(suggestions[0].item).toBe(file2);
		expect(suggestions[1].item).toBe(file1);
	});
});

describe("registerEmacsMotionKeys", () => {
	function createMockModal() {
		const inputEl = document.createElement("input");
		const scope = {
			register: vi.fn(),
		};
		const chooser = {
			selectedItem: 0,
			values: ["a", "b", "c"],
			setSelectedItem: vi.fn(),
		};
		return { inputEl, scope, chooser };
	}

	it("registers Ctrl+N to move selection down", () => {
		const { inputEl, scope, chooser } = createMockModal();
		const modal = { inputEl, scope, chooser } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlNCall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "N");
		expect(ctrlNCall).toBeDefined();
		ctrlNCall[2](new KeyboardEvent("keydown"));
		expect(chooser.setSelectedItem).toHaveBeenCalledWith(1);
	});

	it("falls back to assigning selectedItem safely if chooser.setSelectedItem throws", () => {
		const { inputEl, scope, chooser } = createMockModal();
		chooser.setSelectedItem = vi.fn().mockImplementation(() => {
			throw new TypeError("t.instanceOf is not a function");
		});
		const modal = { inputEl, scope, chooser } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlNCall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "N");
		expect(() => ctrlNCall[2](new KeyboardEvent("keydown"))).not.toThrow();
		expect(chooser.selectedItem).toBe(1);
	});

	it("registers Ctrl+P to move selection up", () => {
		const { inputEl, scope, chooser } = createMockModal();
		chooser.selectedItem = 1;
		const modal = { inputEl, scope, chooser } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlPCall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "P");
		expect(ctrlPCall).toBeDefined();
		ctrlPCall[2](new KeyboardEvent("keydown"));
		expect(chooser.setSelectedItem).toHaveBeenCalledWith(0);
	});

	it("does not move selection down past the last item", () => {
		const { inputEl, scope, chooser } = createMockModal();
		chooser.selectedItem = 2;
		chooser.values = ["a", "b", "c"];
		const modal = { inputEl, scope, chooser } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlNCall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "N");
		ctrlNCall[2](new KeyboardEvent("keydown"));
		expect(chooser.setSelectedItem).not.toHaveBeenCalled();
	});

	it("does not move selection up past the first item", () => {
		const { inputEl, scope, chooser } = createMockModal();
		chooser.selectedItem = 0;
		const modal = { inputEl, scope, chooser } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlPCall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "P");
		ctrlPCall[2](new KeyboardEvent("keydown"));
		expect(chooser.setSelectedItem).not.toHaveBeenCalled();
	});

	it("registers Ctrl+A to move cursor to start of input", () => {
		const { inputEl, scope } = createMockModal();
		inputEl.value = "hello";
		inputEl.setSelectionRange(5, 5);
		const modal = { inputEl, scope } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlACall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "A");
		ctrlACall[2](new KeyboardEvent("keydown"));
		expect(inputEl.selectionStart).toBe(0);
		expect(inputEl.selectionEnd).toBe(0);
	});

	it("registers Ctrl+E to move cursor to end of input", () => {
		const { inputEl, scope } = createMockModal();
		inputEl.value = "hello";
		inputEl.setSelectionRange(0, 0);
		const modal = { inputEl, scope } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlECall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "E");
		ctrlECall[2](new KeyboardEvent("keydown"));
		expect(inputEl.selectionStart).toBe(5);
		expect(inputEl.selectionEnd).toBe(5);
	});

	it("registers Ctrl+F to move cursor right", () => {
		const { inputEl, scope } = createMockModal();
		inputEl.value = "hello";
		inputEl.setSelectionRange(0, 0);
		const modal = { inputEl, scope } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlFCall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "F");
		ctrlFCall[2](new KeyboardEvent("keydown"));
		expect(inputEl.selectionStart).toBe(1);
		expect(inputEl.selectionEnd).toBe(1);
	});

	it("registers Ctrl+B to move cursor left", () => {
		const { inputEl, scope } = createMockModal();
		inputEl.value = "hello";
		inputEl.setSelectionRange(3, 3);
		const modal = { inputEl, scope } as unknown as obsidianMock.SuggestModal<unknown>;

		registerEmacsMotionKeys(modal);

		const ctrlBCall = scope.register.mock.calls.find((c) => c[0][0] === "Ctrl" && c[1] === "B");
		ctrlBCall[2](new KeyboardEvent("keydown"));
		expect(inputEl.selectionStart).toBe(2);
		expect(inputEl.selectionEnd).toBe(2);
	});
});

describe("MultiSelectSuggestModal", () => {
	it("wraps the shared picker and normalizes initial clipboard tags", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"#",
			() => {},
			() => {},
			["#alpha", "alpha"]
		);
		modal.onOpen();

		expect(modal.inputEl.classList.contains("commons-property-picker-input")).toBe(true);
		expect(modal.getSelectedValues()).toEqual(["alpha"]);
		expect(modal.contentEl.querySelectorAll(".commons-property-picker-chip")).toHaveLength(1);
		expect(modal.contentEl.querySelector(".pp-finish-button").textContent).toBe(
			"Finish selection (1)"
		);
	});

	it("adds known tags through the shared input suggester", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"#",
			() => {},
			() => {}
		);
		modal.onOpen();

		selectInputSuggestion(modal.inputEl, "al", "alpha");

		expect(modal.getSelectedValues()).toEqual(["alpha"]);
		expect(
			modal.contentEl.querySelector(".commons-property-picker-chip").textContent
		).toContain("alpha");
	});

	it("offers an explicitly confirmed create option for unknown tags", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"#",
			() => {},
			() => {}
		);
		modal.onOpen();

		const suggester = getInputSuggest(modal.inputEl);
		const createOption = suggester
			.suggestions("brand-new")
			.find((candidate: any) => candidate.kind === "create");
		const suggestionEl = obsidianMock.decorateEl(document.createElement("div"));
		suggester.renderSuggestion(createOption, suggestionEl);

		expect(createOption.value).toBe("brand-new");
		expect(suggestionEl.textContent).toContain("Create new tag");
		expect(suggestionEl.textContent).toContain("#brand-new");
	});

	it("deduplicates normalized additions and supports clearing all selected tags", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"#",
			() => {},
			() => {}
		);
		modal.onOpen();
		modal.addValue("#alpha");
		modal.addValue("alpha");

		expect(modal.getSelectedValues()).toEqual(["alpha"]);
		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true })
		);
		expect(modal.getSelectedValues()).toEqual([]);
	});

	it("finishes on empty Enter only when there is a selection", () => {
		const onSubmit = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"#",
			onSubmit,
			() => {}
		);
		modal.onOpen();

		modal.inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(onSubmit).not.toHaveBeenCalled();

		modal.addValue("alpha");
		modal.inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(onSubmit).toHaveBeenCalledWith(["alpha"]);
	});

	it("Clear all followed by Finish submits an empty selection", () => {
		const onSubmit = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"#",
			onSubmit,
			() => {},
			["alpha"]
		);
		modal.onOpen();
		modal.contentEl.querySelector(".pp-clear-all-button").click();
		expect(modal.getSelectedValues()).toEqual([]);

		modal.contentEl.querySelector(".pp-finish-button").click();
		expect(onSubmit).toHaveBeenCalledWith([]);
	});

	it("cancels on close but does not cancel after submission", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const cancelled = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"#",
			onSubmit,
			onCancel
		);
		cancelled.onOpen();
		cancelled.close();
		expect(onCancel).toHaveBeenCalledTimes(1);

		const submitted = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"#",
			onSubmit,
			onCancel
		);
		submitted.onOpen();
		submitted.addValue("alpha");
		submitted.submit();
		expect(onSubmit).toHaveBeenCalledWith(["alpha"]);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});

describe("selectTagsToPaste", () => {
	it("collects known frontmatter tags across the vault", () => {
		const f1 = new obsidianMock.TFile("a.md");
		const f2 = new obsidianMock.TFile("b.md");
		const { plugin, fileCache } = createPlugin({
			markdownFiles: [f1, f2],
		});
		fileCache[f1.path] = { frontmatter: { tags: ["alpha", "#beta"] } };
		fileCache[f2.path] = { frontmatter: { tags: ["beta", "gamma"] } };

		const tags = plugin.getKnownTagsForPicking();

		expect(tags).toEqual(["alpha", "beta", "gamma"]);
	});

	it("also picks up inline #tags written in the note body, via Obsidian's getAllTags", () => {
		const f1 = new obsidianMock.TFile("a.md");
		const { plugin, fileCache } = createPlugin({
			markdownFiles: [f1],
		});
		fileCache[f1.path] = {
			frontmatter: { tags: ["alpha"] },
			tags: [{ tag: "#inline-only" }],
		};

		const tags = plugin.getKnownTagsForPicking();

		expect(tags).toEqual(["alpha", "inline-only"]);
	});

	it("supports the singular 'tag' frontmatter key alias", () => {
		const f1 = new obsidianMock.TFile("a.md");
		const { plugin, fileCache } = createPlugin({
			markdownFiles: [f1],
		});
		fileCache[f1.path] = { frontmatter: { tag: "solo" } };

		const tags = plugin.getKnownTagsForPicking();

		expect(tags).toEqual(["solo"]);
	});

	it("sorts known tags case-insensitively", () => {
		const f1 = new obsidianMock.TFile("a.md");
		const { plugin, fileCache } = createPlugin({
			markdownFiles: [f1],
		});
		fileCache[f1.path] = {
			frontmatter: { tags: ["King-County", "Seattle", "a", "archive"] },
		};

		const tags = plugin.getKnownTagsForPicking();

		expect(tags).toEqual(["a", "archive", "King-County", "Seattle"]);
	});

	it("opens and selects tags even when onlyInclude is configured for other properties", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.settings.onlyInclude = "status, title";

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			this.addValue("urgent");
			this.submit();
		};

		await plugin.selectTagsToPaste();
		expect(plugin.clipboard).toEqual({ tags: ["urgent"] });
	});

	it("sets clipboard from selected tags and shows notice", async () => {
		const file = new obsidianMock.TFile("a.md");
		const { plugin, fileCache } = createPlugin({
			markdownFiles: [file],
		});
		await plugin.onload();
		fileCache[file.path] = { frontmatter: { tags: ["x", "y", "z"] } };
		plugin.settings.onlyInclude = "tags";

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			this.addValue("x");
			this.addValue("z");
			this.submit();
		};

		const spy = vi.spyOn(obsidianMock, "Notice");
		await plugin.selectTagsToPaste();

		expect(plugin.clipboard).toEqual({ tags: ["x", "z"] });
		expect(plugin.statusBarItem.textContent).toBe("PP: 2");
		expect(spy).toHaveBeenCalledWith(expect.stringContaining("2 tags ready to paste"));
	});

	it("does not change clipboard when user closes without selecting (true cancel)", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.settings.onlyInclude = "tags";
		plugin.clipboard = { existing: 1 };

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			this.onClose();
		};

		const spy = vi.spyOn(obsidianMock, "Notice");
		await plugin.selectTagsToPaste();

		expect(plugin.clipboard).toEqual({ existing: 1 });
		expect(spy).not.toHaveBeenCalled();
	});

	it("warns explicitly and clears clipboard tags when Finish selection is clicked with nothing selected", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.settings.onlyInclude = "tags";
		plugin.clipboard = { existing: 1 };

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			// Explicit "Finish selection" click with zero tags picked,
			// as opposed to Escape/close (a true cancel). This is how a
			// user clears a previously accumulated selection: load the
			// existing tags, "Clear all", then "Finish selection (0)".
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		const spy = vi.spyOn(obsidianMock, "Notice");
		await plugin.selectTagsToPaste();

		expect(plugin.clipboard).toEqual({ tags: [] });
		expect(spy).toHaveBeenCalledWith(NOTICE_CLEARED_COPIED_TAGS);
	});

	it("Clear all followed by Finish selection empties a previously accumulated clipboard", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.settings.onlyInclude = "tags";
		plugin.clipboard = { tags: ["alpha", "beta"] };

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			// The modal should have been pre-populated from the clipboard.
			expect(this.getSelectedValues()).toEqual(["alpha", "beta"]);
			this.contentEl.querySelector(".pp-clear-all-button").click();
			expect(this.getSelectedValues()).toEqual([]);
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.selectTagsToPaste();

		expect(plugin.clipboard).toEqual({ tags: [] });
		expect(plugin.hasClipboardContent()).toBe(false);
	});

	it("end-to-end: selecting tags via real DOM clicks and pasting them via pasteIntoActive", async () => {
		const active = new obsidianMock.TFile("active.md");
		const { plugin, fileCache } = createPlugin({
			activeFile: active,
			markdownFiles: [active],
		});
		await plugin.onload();
		fileCache[active.path] = { frontmatter: { tags: ["x", "y", "z"] } };
		plugin.settings.onlyInclude = "tags";

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			selectInputSuggestion(this.inputEl, "x", "x");
			selectInputSuggestion(this.inputEl, "y", "y");

			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.selectTagsToPaste();
		expect(plugin.clipboard).toEqual({ tags: ["x", "y"] });

		await plugin.pasteIntoActive();
		expect(fileCache[active.path].frontmatter).toEqual({
			tags: ["x", "y", "z"],
		});
	});

	it("end-to-end: selecting tags and pasting into another note", async () => {
		const active = new obsidianMock.TFile("active.md");
		const other = new obsidianMock.TFile("other.md");
		const { plugin, fileCache } = createPlugin({
			activeFile: active,
			markdownFiles: [active, other],
		});
		await plugin.onload();
		fileCache[active.path] = { frontmatter: { tags: ["a", "b"] } };
		fileCache[other.path] = { frontmatter: { title: "Other" } };
		plugin.settings.onlyInclude = "tags";

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			this.addValue("a");
			this.submit();
		};

		await plugin.selectTagsToPaste();
		expect(plugin.clipboard).toEqual({ tags: ["a"] });

		await plugin.pasteProperties(other);
		expect(fileCache[other.path].frontmatter).toEqual({
			title: "Other",
			tags: ["a"],
		});
	});

	it("end-to-end: narrowing-down workflow via real keydown events (filter, Enter, filter, Enter, empty Enter to finish)", async () => {
		const active = new obsidianMock.TFile("active.md");
		const { plugin, fileCache } = createPlugin({
			activeFile: active,
			markdownFiles: [active],
		});
		await plugin.onload();
		fileCache[active.path] = {
			frontmatter: { tags: ["alpha", "beta", "gamma", "delta"] },
		};
		plugin.settings.onlyInclude = "tags";

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();

			selectInputSuggestion(this.inputEl, "alpha", "alpha");
			selectInputSuggestion(this.inputEl, "gamma", "gamma");

			this.inputEl.value = "";
			this.inputEl.dispatchEvent(new Event("input"));
			this.inputEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		};

		await plugin.selectTagsToPaste();
		expect(plugin.clipboard).toEqual({ tags: ["alpha", "gamma"] });
	});

	it("closing without submitting (Esc) leaves clipboard unchanged", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.settings.onlyInclude = "tags";
		plugin.clipboard = { existing: 1 };

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			this.addValue("a");
			// Simulate Escape: real Obsidian's Modal.close() runs onClose()
			// without submit() having been called.
			this.close();
		};

		await plugin.selectTagsToPaste();
		expect(plugin.clipboard).toEqual({ existing: 1 });
	});
});

describe("PropertyPorterSettingTab", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("renders property pickers while retaining the persisted string settings", async () => {
		const file = new obsidianMock.TFile("settings.md");
		const { plugin, fileCache } = createPlugin({ markdownFiles: [file] });
		fileCache[file.path] = { frontmatter: { status: "draft", aliases: ["old"] } };
		await plugin.onload();
		plugin.settings.onlyInclude = "tags";
		plugin.settings.excludeKeys = "aliases, created date, modified date";

		const tab = new PropertyPorterSettingTab(plugin.app, plugin);
		const defs = tab.getSettingDefinitions();
		expect(defs).toHaveLength(2);
		expect(defs[0]).toMatchObject({
			type: "group",
			heading: "Property filters (non-tag commands)",
		});
		expect(defs[1]).toMatchObject({
			type: "group",
			heading: "Paste behavior",
		});

		const items = defs.flatMap((d: any) => (d.items ? d.items : [d]));
		const includeDef = items.find((definition) => definition.name === "Only include");
		const excludeDef = items.find((definition) => definition.name === "Exclude keys");
		expect(includeDef.render).toBeTypeOf("function");
		expect(excludeDef.render).toBeTypeOf("function");
		expect(items.find((definition) => definition.name === "Paste mode").control.options).toEqual(
			{
				overwrite: "Overwrite",
				skip: "Skip existing",
				merge: "Merge",
			}
		);

		const includeControl = obsidianMock.decorateEl(document.createElement("div"));
		const excludeControl = obsidianMock.decorateEl(document.createElement("div"));
		includeDef.render({ controlEl: includeControl }, {} as any);
		excludeDef.render({ controlEl: excludeControl }, {} as any);

		expect(includeControl.querySelector(".commons-property-picker")).not.toBeNull();
		expect(excludeControl.querySelector(".commons-property-picker")).not.toBeNull();
		expect(
			includeControl
				.querySelector(".commons-property-picker-input")
				.getAttribute("aria-label")
		).toBe("Only include properties");
		expect(plugin.settings.onlyInclude).toBe("tags");
		expect(plugin.settings.excludeKeys).toBe("aliases, created date, modified date");
	});

	it("persists picker changes and disables Exclude keys until Only include is empty", async () => {
		const file = new obsidianMock.TFile("settings.md");
		const { plugin, fileCache } = createPlugin({ markdownFiles: [file] });
		fileCache[file.path] = { frontmatter: { status: "draft" } };
		await plugin.onload();
		plugin.settings.onlyInclude = "";

		const tab = new PropertyPorterSettingTab(plugin.app, plugin);
		const defs = tab.getSettingDefinitions();
		const items = defs.flatMap((d: any) => (d.items ? d.items : [d]));
		const includeControl = obsidianMock.decorateEl(document.createElement("div"));
		const excludeControl = obsidianMock.decorateEl(document.createElement("div"));
		items.find((definition) => definition.name === "Only include").render(
			{ controlEl: includeControl },
			{} as any
		);
		items.find((definition) => definition.name === "Exclude keys").render(
			{ controlEl: excludeControl },
			{} as any
		);
		const input = includeControl.querySelector(".commons-property-picker-input");
		const excludeFieldset = excludeControl.querySelector("fieldset");
		expect(excludeFieldset.disabled).toBe(false);

		selectInputSuggestion(input, "status", "status");
		expect(plugin.settings.onlyInclude).toBe("status");
		expect(excludeFieldset.disabled).toBe(true);

		includeControl.querySelector(".commons-property-picker-remove").click();
		expect(plugin.settings.onlyInclude).toBe("");
		expect(excludeFieldset.disabled).toBe(false);
	});
});
