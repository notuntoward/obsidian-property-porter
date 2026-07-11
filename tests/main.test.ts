// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as obsidianMock from "obsidian";
import PropertyPorter, {
	SuggestFilesModal,
	PropertyPorterSettingTab,
} from "../src/main";

function createApp(options: any = {}) {
	const activeFile = options.activeFile ?? null;
	const markdownFiles = options.markdownFiles ?? [];
	const fileCache: Record<string, any> = options.fileCache ?? {};
	const app = new obsidianMock.App({
		workspace: { getActiveFile: () => activeFile },
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
			expect(addCommand).toHaveBeenCalledTimes(4);
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

		it("copies filtered frontmatter and updates status", async () => {
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
			expect(plugin.statusBarItem.textContent).toBe("PP: 1");
			expect(spy).toHaveBeenCalledWith(
				"Property Porter: 1 properties copied"
			);
		});

		it("does nothing when filtered source is null", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { a: 1 };

			await plugin.copyProperties();

			expect(plugin.clipboard).toEqual({ a: 1 });
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
			obsidianMock.SuggestModal.prototype.open = function (this: any) {
				this.onChooseSuggestion(other);
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
			obsidianMock.SuggestModal.prototype.open = function (this: any) {
				this.onChooseSuggestion(other);
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
	it("filters suggestions by query", () => {
		const files = [
			new obsidianMock.TFile("a.md"),
			new obsidianMock.TFile("notes/b.md"),
		];
		const modal = new SuggestFilesModal(
			new obsidianMock.App(),
			files,
			() => {}
		);

		expect(modal.getSuggestions("a")).toEqual([files[0]]);
		expect(modal.getSuggestions("notes")).toEqual([files[1]]);
		expect(modal.getSuggestions("")).toEqual(files);
	});

	it("renders suggestion with basename and path", () => {
		const file = new obsidianMock.TFile("folder/note.md");
		const modal = new SuggestFilesModal(new obsidianMock.App(), [], vi.fn());
		const el = document.createElement("div");
		(el as any).createEl = vi
			.fn()
			.mockReturnValue(document.createElement("div"));

		modal.renderSuggestion(file, el as any);

		expect((el as any).createEl).toHaveBeenCalledWith("div", {
			text: file.basename,
		});
		expect((el as any).createEl).toHaveBeenCalledWith("small", {
			text: file.path,
		});
	});

	it("invokes callback when suggestion is chosen", () => {
		const file = new obsidianMock.TFile("x.md");
		const onSelect = vi.fn();
		const modal = new SuggestFilesModal(
			new obsidianMock.App(),
			[file],
			onSelect
		);

		modal.onChooseSuggestion(file);

		expect(onSelect).toHaveBeenCalledWith(file);
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
