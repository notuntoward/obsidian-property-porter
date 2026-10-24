// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as obsidianMock from "obsidian";
import PropertyPorter, {
	SelectPropertiesModal,
	NOTICE_CLEARED_COPIED_PROPERTIES,
} from "../src/main";
import { parseRawFrontmatter } from "../src/frontmatter";
import type { VaultMetadataCatalog } from "commons/properties";

function createMockCatalog(): VaultMetadataCatalog {
	return {
		properties: [
			{ name: "tags", kinds: ["string-list"], values: ["dev", "notes", "urgent"] },
			{ name: "status", kinds: ["string"], values: ["draft", "published", "archived"] },
			{ name: "cast", kinds: ["string-list"], values: ["Mark Hamill", "Harrison Ford", "Carrie Fisher"] },
			{ name: "title", kinds: ["string"], values: ["A New Hope", "Empire Strikes Back"] },
			{ name: "year", kinds: ["number"], values: ["1977", "1980"] },
			{ name: "favorite", kinds: ["boolean"], values: ["true", "false"] },
		],
		tags: ["dev", "notes", "urgent"],
	};
}

function createApp(options: any = {}) {
	const activeFile = options.activeFile ?? null;
	const markdownFiles = options.markdownFiles ?? [];
	const fileCache: Record<string, any> = options.fileCache ?? {};
	const fileContents: Record<string, string> = options.fileContents ?? {};

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
		vault: {
			getMarkdownFiles: () => markdownFiles,
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

const originalModalOpen = obsidianMock.Modal.prototype.open;

afterEach(() => {
	obsidianMock.Modal.prototype.open = originalModalOpen;
	vi.restoreAllMocks();
});

describe("SelectPropertiesModal", () => {
	it("initializes property cards for initial properties with correct list/scalar kinds", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const initial = {
			tags: ["dev", "notes"],
			status: "draft",
		};
		const onSubmit = vi.fn();
		const onCancel = vi.fn();

		const modal = new SelectPropertiesModal(app as any, catalog, initial, onSubmit, onCancel);
		modal.onOpen();

		const cards = modal.contentEl.querySelectorAll(".pp-property-card");
		expect(cards.length).toBe(2);

		const tagsCard = Array.from(cards).find((c) => c.querySelector(".pp-property-name")?.textContent === "tags");
		const statusCard = Array.from(cards).find((c) => c.querySelector(".pp-property-name")?.textContent === "status");

		expect(tagsCard?.querySelector(".pp-property-badge")?.textContent).toBe("Tags");
		expect(statusCard?.querySelector(".pp-property-badge")?.textContent).toBe("Scalar");
	});

	it("when notes with a scalar property are merged and there is a conflict, presents options and user selects one", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		// status has conflicting values from merged notes: "draft" and "published"
		const initial = {
			status: ["draft", "published"],
		};
		const onSubmit = vi.fn();
		const onCancel = vi.fn();

		const modal = new SelectPropertiesModal(app as any, catalog, initial, onSubmit, onCancel);
		modal.onOpen();

		const statusCard = modal.contentEl.querySelector(".pp-property-card")!;
		expect(statusCard).not.toBeNull();
		// Warning is shown
		expect(statusCard.querySelector(".pp-property-warning")?.textContent).toContain("Conflicting values");

		// Option pills for the conflicting options are rendered
		const pills = statusCard.querySelectorAll<HTMLButtonElement>(".pp-option-pill");
		expect(pills.length).toBe(2);
		expect(pills[0].textContent).toBe("draft");
		expect(pills[1].textContent).toBe("published");
		// Initially the first candidate is selected
		expect(pills[0].classList.contains("is-selected")).toBe(true);
		expect(pills[1].classList.contains("is-selected")).toBe(false);

		// User clicks "published" to choose that option
		pills[1].click();
		expect(pills[0].classList.contains("is-selected")).toBe(false);
		expect(pills[1].classList.contains("is-selected")).toBe(true);

		// Click finish selection
		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();

		expect(onSubmit).toHaveBeenCalledWith({
			status: "published",
		});
	});

	it("when notes with a list property have multiple values, allows selecting one or all of them", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const initial = {
			cast: ["Mark Hamill", "Harrison Ford", "Carrie Fisher"],
		};
		const onSubmit = vi.fn();
		const onCancel = vi.fn();

		const modal = new SelectPropertiesModal(app as any, catalog, initial, onSubmit, onCancel);
		modal.onOpen();

		const castCard = modal.contentEl.querySelector(".pp-property-card")!;
		expect(castCard.querySelector(".pp-property-badge")?.textContent).toBe("List");

		// Quick action buttons exist
		const selectAllBtn = castCard.querySelector<HTMLButtonElement>(".pp-select-all-btn")!;
		const clearBtn = castCard.querySelector<HTMLButtonElement>(".pp-clear-btn")!;
		expect(selectAllBtn).not.toBeNull();
		expect(clearBtn).not.toBeNull();

		// Candidate pills are present and initially all selected
		const pills = castCard.querySelectorAll<HTMLButtonElement>(".pp-option-pill");
		expect(pills.length).toBe(3);
		expect(Array.from(pills).every((p) => p.classList.contains("is-selected"))).toBe(true);

		// Click "Clear" to unselect all
		clearBtn.click();
		expect(Array.from(pills).every((p) => !p.classList.contains("is-selected"))).toBe(true);

		// Click one candidate pill to select only "Harrison Ford"
		pills[1].click();
		expect(pills[1].classList.contains("is-selected")).toBe(true);
		expect(pills[0].classList.contains("is-selected")).toBe(false);

		// Click "Select all" to select all of them
		selectAllBtn.click();
		expect(Array.from(pills).every((p) => p.classList.contains("is-selected"))).toBe(true);

		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();
		expect(onSubmit).toHaveBeenCalledWith({
			cast: ["Mark Hamill", "Harrison Ford", "Carrie Fisher"],
		});
	});

	it("allows adding a new property through the search/add input", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const modal = new SelectPropertiesModal(app as any, catalog, {}, vi.fn(), vi.fn());
		modal.onOpen();

		expect(modal.contentEl.querySelectorAll(".pp-property-card").length).toBe(0);

		modal.addProperty("year");
		expect(modal.contentEl.querySelectorAll(".pp-property-card").length).toBe(1);
		const card = modal.contentEl.querySelector(".pp-property-card")!;
		expect(card.querySelector(".pp-property-name")?.textContent).toBe("year");
		expect(card.querySelector(".pp-property-badge")?.textContent).toBe("Scalar");
	});

	it("allows removing a property card with the remove button", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const initial = {
			status: "draft",
			title: "A New Hope",
		};
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(app as any, catalog, initial, onSubmit, vi.fn());
		modal.onOpen();

		expect(modal.contentEl.querySelectorAll(".pp-property-card").length).toBe(2);

		const cards = Array.from(modal.contentEl.querySelectorAll(".pp-property-card"));
		const titleCard = cards.find((c) => c.querySelector(".pp-property-name")?.textContent === "title")!;
		titleCard.querySelector<HTMLButtonElement>(".pp-property-remove-btn")!.click();

		expect(modal.contentEl.querySelectorAll(".pp-property-card").length).toBe(1);

		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();
		expect(onSubmit).toHaveBeenCalledWith({
			status: "draft",
		});
	});

	it("cancels without submitting when modal is closed without finish (Esc)", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const modal = new SelectPropertiesModal(app as any, catalog, { status: "draft" }, onSubmit, onCancel);
		modal.onOpen();

		modal.close();
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).toHaveBeenCalled();
	});

	it("names the note when a property appears more than once in one note", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			catalog,
			{ modified_date: ["2026-10-13T16:58:17", "2026-10-13T15:45:00"] },
			onSubmit,
			vi.fn(),
			{ modified_date: { duplicateIn: ["note-six"] } }
		);
		modal.onOpen();

		const card = Array.from(modal.contentEl.querySelectorAll(".pp-property-card")).find(
			(c) => c.querySelector(".pp-property-name")?.textContent === "modified_date"
		)!;
		expect(card.querySelector(".pp-property-warning")?.textContent).toContain(
			"note-six has more than one modified_date value: select the one to keep"
		);
		const pills = card.querySelectorAll<HTMLButtonElement>(".pp-option-pill");
		expect(pills.length).toBe(2);
		pills[1].click();

		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();
		expect(onSubmit).toHaveBeenCalledWith({ modified_date: "2026-10-13T15:45:00" });
	});

	it("treats duplicate list values such as tags as a pick-one conflict", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			catalog,
			{ tags: ["a, b", "c"] },
			onSubmit,
			vi.fn(),
			{ tags: { duplicateIn: ["note-six"] } }
		);
		modal.onOpen();

		const card = Array.from(modal.contentEl.querySelectorAll(".pp-property-card")).find(
			(c) => c.querySelector(".pp-property-name")?.textContent === "tags"
		)!;
		expect(card.querySelector(".pp-property-warning")?.textContent).toContain(
			"note-six has more than one tags value"
		);
		const pills = card.querySelectorAll<HTMLButtonElement>(".pp-option-pill");
		expect(pills.length).toBe(2);
		pills[0].click();

		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();
		expect(onSubmit).toHaveBeenCalledWith({ tags: ["a, b"] });
	});
});

describe("PropertyPorter.selectPropertiesToPaste", () => {
	it("resolves tab-group copy conflicts through the modal", async () => {
		const f1 = new obsidianMock.TFile("a.md");
		const f2 = new obsidianMock.TFile("b.md");
		const { plugin, fileCache } = createPlugin({
			markdownFiles: [f1, f2],
			leaves: [
				{ file: f1, group: "g1" },
				{ file: f2, group: "g1" },
			],
		});
		await plugin.onload();
		plugin.settings.onlyInclude = ""; // include all
		fileCache[f1.path] = { frontmatter: { status: "draft", tags: ["dev"] } };
		fileCache[f2.path] = { frontmatter: { status: "published", tags: ["notes"] } };

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			// Confirm conflicting status has options "draft" and "published"
			const statusCard = Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
				(c: any) => c.querySelector(".pp-property-name")?.textContent === "status"
			) as HTMLElement;
			expect(statusCard.querySelector(".pp-property-warning")?.textContent).toContain(
				"Conflicting values across a, b: select one"
			);

			const pills = statusCard.querySelectorAll<HTMLButtonElement>(".pp-option-pill");
			expect(pills.length).toBe(2);

			// Choose "published"
			pills[1].click();

			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.copyPropertiesFromActiveTabGroup();

		expect(plugin.clipboard).toEqual({
			status: "published",
			tags: ["dev", "notes"],
		});
	});

	it("edits the clipboard contents even when several notes are open in the tab group", async () => {
		const f1 = new obsidianMock.TFile("a.md");
		const f2 = new obsidianMock.TFile("b.md");
		const { plugin, fileCache } = createPlugin({
			markdownFiles: [f1, f2],
			leaves: [
				{ file: f1, group: "g1" },
				{ file: f2, group: "g1" },
			],
		});
		await plugin.onload();
		plugin.settings.onlyInclude = ""; // include all
		fileCache[f1.path] = { frontmatter: { status: "draft", tags: ["dev"] } };
		fileCache[f2.path] = { frontmatter: { status: "published", tags: ["notes"] } };
		plugin.clipboard = { kept: "value" };

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			const names = Array.from(
				this.contentEl.querySelectorAll(".pp-property-name")
			).map((n: any) => n.textContent);
			expect(names).toContain("kept");
			expect(names).not.toContain("status");
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.selectPropertiesToPaste();

		expect(plugin.clipboard).toEqual({ kept: "value" });
	});

	it("pastes selected properties into another note", async () => {
		const active = new obsidianMock.TFile("active.md");
		const target = new obsidianMock.TFile("target.md");
		const { plugin, fileCache } = createPlugin({
			activeFile: active,
			markdownFiles: [active, target],
		});
		await plugin.onload();
		plugin.settings.onlyInclude = "";
		fileCache[active.path] = { frontmatter: { title: "Original Title", tags: ["t1"] } };
		fileCache[target.path] = { frontmatter: {} };

		await plugin.copyProperties();
		expect(plugin.clipboard).toEqual({
			title: "Original Title",
			tags: ["t1"],
		});

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.selectPropertiesToPaste();
		expect(plugin.clipboard).toEqual({
			title: "Original Title",
			tags: ["t1"],
		});

		await plugin.pasteProperties(target);
		expect(fileCache[target.path].frontmatter).toEqual({
			title: "Original Title",
			tags: ["t1"],
		});
	});

	it("cancels when user presses Esc, leaving existing clipboard unchanged", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.clipboard = { preserved: "value" };

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			this.close();
		};

		await plugin.selectPropertiesToPaste();
		expect(plugin.clipboard).toEqual({ preserved: "value" });
	});

	it("clears clipboard when user finishes with zero properties selected", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.clipboard = { old: "value" };
		const spy = vi.spyOn(obsidianMock, "Notice");

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			this.clearAll();
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.selectPropertiesToPaste();
		expect(plugin.clipboard).toEqual({});
		expect(spy).toHaveBeenCalledWith(NOTICE_CLEARED_COPIED_PROPERTIES);
	});
});
