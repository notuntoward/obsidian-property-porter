// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as obsidianMock from "obsidian";
import { registerEmacsMotionKeys } from "../src/utils/modal";
import PropertyPorter, {
	SourceRepairPermissionModal,
	SuggestFilesModal,
	FileSuggestModal,
	PropertyPorterSettingTab,
	MultiSelectSuggestModal,
	NOTICE_NO_PROPERTIES_TO_PASTE,
	NOTICE_CLEARED_COPIED_TAGS,
	NOTICE_TIMEOUT_MS,
} from "../src/main";
import { parseRawFrontmatter } from "../src/frontmatter";

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
	const fileContents: Record<string, string> = options.fileContents ?? {};

	// Build workspace leaves for the active-tab-group feature. Each entry in
	// `leaves` is { file, group? }; leaves sharing the same `group` value are
	// considered part of the same tab group. The active leaf defaults to leaves[0].
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
			activeLeaf: options.activeLeaf !== undefined ? options.activeLeaf : leaves[0] ?? null,
			iterateAllLeaves: (cb: (leaf: any) => void) => {
				for (const leaf of leaves) cb(leaf);
			},
		},
		metadataCache: {
			getFileCache: (file: obsidianMock.TFile) => fileCache[file.path] ?? null,
		},
		vault: {
			getMarkdownFiles: () => markdownFiles,
			read: async (file: obsidianMock.TFile) => {
				if (fileContents[file.path] !== undefined) return fileContents[file.path];
				const frontmatter = fileCache[file.path]?.frontmatter ?? {};
				const lines = Object.entries(frontmatter)
					.filter(([key]) => key !== "position")
					.flatMap(([key, value]) =>
						Array.isArray(value)
							? [`${key}:`, ...value.map((item) => `  - ${JSON.stringify(item)}`)]
							: [`${key}: ${JSON.stringify(value)}`]
					);
				return `---\n${lines.join("\n")}\n---\n`;
			},
			cachedRead: async (file: obsidianMock.TFile) => fileContents[file.path] ?? "",
			modify: async (file: obsidianMock.TFile, data: string) => {
				fileContents[file.path] = data;
			},
		},
		fileManager: {
			processFrontMatter: async (file: obsidianMock.TFile, processor: (fm: any) => void) => {
				// Like the real app, the "existing" frontmatter comes from the
				// file's raw text when the cache has nothing for it.
				const existing =
					fileCache[file.path]?.frontmatter ??
					parseRawFrontmatter(fileContents[file.path] ?? "").map;
				const fm = { ...existing };
				processor(fm);
				fileCache[file.path] = { frontmatter: fm };
			},
		},
	});
	return { app, activeFile, markdownFiles, fileCache, fileContents };
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
	it("keeps repeated tag sources through copy and paste conflict resolution", async () => {
		const source = new obsidianMock.TFile("source.md");
		const { plugin, fileCache } = createPlugin({
			activeFile: source,
			markdownFiles: [source],
		});
		await plugin.onload();
		plugin.settings.onlyInclude = "";
		plugin.settings.excludeKeys = "";
		fileCache[source.path] = {
			frontmatter: { tags: ["#a", "a", "b"] },
		};

		await plugin.copyProperties();

		let tagNotice = "";
		let tagValues: string[] = [];
		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			const tagsCard = this.contentEl.querySelector(".pp-property-card") as HTMLElement;
			tagNotice = tagsCard.querySelector(".pp-property-notice")?.textContent ?? "";
			tagValues = Array.from(tagsCard.querySelectorAll(".commons-property-picker-chip span:first-child")).map(
				(el) => el.textContent ?? ""
			);
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.selectPropertiesToPaste();

		expect(tagNotice).toContain("source had tags twice with the same value");
		expect(tagValues).toEqual(["a", "b"]);
	});
	let originalSuggestOpen: () => void;

	beforeEach(() => {
		originalSuggestOpen = obsidianMock.SuggestModal.prototype.open;
		obsidianMock.Setting.clearInstances();
		vi.restoreAllMocks();
		vi.spyOn(PropertyPorter.prototype, "confirmSourceRepair").mockResolvedValue(true);
	});

	afterEach(() => {
		obsidianMock.SuggestModal.prototype.open = originalSuggestOpen;
	});

	describe("lifecycle", () => {
		it.each([true, false])("requires explicit source repair permission (%s)", async (allow) => {
			const file = new obsidianMock.TFile("folder/dup.md");
			const original = '---\nx: 1\nx: "1"\n---\nBody\n';
			const { plugin, app, fileContents } = createPlugin({
				activeFile: file, fileContents: { [file.path]: original },
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "";
			plugin.settings.excludeKeys = "";
			vi.mocked(plugin.confirmSourceRepair).mockRestore();
			const modify = vi.spyOn(app.vault, "modify");
			let dialogs = 0;
			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				dialogs++;
				expect(modify).not.toHaveBeenCalled();
				if (this instanceof SourceRepairPermissionModal) {
					expect(this.contentEl.textContent).toContain(file.path);
					const label = allow ? "Repair note and copy" : "Copy only";
					Array.from(this.contentEl.querySelectorAll("button"))
						.find((b: any) => b.textContent === label).click();
				} else {
					const radios = this.contentEl.querySelectorAll<HTMLInputElement>(
						'.pp-conflict-option input[type="radio"]'
					);
					expect(radios[0].value).toBe("1 (number)");
					expect(radios[1].value).toBe("1 (string)");
					radios[1].click();
					this.contentEl.querySelector(".pp-finish-button").click();
				}
			};
			await plugin.copyProperties();
			expect(dialogs).toBe(2);
			expect(plugin.clipboard).toEqual({ x: "1" });
			expect(fileContents[file.path]).toBe(allow ? '---\nx: "1"\n---\nBody\n' : original);
			expect(modify).toHaveBeenCalledTimes(allow ? 1 : 0);
		});

		it("defaults source repair to the focused, primary singular action", () => {
			const { app } = createApp();
			const file = new obsidianMock.TFile("source.md");
			const modal = new SourceRepairPermissionModal(app as any, [file], vi.fn());
			document.body.appendChild(modal.contentEl);

			modal.onOpen();

			const repairButton = modal.contentEl.querySelector<HTMLButtonElement>("button.mod-cta")!;
			expect(repairButton.textContent).toBe("Repair note and copy");
			expect(document.activeElement).toBe(repairButton);
		});

		it("dismisses source repair permission without writing but still copies", async () => {
			const file = new obsidianMock.TFile("dup.md");
			const original = "---\nx: first\nx: second\n---\n";
			const { plugin, fileContents } = createPlugin({
				activeFile: file, fileContents: { [file.path]: original },
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "";
			vi.mocked(plugin.confirmSourceRepair).mockRestore();
			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				if (this instanceof SourceRepairPermissionModal) this.close();
				else {
					this.contentEl.querySelectorAll<HTMLInputElement>('.pp-conflict-option input[type="radio"]')[1].click();
					this.contentEl.querySelector(".pp-finish-button").click();
				}
			};
			await plugin.copyProperties();
			expect(plugin.clipboard).toEqual({ x: "second" });
			expect(fileContents[file.path]).toBe(original);
		});

		it("loads settings, status bar, commands and settings tab on load", async () => {
			const { plugin } = createPlugin();
			const loadSettings = vi.spyOn(plugin, "loadSettings");
			const addCommand = vi.spyOn(plugin, "addCommand");
			const addSettingTab = vi.spyOn(plugin, "addSettingTab");

			await plugin.onload();

			expect(loadSettings).toHaveBeenCalled();
			expect(plugin.statusBarItem).toBeDefined();
			expect(addCommand).toHaveBeenCalledTimes(8);
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

			const editPropertyClipboard = vi.spyOn(plugin, "editPropertyClipboard").mockResolvedValue();
			await run("edit-property-clipboard");
			expect(editPropertyClipboard).toHaveBeenCalled();
		});

		it("registers one combined clipboard editor command", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const call = addCommand.mock.calls.find((c) => c[0].id === "edit-property-clipboard");
			expect(call?.[0].name).toBe("Edit property clipboard");
			expect(addCommand.mock.calls.some((c) => c[0].id === "select-tags-to-paste")).toBe(false);
			expect(addCommand.mock.calls.some((c) => c[0].id === "select-properties-to-paste")).toBe(false);
		});

		it("does not autofocus the first property when editing the clipboard", async () => {
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { title: "A title", tags: ["tag"] };
			const openModal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({ properties: plugin.clipboard, cancelled: false });

			await plugin.editPropertyClipboard();

			expect(openModal).toHaveBeenCalledWith(
				plugin.clipboard,
				expect.any(Object),
				{ title: "Edit property clipboard", focusFirstProperty: false }
			);
		});

		it("registers the clear command with 'Clear properties clipboard' name", async () => {
			const { plugin } = createPlugin();
			const addCommand = vi.spyOn(plugin, "addCommand");
			await plugin.onload();

			const call = addCommand.mock.calls.find((c) => c[0].id === "clear-clipboard");
			expect(call?.[0].name).toBe("Clear properties clipboard");
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

		it("returns parsed frontmatter without position", async () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin, fileCache } = createPlugin();
			fileCache[file.path] = {
				frontmatter: { tags: ["a"], position: { start: { line: 0 } } },
			};

			expect(plugin.getParsedFrontmatter(file)).toEqual({ tags: ["a"] });
		});

		it("returns empty object when no frontmatter", async () => {
			const file = new obsidianMock.TFile("note.md");
			const { plugin } = createPlugin();
			expect(plugin.getParsedFrontmatter(file)).toEqual({});
		});
	});

	describe("copy", () => {
		it("shows notice and returns null when no active file", async () => {
			const { plugin } = createPlugin();
			const spy = vi.spyOn(obsidianMock, "Notice");

			const result = await plugin.getFilteredSourceFrontmatter();

			expect(result).toBeNull();
			expect(spy).toHaveBeenCalledWith("Property Porter: No active file");
		});

		it("filters source frontmatter by settings", async () => {
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

		it("resolves duplicate property keys in the source note before copying", async () => {
			const file = new obsidianMock.TFile("note-six.md");
			// Obsidian's metadata cache can return no frontmatter at all for a
			// note with duplicate keys, so the cache is empty here on purpose.
			const noteText = [
				"---",
				"title: Note Six",
				"tags:",
				"  - a",
				"  - b",
				"modified_date: 2026-10-13T16:58:17",
				"created_date: 2026-08-19T21:26:00",
				"modified_date: 2026-10-13T15:45:00",
				"---",
				"",
				"a# heading 1",
			].join("\n");
			const { plugin, fileContents } = createPlugin({
				activeFile: file,
				markdownFiles: [file],
				fileContents: { [file.path]: noteText },
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "";
			plugin.settings.excludeKeys = "";

			let warningText = "";
			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				const card = Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
					(c: any) => c.querySelector(".pp-property-name")?.textContent === "modified_date"
				) as HTMLElement;
				warningText = card.querySelector(".pp-property-warning")?.textContent ?? "";
					const radios = card.querySelectorAll<HTMLInputElement>('.pp-conflict-option input[type="radio"]');
					expect(radios.length).toBe(3);
					radios[1].click(); // keep the later value
				this.contentEl.querySelector(".pp-finish-button").click();
			};

			await plugin.copyProperties();

			expect(warningText).toBe("Choose which modified_date value to keep.");
			// The note is repaired textually: only the chosen occurrence survives
			// and every other line is preserved.
			expect(fileContents[file.path]).toBe(
				[
					"---",
					"title: Note Six",
					"tags:",
					"  - a",
					"  - b",
					"created_date: 2026-08-19T21:26:00",
					"modified_date: 2026-10-13T15:45:00",
					"---",
					"",
					"a# heading 1",
				].join("\n")
			);
			// The copy is built from the repaired values, not the empty cache.
			expect(plugin.clipboard).toEqual({
				title: "Note Six",
				tags: ["a", "b"],
				modified_date: "2026-10-13T15:45:00",
				created_date: "2026-08-19T21:26:00",
			});
			expect(plugin.clipboardOrigin).toBe("note-six");
		});

		it("leaves the note and clipboard untouched when duplicate resolution is cancelled", async () => {
			const file = new obsidianMock.TFile("note-six.md");
			const noteText = "---\ntitle: T\nmodified_date: 1\nmodified_date: 2\n---\n";
			const { plugin, fileContents } = createPlugin({
				activeFile: file,
				markdownFiles: [file],
				fileContents: { [file.path]: noteText },
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "";

			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				this.close(); // dismissed without finishing
			};

			await plugin.copyProperties();

			expect(plugin.clipboard).toEqual({});
			expect(fileContents[file.path]).toBe(noteText);
		});

		it("removes the property from the note and the copy when the duplicate is cleared", async () => {
			const file = new obsidianMock.TFile("note-six.md");
			const noteText = "---\ntitle: T\nmodified_date: 1\nmodified_date: 2\n---\n";
			const { plugin, fileContents } = createPlugin({
				activeFile: file,
				markdownFiles: [file],
				fileContents: { [file.path]: noteText },
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "";
			plugin.settings.excludeKeys = "";

			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				const card = Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
					(c: any) => c.querySelector(".pp-property-name")?.textContent === "modified_date"
				) as HTMLElement;
				void card;
				// Exclude only the duplicate property, preserving the rest of
				// the source properties selected for the clipboard.
				card.querySelector(".pp-property-remove-btn").click();
				this.contentEl.querySelector(".pp-finish-button").click();
			};

			await plugin.copyProperties();

			expect(fileContents[file.path]).toBe("---\ntitle: T\n---\n");
			expect(plugin.clipboard).toEqual({ title: "T" });
		});

		it("shows a notice for identical duplicate values without a conflict", async () => {
			const file = new obsidianMock.TFile("same.md");
			const noteText = "---\nstatus: draft\nstatus: draft\n---\n";
			const { plugin } = createPlugin({
				activeFile: file,
				markdownFiles: [file],
				fileContents: { [file.path]: noteText },
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "";

			let noticeText = "";
			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				const card = Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
					(c: any) => c.querySelector(".pp-property-name")?.textContent === "status"
				) as HTMLElement;
				noticeText = card.querySelector(".pp-property-notice")?.textContent ?? "";
				expect(card.querySelector(".pp-property-warning")).toBeNull();
				expect(card.querySelectorAll(".pp-option-pill")).toHaveLength(0);
				this.contentEl.querySelector(".pp-finish-button").click();
			};

			await plugin.copyProperties();

			expect(noticeText).toContain("same had status twice with the same value");
			expect(plugin.clipboard).toEqual({ status: "draft" });
		});

		it("resolves each note's duplicates independently in a tab-group copy", async () => {
			const f1 = new obsidianMock.TFile("one.md");
			const f2 = new obsidianMock.TFile("two.md");
			const { plugin, fileContents } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
				],
				fileContents: {
					[f1.path]: "---\nstatus: one-a\nstatus: one-b\n---\n",
					[f2.path]: "---\nstatus: two-a\nstatus: two-b\n---\n",
				},
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "";
			plugin.settings.excludeKeys = "";

			// First modal is note one's duplicate, second is note two's.
			let modalIndex = 0;
			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				modalIndex++;
				const card = Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
					(c: any) => c.querySelector(".pp-property-name")?.textContent === "status"
				) as HTMLElement;
				// The first two modals resolve each note's duplicates; the third
				// resolves the union's scalar collision with cross-note wording.
				if (modalIndex <= 2) {
					expect(card.querySelector(".pp-property-warning")?.textContent).toBe(
						"Choose which status value to keep."
					);
				}
				const radios = card.querySelectorAll<HTMLInputElement>('.pp-conflict-option input[type="radio"]');
				radios[modalIndex === 1 ? 1 : 0].click();
				this.contentEl.querySelector(".pp-finish-button").click();
			};

			await plugin.copyPropertiesFromActiveTabGroup();

			// Each note keeps its own choice; the union resolves the remaining
			// scalar collision in a third modal.
			expect(fileContents[f1.path]).toBe("---\nstatus: one-b\n---\n");
			expect(fileContents[f2.path]).toBe("---\nstatus: two-a\n---\n");
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
				expect(this).toBeInstanceOf(SuggestFilesModal);
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
		it("uses current file contents instead of stale metadata cache for merge conflicts", async () => {
			const target = new obsidianMock.TFile("target.md");
			const { plugin, fileCache } = createPlugin({
				markdownFiles: [target],
				fileContents: { [target.path]: "---\nstatus: current-target\n---\n" },
			});
			await plugin.onload();
			fileCache[target.path] = { frontmatter: { status: "clipboard-value" } };
			plugin.clipboard = { status: "clipboard-value" };
			plugin.settings.onlyInclude = "";
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({
					properties: { status: "clipboard-value" },
					cancelled: false,
				});

			await plugin.pasteProperties(target);

			expect(modal).toHaveBeenCalledWith(
				{ status: ["clipboard-value", "current-target"] },
				expect.any(Object),
				expect.objectContaining({ conflictNames: ["status"] })
			);
		});
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
			expect(spy).toHaveBeenCalledWith("Property Porter: Pasted 1 tag into dest");
		});

		it("reports property and individual value counts after a paste", async () => {
			const target = new obsidianMock.TFile("dest.md");
			const { plugin } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { title: "T", tags: ["a", "b"] };
			const spy = vi.spyOn(obsidianMock, "Notice");

			await plugin.pasteProperties(target);

			expect(spy).toHaveBeenCalledWith("Property Porter: Pasted 2 properties (3 values) into dest");
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

		it("asks to resolve a merge-mode scalar collision before pasting", async () => {
			const target = new obsidianMock.TFile("dest.md");
			const { plugin, fileCache } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { status: "clip" };
			fileCache[target.path] = { frontmatter: { status: "target" } };
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({ properties: { status: "target" }, cancelled: false });

			await plugin.pasteProperties(target);

			expect(modal).toHaveBeenCalledWith(
				{ status: ["clip", "target"] },
				{
					status: {
						clipboardOrigin: undefined,
						conflictNotes: ["dest"],
						valueSources: { status: { target: [{ note: "dest", count: 1 }] } },
					},
				},
				{
					title: "Resolve property conflicts",
					conflictNames: ["status"],
					finishText: "Continue",
				}
			);
			expect(fileCache[target.path].frontmatter).toEqual({ status: "target" });
		});

		it("repairs duplicate keys in the paste target before pasting", async () => {
			const active = new obsidianMock.TFile("active.md");
			const target = new obsidianMock.TFile("dup.md");
			// Deliberately leave the metadata cache empty.
			const { plugin, app, fileCache, fileContents } = createPlugin({
				activeFile: active,
				markdownFiles: [active, target],
				fileContents: {
					[target.path]: [
						"---",
						"status: old",
						"modified_date: 2026-10-13T16:58:17",
						"modified_date: 2026-10-13T15:45:00",
						"---",
						"",
					].join("\n"),
				},
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "";
			plugin.settings.excludeKeys = "";
			const originalText = fileContents[target.path];
			const modify = vi.spyOn(app.vault, "modify");
			const process = vi.spyOn(app.fileManager, "processFrontMatter");
			plugin.clipboard = { status: "clip", modified_date: "2026-10-13T16:58:17" };
			plugin.clipboardOrigin = "active";

			let modalIndex = 0;
			let secondWarning = "";
			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				modalIndex++;
				const findCard = (name: string) =>
					Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
						(c: any) => c.querySelector(".pp-property-name")?.textContent === name
					) as HTMLElement;
				if (modalIndex === 1) {
					// Duplicate-resolution modal: pick the first modified_date.
					const card = findCard("modified_date");
					expect(card.querySelector(".pp-property-warning")?.textContent).toBe(
						"Choose which modified_date value to keep."
					);
					const radios = card.querySelectorAll<HTMLInputElement>('.pp-conflict-option input[type="radio"]');
					radios[0].click();
				} else {
					// Merge conflict on status only: the repaired
					// modified_date matches the clipboard, so it is not a
					// conflict.
					const card = findCard("status");
					secondWarning = card.querySelector(".pp-property-warning")?.textContent ?? "";
					const radios = card.querySelectorAll<HTMLInputElement>('.pp-conflict-option input[type="radio"]');
					expect(radios.length).toBe(3);
					radios[0].click(); // keep the clipboard value
				}
				this.contentEl.querySelector(".pp-finish-button").click();
			};

			await plugin.pasteProperties(target);

			expect(secondWarning).toBe("Choose which status value to keep.");
			// The target was repaired and then pasted into.
			expect(modalIndex).toBe(2);
			expect(fileContents[target.path]).toBe(
				originalText.replace("modified_date: 2026-10-13T15:45:00\n", "")
			);
			expect(modify.mock.invocationCallOrder[0]).toBeLessThan(process.mock.invocationCallOrder[0]);
			expect(fileCache[target.path].frontmatter).toEqual({
				status: "clip",
				modified_date: "2026-10-13T16:58:17",
			});
		});

		it("does not write the staged repair when the merge conflict modal is cancelled", async () => {
			const active = new obsidianMock.TFile("active.md");
			const target = new obsidianMock.TFile("dup.md");
			const noteText = [
				"---",
				"status: target",
				"modified_date: 2026-10-13T16:58:17",
				"modified_date: 2026-10-13T15:45:00",
				"---",
				"",
			].join("\n");
			const { plugin, app, fileContents } = createPlugin({
				activeFile: active,
				markdownFiles: [active, target],
				fileContents: { [target.path]: noteText },
			});
			const modify = vi.spyOn(app.vault, "modify");
			const process = vi.spyOn(app.fileManager, "processFrontMatter");
			await plugin.onload();
			plugin.settings.onlyInclude = "";
			plugin.settings.excludeKeys = "";
			plugin.clipboard = { status: "clip" };
			plugin.clipboardOrigin = "active";

			let modalIndex = 0;
			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				modalIndex++;
				if (modalIndex === 1) {
					// Duplicate-resolution modal succeeds: pick the first modified_date.
					const card = Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
						(c: any) => c.querySelector(".pp-property-name")?.textContent === "modified_date"
					) as HTMLElement;
					const radios = card.querySelectorAll<HTMLInputElement>('.pp-conflict-option input[type="radio"]');
					radios[0].click();
					this.contentEl.querySelector(".pp-finish-button").click();
				} else {
					// Merge-conflict modal is cancelled: nothing may be written.
					expect(this.contentEl.textContent).toContain("Choose which status value to keep");
					expect(this.contentEl.textContent).toContain("status");
					this.close();
				}
			};

			await plugin.pasteProperties(target);

			// The staged repair was never applied and the clipboard is untouched.
			expect(modalIndex).toBe(2);
			expect(modify).not.toHaveBeenCalled();
			expect(process).not.toHaveBeenCalled();
			expect(fileContents[target.path]).toBe(noteText);
			expect(plugin.clipboard).toEqual({ status: "clip" });
		});

		it("leaves the target untouched when the paste conflict modal is cancelled", async () => {
			const target = new obsidianMock.TFile("dest.md");
			const { plugin, fileCache } = createPlugin();
			await plugin.onload();
			plugin.clipboard = { status: "clip" };
			fileCache[target.path] = { frontmatter: { status: "target" } };
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({ properties: {}, cancelled: true });

			await plugin.pasteProperties(target);

			expect(fileCache[target.path].frontmatter).toEqual({ status: "target" });
			expect(plugin.clipboard).toEqual({ status: "clip" });
		});

		it("does not ask in overwrite mode; the clipboard value wins", async () => {
			const target = new obsidianMock.TFile("dest.md");
			const { plugin, fileCache } = createPlugin();
			await plugin.onload();
			plugin.settings.pasteMode = "overwrite";
			plugin.clipboard = { status: "clip" };
			fileCache[target.path] = { frontmatter: { status: "target" } };
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({ properties: {}, cancelled: false });

			await plugin.pasteProperties(target);

			expect(modal).not.toHaveBeenCalled();
			expect(fileCache[target.path].frontmatter).toEqual({ status: "clip" });
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

		it("uses the active file to recover the tab group when activeLeaf is unavailable", async () => {
			const active = new obsidianMock.TFile("active.md");
			const sibling = new obsidianMock.TFile("sibling.md");
			const other = new obsidianMock.TFile("other.md");
			const { plugin, fileCache } = createPlugin({
				activeFile: active,
				activeLeaf: null,
				leaves: [
					{ file: active, group: "g1" },
					{ file: sibling, group: "g1" },
					{ file: other, group: "g2" },
				],
			});
			await plugin.onload();
			plugin.clipboard = { tags: ["a"] };

			await plugin.pasteIntoActiveTabGroup();

			expect(fileCache[active.path].frontmatter).toEqual({ tags: ["a"] });
			expect(fileCache[sibling.path].frontmatter).toEqual({ tags: ["a"] });
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
			expect(spy).toHaveBeenCalledWith("Property Porter: Pasted 1 tag into 2 notes");
			expect(plugin.clipboard).toEqual({ tags: ["a"] });
		});

		it("resolves paste conflicts once and applies the choice to every note", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
				],
			});
			await plugin.onload();
			plugin.clipboard = { status: "clip" };
			fileCache[f1.path] = { frontmatter: { status: "one" } };
			fileCache[f2.path] = { frontmatter: { status: "two" } };
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({ properties: { status: "picked" }, cancelled: false });

			await plugin.pasteIntoActiveTabGroup();

			expect(modal).toHaveBeenCalledWith(
				{ status: ["clip", "one", "two"] },
				{
					status: {
						clipboardOrigin: undefined,
						conflictNotes: ["a", "b"],
						valueSources: {
							status: {
								one: [{ note: "a", count: 1 }],
								two: [{ note: "b", count: 1 }],
							},
						},
					},
				},
				{
					title: "Resolve property conflicts",
					conflictNames: ["status"],
					finishText: "Continue",
				}
			);
			expect(fileCache[f1.path].frontmatter).toEqual({ status: "picked" });
			expect(fileCache[f2.path].frontmatter).toEqual({ status: "picked" });
		});

		it("does not count clipboard-source values twice when pasting into a group containing that source", async () => {
			const source = new obsidianMock.TFile("source.md");
			const other = new obsidianMock.TFile("other.md");
			const { plugin, fileCache } = createPlugin({
				activeFile: source,
				markdownFiles: [source, other],
				leaves: [
					{ file: source, group: "g1" },
					{ file: other, group: "g1" },
				],
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "tags, modified_date";
			fileCache[source.path] = {
				frontmatter: {
					tags: ["perception", "obsidian", "vision", "programming"],
					modified_date: "2026-10-13T15:44:59",
				},
			};
			fileCache[other.path] = {
				frontmatter: { modified_date: "2026-10-13T15:33:18" },
			};
			await plugin.copyProperties();

			obsidianMock.Modal.prototype.open = function (this: any) {
				this.onOpen();
				const tagsCard = Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
					(card: any) => card.querySelector(".pp-property-name")?.textContent === "tags"
				) as HTMLElement;
				expect(tagsCard.querySelector(".pp-property-notice")).toBeNull();
				expect(Array.from(tagsCard.querySelectorAll(".pp-list-candidate-sources")).map(
					(element) => element.textContent
				)).toEqual([]);
				this.contentEl.querySelector(".pp-finish-button").click();
			};

			await plugin.pasteIntoActiveTabGroup();

			expect(fileCache[source.path].frontmatter.tags).toEqual([
				"perception",
				"obsidian",
				"vision",
				"programming",
			]);
			expect(fileCache[other.path].frontmatter.tags).toEqual([
				"perception",
				"obsidian",
				"vision",
				"programming",
			]);
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

		it("unions list properties across the group when scalars agree", async () => {
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
			fileCache[f1.path] = { frontmatter: { tags: ["x"], status: "same" } };
			fileCache[f2.path] = { frontmatter: { tags: ["y", "x"], status: "same" } };

			await plugin.copyPropertiesFromActiveTabGroup();

			// tags union across the group (f1, f2); "other" is a different group
			// and must be excluded. Agreeing scalars copy without a conflict.
			expect(plugin.clipboard).toEqual({
				tags: ["x", "y"],
				status: "same",
			});
		});

		it("asks once to resolve scalar conflicts across the group", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
				],
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "tags, status";
			fileCache[f1.path] = { frontmatter: { tags: ["x"], status: "one" } };
			fileCache[f2.path] = { frontmatter: { tags: ["y"], status: "two" } };
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({ properties: { tags: ["x", "y"], status: "two" }, cancelled: false });

			await plugin.copyPropertiesFromActiveTabGroup();

			expect(modal).toHaveBeenCalledWith(
				{ status: ["one", "two"], tags: ["x", "y"] },
				{
					status: {
						conflictNotes: ["a", "b"],
						valueSources: {
							status: {
								one: [{ note: "a", count: 1 }],
								two: [{ note: "b", count: 1 }],
							},
						},
					},
				},
				{
					title: "Resolve property conflicts",
					conflictNames: ["status"],
					finishText: "Continue",
				}
			);
			expect(plugin.clipboard).toEqual({ tags: ["x", "y"], status: "two" });
		});

		it("detects changed scalar values even when the metadata cache has not updated", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
				],
				fileContents: {
					[f1.path]: "---\nstatus: current-one\n---\n",
					[f2.path]: "---\nstatus: current-two\n---\n",
				},
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "status";
			fileCache[f1.path] = { frontmatter: { status: "stale-same" } };
			fileCache[f2.path] = { frontmatter: { status: "stale-same" } };
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({
					properties: { status: "current-two" },
					cancelled: false,
				});

			await plugin.copyPropertiesFromActiveTabGroup();

			expect(modal).toHaveBeenCalledWith(
				{ status: ["current-one", "current-two"] },
				expect.objectContaining({
					status: expect.objectContaining({
						conflictNotes: ["a", "b"],
					}),
				}),
				expect.objectContaining({ conflictNames: ["status"] })
			);
			expect(plugin.clipboard).toEqual({ status: "current-two" });
		});

		it("detects checkbox conflicts and preserves boolean false as a value", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
				],
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "favorite";
			fileCache[f1.path] = { frontmatter: { favorite: false } };
			fileCache[f2.path] = { frontmatter: { favorite: true } };
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({ properties: { favorite: false }, cancelled: false });

			await plugin.copyPropertiesFromActiveTabGroup();

			expect(modal).toHaveBeenCalledWith(
				{ favorite: [false, true] },
				expect.any(Object),
				expect.objectContaining({ conflictNames: ["favorite"] })
			);
			expect(plugin.clipboard).toEqual({ favorite: false });
		});

		it("keeps the clipboard when the copy conflict modal is cancelled", async () => {
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const { plugin, fileCache } = createPlugin({
				leaves: [
					{ file: f1, group: "g1" },
					{ file: f2, group: "g1" },
				],
			});
			await plugin.onload();
			plugin.settings.onlyInclude = "tags, status";
			fileCache[f1.path] = { frontmatter: { status: "one" } };
			fileCache[f2.path] = { frontmatter: { status: "two" } };
			plugin.clipboard = { keep: "me" };
			const modal = vi
				.spyOn(plugin, "openPropertySelectionModal")
				.mockResolvedValue({ properties: {}, cancelled: true });

			await plugin.copyPropertiesFromActiveTabGroup();

			expect(plugin.clipboard).toEqual({ keep: "me" });
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
			let openedModal: any;
			obsidianMock.SuggestModal.prototype.open = function (this: any) {
				openedModal = this;
				this.onChooseItem(other);
			};

			const result = await plugin.pickTargetFile();

			expect(result).toBe(other);
			expect(openedModal.options).toMatchObject({
				searchMode: "substring",
				limit: 20,
			});
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

	it("warns and removes legacy exclusions that overlap Only include properties", async () => {
		const { plugin } = createPlugin();
		vi.spyOn(plugin, "loadData").mockResolvedValue({
			onlyInclude: "Status, tags",
			excludeKeys: "status, aliases",
		});
		const noticeSpy = vi.spyOn(obsidianMock, "Notice");

		await plugin.loadSettings();

		expect(plugin.settings.onlyInclude).toBe("Status, tags");
		expect(plugin.settings.excludeKeys).toBe("aliases");
		expect(noticeSpy).toHaveBeenCalledWith(
			"Property Porter: removed excluded properties that also appear in Only include properties: status."
		);
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
			heading: "Property filters (property-copy commands)",
		});
		expect(defs[1]).toMatchObject({
			type: "group",
			heading: "Paste behavior",
		});

		const items = defs.flatMap((d: any) => (d.items ? d.items : [d]));
		const includeDef = items.find((definition) => definition.name === "Only include properties");
		const excludeDef = items.find((definition) => definition.name === "Exclude properties");
		expect(includeDef.render).toBeTypeOf("function");
		expect(excludeDef.render).toBeTypeOf("function");
		expect(includeDef.desc).toBe(
			"Choose existing properties or confirm new names to copy. Cannot overlap with Exclude properties."
		);
		expect(excludeDef.desc).toBe(
			"Choose existing properties or confirm new names to skip. Cannot overlap with Only include properties."
		);
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
			Array.from(includeControl.querySelectorAll(".commons-property-picker-chip span:first-child")).map(
				(element) => element.textContent
			)
		).toEqual(["tags"]);
		expect(
			includeControl.querySelector<HTMLInputElement>(".commons-property-picker-input")?.placeholder
		).toBe("Add a property");
		expect(
			includeControl
				.querySelector(".commons-property-picker-input")
				.getAttribute("aria-label")
		).toBe("Only include properties");
		expect(plugin.settings.onlyInclude).toBe("tags");
		expect(plugin.settings.excludeKeys).toBe("aliases, created date, modified date");
	});

	it("warns and prevents overlapping include and exclude selections", async () => {
		const file = new obsidianMock.TFile("settings.md");
		const { plugin, fileCache } = createPlugin({ markdownFiles: [file] });
		fileCache[file.path] = { frontmatter: { status: "draft" } };
		await plugin.onload();
		plugin.settings.onlyInclude = "";
		plugin.settings.excludeKeys = "status";

		const tab = new PropertyPorterSettingTab(plugin.app, plugin);
		const defs = tab.getSettingDefinitions();
		const items = defs.flatMap((d: any) => (d.items ? d.items : [d]));
		const includeControl = obsidianMock.decorateEl(document.createElement("div"));
		const excludeControl = obsidianMock.decorateEl(document.createElement("div"));
		items.find((definition) => definition.name === "Only include properties").render(
			{ controlEl: includeControl },
			{} as any
		);
		items.find((definition) => definition.name === "Exclude properties").render(
			{ controlEl: excludeControl },
			{} as any
		);
		const input = includeControl.querySelector(".commons-property-picker-input");
		const excludedInput = excludeControl.querySelector(".commons-property-picker-input");
		const noticeSpy = vi.spyOn(obsidianMock, "Notice");

		selectInputSuggestion(input, "status", "status");
		expect(plugin.settings.onlyInclude).toBe("");
		expect(noticeSpy).toHaveBeenCalledWith(
			"Property Porter: status is already excluded and cannot also be included."
		);

		excludeControl.querySelector(".commons-property-picker-remove").click();
		selectInputSuggestion(input, "status", "status");
		expect(plugin.settings.excludeKeys).toBe("");
		expect(plugin.settings.onlyInclude).toBe("status");

		selectInputSuggestion(excludedInput, "status", "status");
		expect(plugin.settings.excludeKeys).toBe("");
		expect(noticeSpy).toHaveBeenLastCalledWith(
			"Property Porter: status is already included and cannot also be excluded."
		);
	});
});
