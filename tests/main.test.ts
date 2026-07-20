// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as obsidianMock from "obsidian";
import PropertyPorter, {
	SuggestFilesModal,
	PropertyPorterSettingTab,
	MultiSelectSuggestModal,
} from "../src/main";

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
			getFileCache: (file: obsidianMock.TFile) =>
				fileCache[file.path] ?? null,
		},
		vault: { getMarkdownFiles: () => markdownFiles },
		fileManager: {
			processFrontMatter: async (
				file: obsidianMock.TFile,
				processor: (fm: any) => void
			) => {
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
			expect(addCommand).toHaveBeenCalledTimes(8);
			expect(addSettingTab).toHaveBeenCalledWith(
				expect.any(PropertyPorterSettingTab)
			);
		});

		it("registered command callbacks delegate to plugin methods", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const run = (id: string) => {
				const call = addCommand.mock.calls.find((c) => c[0].id === id);
				return call?.[0].callback();
			};

			const copyProperties = vi
				.spyOn(plugin, "copyProperties")
				.mockResolvedValue();
			const pasteProperties = vi
				.spyOn(plugin, "pasteProperties")
				.mockResolvedValue();
			const pasteIntoActive = vi
				.spyOn(plugin, "pasteIntoActive")
				.mockResolvedValue();
			const clearClipboard = vi.spyOn(plugin, "clearClipboard");

			await run("copy-properties");
			expect(copyProperties).toHaveBeenCalled();

			await run("paste-properties");
			expect(pasteProperties).toHaveBeenCalledWith();

			await run("paste-into-active");
			expect(pasteIntoActive).toHaveBeenCalled();

			run("clear-clipboard");
			expect(clearClipboard).toHaveBeenCalled();

			const selectTagsToPaste = vi
				.spyOn(plugin, "selectTagsToPaste")
				.mockResolvedValue();
			await run("select-tags-to-paste");
			expect(selectTagsToPaste).toHaveBeenCalled();
		});

		it("registers the clear command with a discoverable 'Clear properties' name", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const call = addCommand.mock.calls.find(
				(c) => c[0].id === "clear-clipboard"
			);
			expect(call?.[0].name).toBe("Clear properties");
		});

		it("registers the tag-picker command with an accurate 'Select tags to paste' name, not the misleading 'properties' wording", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const call = addCommand.mock.calls.find(
				(c) => c[0].id === "select-tags-to-paste"
			);
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
			expect(plugin.settings.excludeKeys).toBe(
				"aliases, created date, modified date"
			);
			expect(plugin.settings.autoClear).toBe(false);
		});

		it("persists settings and refreshes status bar", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			const saveData = vi
				.spyOn(plugin, "saveData")
				.mockResolvedValue(undefined);
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
			expect(spy).toHaveBeenCalledWith(
				"Property Porter: 2 properties copied"
			);
		});

		it("uses singular wording when exactly one value is copied", async () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin, fileCache } = createPlugin({ activeFile: file });
			await plugin.onload();
			fileCache[file.path] = { frontmatter: { tags: ["solo"] } };
			plugin.settings.onlyInclude = "tags";
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyProperties();

			expect(spy).toHaveBeenCalledWith(
				"Property Porter: 1 property copied"
			);
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
			expect(spy).toHaveBeenCalledWith(
				"Property Porter: 4 properties copied"
			);
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

			expect(spy).toHaveBeenCalledWith(
				"Property Porter: 0 properties copied"
			);
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
			obsidianMock.FuzzySuggestModal.prototype.open = function (this: any) {
				this.onChooseItem(source);
			};
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.copyPropertiesFrom();

			expect(plugin.clipboard).toEqual({ status: "from-source" });
			expect(spy).toHaveBeenCalledWith(
				"Property Porter: 1 property copied"
			);
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
			expect(spy).toHaveBeenCalledWith(
				"Property Porter: No other markdown files found"
			);
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

			expect(spy).toHaveBeenCalledWith("Property Porter: Clipboard is empty");
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

			expect(spy).toHaveBeenCalledWith("Property Porter: Clipboard is empty");
			expect(spy).not.toHaveBeenCalledWith(
				expect.stringContaining("Pasted properties into")
			);
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
			expect(spy).toHaveBeenCalledWith(
				"Property Porter: Pasted properties into dest"
			);
		});

		it("clears clipboard when autoClear is enabled", async () => {
			const target = new obsidianMock.TFile("dest.md");
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.settings.autoClear = true;
			plugin.clipboard = { tags: ["a"] };

			await plugin.pasteProperties(target);

			expect(plugin.clipboard).toEqual({});
			expect(plugin.statusBarItem.textContent).toBe("");
		});

		it("shows notice when no target files exist", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { a: 1 };
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteProperties();

			expect(spy).toHaveBeenCalledWith(
				"Property Porter: No other markdown files found"
			);
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
			obsidianMock.FuzzySuggestModal.prototype.open = function (this: any) {
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

			expect(spy).toHaveBeenCalledWith(
				"Property Porter: Clipboard is empty"
			);
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
			expect(spy).toHaveBeenCalledWith(
				"Property Porter: No other markdown files found"
			);
		});

		it("opens modal and returns selected file", async () => {
			const active = new obsidianMock.TFile("active.md");
			const other = new obsidianMock.TFile("other.md");
			const { plugin } = createPlugin({
				activeFile: active,
				markdownFiles: [active, other],
			});
			obsidianMock.FuzzySuggestModal.prototype.open = function (this: any) {
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

			const result = plugin.mergeFrontmatter(
				{ a: 1, b: 2 },
				{ a: 3, c: 4 }
			);

			expect(result).toEqual({ a: 3, b: 2, c: 4 });
		});

		it("throws when extracted helpers are called on the plugin", () => {
			const { plugin } = createPlugin();

			expect(() => plugin.deepMerge({}, {})).toThrow(
				"deepMerge is extracted"
			);
			expect(() => plugin.mergeArrays([], [])).toThrow(
				"mergeArrays is extracted"
			);
			expect(() => plugin.normalizeArrayItems([])).toThrow(
				"normalizeArrayItems is extracted"
			);
		});
	});
});

describe("SuggestFilesModal", () => {
	it("lists all candidate files", () => {
		const files = [
			new obsidianMock.TFile("a.md"),
			new obsidianMock.TFile("notes/b.md"),
		];
		const modal = new SuggestFilesModal(
			new obsidianMock.App(),
			files,
			() => {}
		);

		expect(modal.getItems()).toEqual(files);
	});

	it("uses the file path as the suggestion text", () => {
		const file = new obsidianMock.TFile("folder/note.md");
		const modal = new SuggestFilesModal(new obsidianMock.App(), [], vi.fn());

		expect(modal.getItemText(file)).toBe(file.path);
	});

	it("invokes callback when suggestion is chosen", () => {
		const file = new obsidianMock.TFile("x.md");
		const onSelect = vi.fn();
		const modal = new SuggestFilesModal(
			new obsidianMock.App(),
			[file],
			onSelect
		);

		modal.onChooseItem(file);

		expect(onSelect).toHaveBeenCalledWith(file);
	});
});

describe("MultiSelectSuggestModal", () => {
	it("renders input, controls and the full list on open", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			() => {},
			() => {}
		);
		modal.onOpen();

		expect(modal.inputEl).toBeInstanceOf(HTMLInputElement);
		expect(modal.inputEl.placeholder).toContain("Type to filter");
		const items = modal.contentEl.querySelectorAll(".pp-multi-select-item");
		expect(items.length).toBe(2);
		expect(items[0].textContent).toBe("alpha");
		expect(items[1].textContent).toBe("beta");
		const button = modal.contentEl.querySelector(".pp-finish-button");
		expect(button.textContent).toBe("Finish selection (0)");
	});

	it("filters the list as the user types", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta", "gamma"],
			"",
			() => {},
			() => {}
		);
		modal.onOpen();

		modal.inputEl.value = "ga";
		modal.inputEl.dispatchEvent(new Event("input"));

		const items = modal.contentEl.querySelectorAll(".pp-multi-select-item");
		expect(items.length).toBe(1);
		expect(items[0].textContent).toBe("gamma");
	});

	it("ranks exact match first, then prefix matches, then substring matches", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["King-County", "Seattle", "a", "ai-generated", "archive"],
			"",
			() => {},
			() => {}
		);
		modal.onOpen();

		modal.inputEl.value = "a";
		modal.inputEl.dispatchEvent(new Event("input"));

		const items = Array.from(
			modal.contentEl.querySelectorAll(".pp-multi-select-item")
		).map((el: any) => el.textContent);
		// "a" is an exact match and must rank first, even though "Seattle"
		// contains "a" and would otherwise sort earlier alphabetically.
		// "King-County" has no "a" in it at all and is correctly excluded.
		expect(items[0]).toBe("a");
		expect(items).toEqual(["a", "ai-generated", "archive", "Seattle"]);
	});

	it("Enter selects the exact match, not an earlier substring match", () => {
		const onSubmit = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["Seattle", "a"],
			"",
			onSubmit,
			() => {}
		);
		modal.onOpen();

		modal.inputEl.value = "a";
		modal.inputEl.dispatchEvent(new Event("input"));
		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter" })
		);

		expect(modal.getSelectedValues()).toEqual(["a"]);
	});

	it("clicking an item adds it, clears the input, and removes it from the list", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			() => {},
			() => {}
		);
		modal.onOpen();
		modal.inputEl.value = "al";
		modal.inputEl.dispatchEvent(new Event("input"));

		const item = modal.contentEl.querySelector(".pp-multi-select-item");
		item.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, cancelable: true })
		);

		expect(modal.getSelectedValues()).toEqual(["alpha"]);
		expect(modal.inputEl.value).toBe("");
		const remaining = modal.contentEl.querySelectorAll(
			".pp-multi-select-item"
		);
		expect(remaining.length).toBe(1);
		expect(remaining[0].textContent).toBe("beta");
	});

	it("chips display selected items with a prefix and support removal", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"#",
			() => {},
			() => {}
		);
		modal.onOpen();
		modal.addValue("alpha");
		modal.addValue("beta");

		const chips = modal.contentEl.querySelectorAll(".pp-selected-chip");
		expect(chips.length).toBe(2);
		expect(chips[0].textContent.replace(/\s+/g, "")).toBe("#alpha×");
		expect(chips[1].textContent.replace(/\s+/g, "")).toBe("#beta×");

		const label = modal.contentEl.querySelector(".pp-selected-chips-label");
		expect(label.textContent).toBe("2 selected:");

		chips[0]
			.querySelector(".pp-selected-chip-remove")
			.dispatchEvent(new MouseEvent("click", { bubbles: true }));

		expect(modal.getSelectedValues()).toEqual(["beta"]);
	});

	it("Enter on a filtered match adds the top result without submitting", () => {
		const onSubmit = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			onSubmit,
			() => {}
		);
		modal.onOpen();
		modal.inputEl.value = "alpha";
		modal.inputEl.dispatchEvent(new Event("input"));
		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter" })
		);

		expect(modal.getSelectedValues()).toEqual(["alpha"]);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("Enter with an unknown tag adds it verbatim", () => {
		const onSubmit = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			onSubmit,
			() => {}
		);
		modal.onOpen();
		modal.inputEl.value = "brand-new-tag";
		modal.inputEl.dispatchEvent(new Event("input"));
		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter" })
		);

		expect(modal.getSelectedValues()).toEqual(["brand-new-tag"]);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("shows a create-new-tag row when the query matches nothing", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			() => {},
			() => {}
		);
		modal.onOpen();
		modal.inputEl.value = "zzz";
		modal.inputEl.dispatchEvent(new Event("input"));

		const createRow = modal.contentEl.querySelector(".pp-create-item");
		expect(createRow).not.toBeNull();
		expect(createRow.textContent).toBe("Create new tag: zzz");

		createRow.dispatchEvent(
			new MouseEvent("mousedown", { bubbles: true, cancelable: true })
		);
		expect(modal.getSelectedValues()).toEqual(["zzz"]);
	});

	it("Enter with empty input and no selection does nothing", () => {
		const onSubmit = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"",
			onSubmit,
			() => {}
		);
		modal.onOpen();
		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter" })
		);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("Enter with empty input and a selection finishes", () => {
		const onSubmit = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"",
			onSubmit,
			() => {}
		);
		modal.onOpen();
		modal.addValue("alpha");
		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter" })
		);
		expect(onSubmit).toHaveBeenCalledWith(["alpha"]);
	});

	it("Finish selection button submits the current selection", () => {
		const onSubmit = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"",
			onSubmit,
			() => {}
		);
		modal.onOpen();
		modal.addValue("alpha");
		modal.contentEl.querySelector(".pp-finish-button").click();
		expect(onSubmit).toHaveBeenCalledWith(["alpha"]);
	});

	it("ArrowDown/ArrowUp move the active highlight", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta", "gamma"],
			"",
			() => {},
			() => {}
		);
		modal.onOpen();
		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown" })
		);
		let items = modal.contentEl.querySelectorAll(".pp-multi-select-item");
		expect(items[1].classList.contains("is-active")).toBe(true);
		expect(items[0].classList.contains("is-active")).toBe(false);

		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowUp" })
		);
		items = modal.contentEl.querySelectorAll(".pp-multi-select-item");
		expect(items[0].classList.contains("is-active")).toBe(true);
	});

	it("pre-populates chips and excludes initial selections from the list", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta", "gamma"],
			"",
			() => {},
			() => {},
			["alpha", "gamma"]
		);
		modal.onOpen();

		expect(modal.getSelectedValues()).toEqual(["alpha", "gamma"]);
		const chips = modal.contentEl.querySelectorAll(".pp-selected-chip");
		expect(chips.length).toBe(2);
		const items = modal.contentEl.querySelectorAll(".pp-multi-select-item");
		expect(items.length).toBe(1);
		expect(items[0].textContent).toBe("beta");
	});

	it("dedupes duplicate initial selections", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"",
			() => {},
			() => {},
			["alpha", "alpha"]
		);
		modal.onOpen();
		expect(modal.getSelectedValues()).toEqual(["alpha"]);
	});

	it("Clear all button removes every selected chip and disables itself when empty", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			() => {},
			() => {},
			["alpha", "beta"]
		);
		modal.onOpen();

		const clearButton = modal.contentEl.querySelector(
			".pp-clear-all-button"
		) as HTMLButtonElement;
		expect(clearButton.disabled).toBe(false);

		clearButton.click();

		expect(modal.getSelectedValues()).toEqual([]);
		expect(
			modal.contentEl.querySelectorAll(".pp-selected-chip").length
		).toBe(0);
		expect(clearButton.disabled).toBe(true);
	});

	it("Clear all button is disabled when nothing is selected initially", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"",
			() => {},
			() => {}
		);
		modal.onOpen();
		const clearButton = modal.contentEl.querySelector(
			".pp-clear-all-button"
		) as HTMLButtonElement;
		expect(clearButton.disabled).toBe(true);
	});

	it("Backspace on an empty input removes only the last selected tag", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			() => {},
			() => {},
			["alpha", "beta"]
		);
		modal.onOpen();

		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Backspace" })
		);

		expect(modal.getSelectedValues()).toEqual(["alpha"]);
	});

	it("Ctrl+Backspace on an empty input clears all selected tags", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			() => {},
			() => {},
			["alpha", "beta"]
		);
		modal.onOpen();

		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Backspace", ctrlKey: true })
		);

		expect(modal.getSelectedValues()).toEqual([]);
	});

	it("Backspace with non-empty input does not remove any tag (normal text editing)", () => {
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha", "beta"],
			"",
			() => {},
			() => {},
			["alpha", "beta"]
		);
		modal.onOpen();
		modal.inputEl.value = "x";

		modal.inputEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Backspace" })
		);

		expect(modal.getSelectedValues()).toEqual(["alpha", "beta"]);
	});

	it("onClose invokes onCancel when not submitted", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"",
			onSubmit,
			onCancel
		);
		modal.onOpen();
		modal.addValue("alpha");
		modal.onClose();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("submit closes the modal without invoking onCancel", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const modal = new MultiSelectSuggestModal(
			new obsidianMock.App(),
			["alpha"],
			"",
			onSubmit,
			onCancel
		);
		modal.onOpen();
		modal.addValue("alpha");
		modal.submit();
		expect(onSubmit).toHaveBeenCalledWith(["alpha"]);
		expect(onCancel).not.toHaveBeenCalled();
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

	it("warns and does nothing when onlyInclude is not exactly 'tags'", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.settings.onlyInclude = "status";
		const spy = vi.spyOn(obsidianMock, "Notice");

		await plugin.selectTagsToPaste();

		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining("'Only include' to be exactly 'tags'")
		);
		expect(plugin.clipboard).toEqual({});
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
		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining("2 tags ready to paste")
		);
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
		expect(spy).toHaveBeenCalledWith(
			"Property Porter: No tags selected. Cleared tags from clipboard."
		);
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
			const items = this.contentEl.querySelectorAll(
				".pp-multi-select-item"
			);
			const byText = (text: string) =>
				Array.from(items).find((el: any) => el.textContent === text);
			byText("x").dispatchEvent(
				new MouseEvent("mousedown", { bubbles: true, cancelable: true })
			);
			const remaining = this.contentEl.querySelectorAll(
				".pp-multi-select-item"
			);
			Array.from(remaining)
				.find((el: any) => el.textContent === "y")
				?.dispatchEvent(
					new MouseEvent("mousedown", {
						bubbles: true,
						cancelable: true,
					})
				);
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

			this.inputEl.value = "alpha";
			this.inputEl.dispatchEvent(new Event("input"));
			this.inputEl.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter" })
			);

			this.inputEl.value = "gamma";
			this.inputEl.dispatchEvent(new Event("input"));
			this.inputEl.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter" })
			);

			this.inputEl.value = "";
			this.inputEl.dispatchEvent(new Event("input"));
			this.inputEl.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Enter" })
			);
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
		obsidianMock.Setting.clearInstances();
		vi.restoreAllMocks();
	});

	it("displays settings and propagates changes", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		const saveSettings = vi.spyOn(plugin, "saveSettings");

		const tab = new PropertyPorterSettingTab(plugin.app, plugin);
		tab.containerEl = document.createElement("div");
		(tab.containerEl as any).empty = vi.fn();
		tab.display();

		const onlyInclude = obsidianMock.Setting.instances.find(
			(s) => s.name === "Only include"
		);
		(onlyInclude as any).components.text.onChangeFn("tags, status");
		expect(plugin.settings.onlyInclude).toBe("tags, status");
		expect(saveSettings).toHaveBeenCalled();

		const exclude = obsidianMock.Setting.instances.find(
			(s) => s.name === "Exclude keys"
		);
		expect((exclude as any).components.text.disabled).toBe(true);

		const pasteMode = obsidianMock.Setting.instances.find(
			(s) => s.name === "Paste mode"
		);
		(pasteMode as any).components.dropdown.onChangeFn("overwrite");
		expect(plugin.settings.pasteMode).toBe("overwrite");

		const autoClear = obsidianMock.Setting.instances.find(
			(s) =>
				s.name ===
				"Auto-clear clipboard after successful paste"
		);
		(autoClear as any).components.toggle.onChangeFn(true);
		expect(plugin.settings.autoClear).toBe(true);
	});

	it("updates Exclude keys when enabled", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.settings.onlyInclude = "";

		const tab = new PropertyPorterSettingTab(plugin.app, plugin);
		tab.containerEl = document.createElement("div");
		(tab.containerEl as any).empty = vi.fn();
		tab.display();

		const exclude = obsidianMock.Setting.instances.find(
			(s) => s.name === "Exclude keys"
		);
		expect((exclude as any).components.text.disabled).toBe(false);

		(exclude as any).components.text.onChangeFn("aliases");
		expect(plugin.settings.excludeKeys).toBe("aliases");
	});
});



