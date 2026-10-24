// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as obsidianMock from "obsidian";
import PropertyPorter, {
	SelectPropertiesModal,
	NOTICE_CLEARED_COPIED_PROPERTIES,
} from "../src/main";
import { PropertyNameSuggest } from "../src/select-properties-modal";
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
	it("focuses the finish button instead of the add-property input when a conflict exists", () => {
		vi.useFakeTimers();
		try {
			const { app } = createApp();
			const onSubmit = vi.fn();
			const modal = new SelectPropertiesModal(
				app as any,
				createMockCatalog(),
				{ status: ["draft", "published"] },
				onSubmit,
				vi.fn(),
				{
					status: {
						valueSources: {
							status: {
								draft: [{ note: "Note-A", count: 1 }],
								published: [{ note: "Note-B", count: 1 }],
							},
						},
					},
				}
			);
			document.body.appendChild(modal.contentEl);

			modal.onOpen();
			vi.runOnlyPendingTimers();

			expect(modal.propertyStates.get("status")?.hasConflict).toBe(true);
			expect(document.activeElement).not.toBe(modal.inputEl);
			expect(document.activeElement).toBe(modal.contentEl.querySelector(".pp-conflict-option input"));
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not suggest properties until the user types a query", () => {
		const { app } = createApp();
		const suggest = new PropertyNameSuggest(app as any, document.createElement("input"), () => ["status"], vi.fn());

		expect(suggest.getSuggestions(" \t")).toEqual([]);
		expect(suggest.getSuggestions("sta")).toEqual(["status"]);
	});

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

	it("treats a clipboard-only scalar candidate as known to the value picker", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ imported_property: "copied value" },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		const card = Array.from(modal.contentEl.querySelectorAll(".pp-property-card")).find(
			(element) => element.querySelector(".pp-property-name")?.textContent === "imported_property"
		)!;
		const chip = card.querySelector<HTMLElement>(".commons-property-picker-chip");
		expect(chip?.dataset.entry).toBeUndefined();
		expect(chip?.querySelector(".commons-property-picker-new-badge")).toBeNull();
		expect(card.querySelector<HTMLElement>(".commons-property-picker-status")?.hidden).toBe(true);
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
		expect(statusCard.querySelector(".pp-property-warning")?.textContent).toContain("Conflicting values");

		const group = statusCard.querySelector('[role="radiogroup"]')!;
		const options = statusCard.querySelectorAll<HTMLLabelElement>(".pp-conflict-option");
		const radios = statusCard.querySelectorAll<HTMLInputElement>('.pp-conflict-option input[type="radio"]');
		expect(group).not.toBeNull();
		expect(options).toHaveLength(3);
		expect(options[0].querySelector(".pp-conflict-value")?.textContent).toBe("draft");
		expect(options[1].querySelector(".pp-conflict-value")?.textContent).toBe("published");
		expect(radios).toHaveLength(3);
		expect(radios[0].name).toBe("pp-status");
		expect(radios[0].checked).toBe(true);
		expect(radios[1].checked).toBe(false);
		expect(statusCard.querySelector(".pp-option-pill")).toBeNull();
		expect(statusCard.querySelector(".pp-property-picker-host")).toBeNull();

		radios[1].click();
		expect(radios[1].checked).toBe(true);
		expect(modal.propertyStates.get("status")?.selected).toEqual(["published"]);
		expect(modal.getSelectedProperties()).toEqual({ status: "published" });

		// Click finish selection
		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();

		expect(onSubmit).toHaveBeenCalledWith({
			status: "published",
		});
	});

	it("creates the conflict value picker only when Other value is selected", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"] },
			onSubmit,
			vi.fn(),
			{
				status: {
					valueSources: {
						status: {
							draft: [{ note: "Note-A", count: 1 }],
							published: [{ note: "Note-B", count: 1 }],
						},
					},
				},
			}
		);
		modal.onOpen();

		const card = modal.contentEl.querySelector(".pp-property-card")!;
		const options = card.querySelectorAll<HTMLLabelElement>(".pp-conflict-option");
		const otherRadio = options[2].querySelector<HTMLInputElement>("input")!;
		expect(card.querySelector(".pp-property-warning")?.textContent).toBe(
			"Choose which status to keep. Notes differ: Note-A, Note-B"
		);
		expect(options[0].querySelector(".pp-conflict-sources")?.textContent).toBe("Note-A");
		expect(options[2].querySelector(".pp-conflict-value")?.textContent).toBe("Other value…");
		expect(card.querySelector(".pp-property-picker-host")).toBeNull();

		otherRadio.click();

		const host = card.querySelector<HTMLElement>(".pp-property-picker-host")!;
		expect(host).not.toBeNull();
		expect(host.hidden).toBe(false);
		expect(modal.propertyStates.get("status")?.picker).not.toBeNull();
		expect(modal.propertyStates.get("status")?.selected).toEqual([]);
		modal.propertyStates.get("status")?.picker?.setValue("custom value");

		const firstRadio = options[0].querySelector<HTMLInputElement>("input")!;
		firstRadio.click();
		expect(host.hidden).toBe(true);
		expect(modal.propertyStates.get("status")?.selected).toEqual(["draft"]);
		expect(modal.propertyStates.get("status")?.picker?.getValue()).toEqual(["custom value"]);
		expect(modal.getSelectedProperties()).toEqual({ status: "draft" });

		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();
		expect(onSubmit).toHaveBeenCalledWith({ status: "draft" });
	});

	it("treats conflict candidates as known and accepts typed date values without a new-entry modal", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		catalog.properties.push({
			name: "modified_date",
			kinds: ["string"],
			values: ["2026-10-24T10:00:00Z"],
		});
		const modal = new SelectPropertiesModal(
			app as any,
			catalog,
			{ modified_date: ["2026-10-24T10:00:00Z", "2026-10-25T10:00:00Z"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		const card = modal.contentEl.querySelector(".pp-property-card")!;
		card.querySelectorAll<HTMLInputElement>(".pp-conflict-option input")[2]!.click();
		const picker = modal.propertyStates.get("modified_date")!.picker!;
		const candidate = "2026-10-24T10:00:00Z";
		picker.setValue(candidate);
		const chip = picker.rootEl.querySelector<HTMLElement>(".commons-property-picker-chip");
		expect(chip?.dataset.entry).toBeUndefined();
		expect(chip?.querySelector(".commons-property-picker-new-badge")).toBeNull();
		expect(picker.rootEl.querySelector<HTMLElement>(".commons-property-picker-status")?.hidden).toBe(true);

		picker.setValue([]);
		const suggest = obsidianMock.AbstractInputSuggest.instances.find(
			(instance: any) => instance.inputEl === picker.inputEl
		)!;
		const typedDate = "2026-10-26T10:00:00Z";
		const createOption = suggest.suggestions(typedDate).find((option: any) => option.kind === "create");
		const confirmationModalCount = document.querySelectorAll(".pp-new-entry-modal").length;
		suggest.select(createOption);

		expect(modal.propertyStates.get("modified_date")?.selected).toEqual([typedDate]);
		expect(document.querySelectorAll(".pp-new-entry-modal")).toHaveLength(confirmationModalCount);
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
		const excludeButton = titleCard.querySelector<HTMLButtonElement>(".pp-property-remove-btn")!;
		expect(excludeButton.textContent).toBe("Don't paste");
		expect(excludeButton.title).toBe("Exclude this whole property from the paste");
		expect(excludeButton.getAttribute("aria-label")).toBe("Exclude title");
		excludeButton.click();

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

	it("shows a notice instead of a conflict when a scalar value is duplicated", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const modal = new SelectPropertiesModal(
			app as any,
			catalog,
			{ modified_date: ["2026-10-13T16:58:17", "2026-10-13T16:58:17"] },
			vi.fn(),
			vi.fn(),
			{
				modified_date: {
					valueSources: {
						modified_date: {
							"2026-10-13T16:58:17": [{ note: "Note-06", count: 2 }],
						},
					},
				},
			}
		);
		modal.onOpen();

		const state = modal.propertyStates.get("modified_date")!;
		const card = modal.contentEl.querySelector(".pp-property-card")!;
		expect(state.hasConflict).toBe(false);
		expect(state.selected).toEqual(["2026-10-13T16:58:17"]);
		expect(card.querySelector(".pp-property-notice")?.textContent).toBe(
			"Note-06 had modified_date twice with the same value; it will be pasted once."
		);
		expect(card.querySelector(".pp-property-warning")).toBeNull();
		expect(card.querySelector(".pp-option-pill")).toBeNull();
	});

	it("keeps different scalar values as a conflict", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ modified_date: ["first", "second"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		expect(modal.propertyStates.get("modified_date")?.hasConflict).toBe(true);
		expect(modal.contentEl.querySelectorAll(".pp-conflict-option")).toHaveLength(3);
	});

	it("renders an option for each distinct scalar value", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ modified_date: ["first", "second", "third"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		expect(modal.propertyStates.get("modified_date")?.hasConflict).toBe(true);
		expect(modal.contentEl.querySelectorAll(".pp-conflict-option")).toHaveLength(4);
	});

	it("deduplicates repeated list values without creating a conflict", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ tags: ["a", "b", "a"] },
			vi.fn(),
			vi.fn(),
			{
				tags: {
					valueSources: {
						tags: {
							a: [{ note: "Note-06", count: 2 }],
							b: [{ note: "Note-06", count: 1 }],
						},
					},
				},
			}
		);
		modal.onOpen();

		const state = modal.propertyStates.get("tags")!;
		const card = modal.contentEl.querySelector(".pp-property-card")!;
		expect(state.hasConflict).toBe(false);
		expect(state.selected).toEqual(["a", "b"]);
		expect(card.querySelectorAll(".pp-option-pill")).toHaveLength(2);
		expect(card.querySelector(".pp-property-notice")?.textContent).toContain(
			"Note-06 had tags twice with the same value; it will be pasted once."
		);
		expect(card.querySelector(".pp-list-candidate-sources")?.textContent).toBe("×2 in Note-06");
		expect(
			Array.from(card.querySelectorAll<HTMLElement>(".commons-property-picker-chip")).every(
				(chip) => chip.dataset.entry === undefined
			)
		).toBe(true);
		expect(card.querySelector<HTMLElement>(".commons-property-picker-status")?.hidden).toBe(true);
		expect(
			card.querySelector(".pp-property-notice")!.compareDocumentPosition(card.querySelector(".pp-options-container")!) &
				Node.DOCUMENT_POSITION_FOLLOWING
		).toBeTruthy();
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
				"Choose which status to keep. Notes differ: a, b"
			);

			const radios = statusCard.querySelectorAll<HTMLInputElement>('.pp-conflict-option input[type="radio"]');
			expect(radios.length).toBe(3);

			// Choose "published"
			radios[1].click();

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
