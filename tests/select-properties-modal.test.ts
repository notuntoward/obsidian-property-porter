// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as obsidianMock from "obsidian";
import { ConfirmNewEntryModal } from "commons/properties";
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

function getInputSuggest(input: HTMLInputElement): any {
	return (obsidianMock.AbstractInputSuggest as any).instances.find(
		(instance: any) => instance.inputEl === input
	);
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
			expect(modal.contentEl.querySelector<HTMLDetailsElement>(".pp-add-property-details")?.open).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("can leave the first property unfocused when editing the clipboard", () => {
		vi.useFakeTimers();
		try {
			const { app } = createApp();
			const modal = new SelectPropertiesModal(
				app as any,
				createMockCatalog(),
				{ status: "draft" },
				vi.fn(),
				vi.fn(),
				{},
				{ title: "Edit property clipboard", focusFirstProperty: false }
			);
			document.body.appendChild(modal.contentEl);
			modal.onOpen();
			vi.runOnlyPendingTimers();

			expect(document.activeElement).toBe(modal.contentEl.querySelector(".pp-finish-button"));
			const addPropertySection = modal.contentEl.querySelector<HTMLDetailsElement>(".pp-add-property-details");
			expect(addPropertySection?.open).toBe(false);
			expect(addPropertySection?.nextElementSibling?.classList.contains("pp-properties-list")).toBe(true);
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
		expect(modal.propertyStates.get("imported_property")?.picker?.rootEl.dataset.valueStyle).toBe("plain");
	});

	it("renders scalar conflict values without tag bubbles", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();
		modal.contentEl.querySelectorAll<HTMLInputElement>(".pp-conflict-option input")[2]!.click();

		expect(modal.propertyStates.get("status")?.picker?.rootEl.dataset.valueStyle).toBe("plain");
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
		expect(statusCard.querySelector(".pp-property-warning")?.textContent).toBe(
			"Choose which status value to keep."
		);

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

		expect(modal.contentEl.querySelector(".pp-conflict-section h3")?.textContent).toBe(
			"Resolve Property Conflicts"
		);
		expect(modal.contentEl.querySelector(".pp-properties-section h3")?.textContent).toBe("Other properties");
		expect(modal.contentEl.querySelector(".pp-properties-section .pp-properties-info")?.textContent).toBe(
			"These properties have no conflicts and need no action. Edit or exclude them only if you want."
		);
		const addPropertySection = modal.contentEl.querySelector(".pp-properties-section .pp-add-property-details");
		expect(addPropertySection?.querySelector("summary")?.textContent).toBe("Add new property");
		expect(addPropertySection?.nextElementSibling?.classList.contains("pp-properties-list")).toBe(true);

		radios[1].click();
		expect(radios[1].checked).toBe(true);
		expect(modal.propertyStates.get("status")?.selected).toEqual(["published"]);
		expect(modal.getSelectedProperties()).toEqual({ status: "published" });

		modal.contentEl.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })
		);

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
		expect(card.querySelector(".pp-property-warning")?.textContent).toBe("Choose which status value to keep.");
		expect(card.querySelector(".pp-property-warning")?.textContent).not.toContain("Note-A");
		expect(card.querySelector(".pp-property-warning")?.textContent).not.toContain("Note-B");
		expect(options[0].querySelector(".pp-conflict-sources")?.textContent).toBe("Note-A");
		expect(options[1].querySelector(".pp-conflict-sources")?.textContent).toBe("Note-B");
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

	it("accepts typed values for scalar conflicts without a new-entry confirmation", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();
		modal.contentEl.querySelectorAll<HTMLInputElement>(".pp-conflict-option input")[2]!.click();

		const picker = modal.propertyStates.get("status")!.picker!;
		const confirmOpen = vi.spyOn(ConfirmNewEntryModal.prototype, "open");
		const suggester = getInputSuggest(picker.inputEl);
		const createOption = suggester.suggestions("custom status").find(
			(option: any) => option.kind === "create"
		);
		expect(createOption).toBeDefined();
		suggester.select(createOption);

		expect(confirmOpen).not.toHaveBeenCalled();
		expect(modal.propertyStates.get("status")?.selected).toEqual(["custom status"]);
	});

	it("accepts typed values for non-conflicting scalar properties without confirmation", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft" },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		const picker = modal.propertyStates.get("status")!.picker!;
		const confirmOpen = vi.spyOn(ConfirmNewEntryModal.prototype, "open");
		const suggester = getInputSuggest(picker.inputEl);
		const createOption = suggester.suggestions("custom status").find(
			(option: any) => option.kind === "create"
		);
		expect(createOption).toBeDefined();
		suggester.select(createOption);

		expect(confirmOpen).not.toHaveBeenCalled();
		expect(picker.getValue()).toEqual(["custom status"]);
	});

	it("still confirms typed values for list properties", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ cast: ["Mark Hamill"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		const picker = modal.propertyStates.get("cast")!.picker!;
		const confirmOpen = vi.spyOn(ConfirmNewEntryModal.prototype, "open");
		const suggester = getInputSuggest(picker.inputEl);
		const createOption = suggester.suggestions("New Actor").find(
			(option: any) => option.kind === "create"
		);
		expect(createOption).toBeDefined();
		suggester.select(createOption);

		expect(confirmOpen).toHaveBeenCalledOnce();
		expect(picker.getValue()).toEqual(["Mark Hamill"]);
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
		expect(picker.inputEl.type).toBe("datetime-local");
		const candidate = "2026-10-24T10:00:00Z";
		picker.setValue(candidate);
		const chip = picker.rootEl.querySelector<HTMLElement>(".commons-property-picker-chip");
		expect(chip?.dataset.entry).toBeUndefined();
		expect(chip?.querySelector(".commons-property-picker-new-badge")).toBeNull();
		expect(picker.rootEl.querySelector<HTMLElement>(".commons-property-picker-status")?.hidden).toBe(true);

		const confirmationModalCount = document.querySelectorAll(".pp-new-entry-modal").length;
		picker.inputEl.value = "2026-10-26T10:00";
		picker.inputEl.dispatchEvent(new Event("change"));

		expect(modal.propertyStates.get("modified_date")?.selected).toEqual(["2026-10-26T10:00Z"]);
		expect(picker.inputEl.value).toBe("2026-10-26T10:00");
		expect(card.querySelector(".pp-property-picker-hint")?.textContent).toBe(
			"Changing this date replaces the property value; it will not add another date."
		);

		picker.inputEl.value = "2026-10-27T12:15";
		picker.inputEl.dispatchEvent(new Event("change"));
		expect(modal.propertyStates.get("modified_date")?.selected).toEqual(["2026-10-27T12:15Z"]);
		expect(modal.getSelectedProperties()).toEqual({ modified_date: "2026-10-27T12:15Z" });
		expect(document.querySelectorAll(".pp-new-entry-modal")).toHaveLength(confirmationModalCount);
	});

	it("sorts date conflicts newest first and Enter accepts the default", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		catalog.properties.push({
			name: "modified_date",
			kinds: ["string"],
			values: [
				"2026-10-24T10:00:00Z",
				"2026-10-25T10:00:00Z",
				"2026-10-26T10:00:00Z",
			],
		});
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			catalog,
			{
				modified_date: [
					"2026-10-24T10:00:00Z",
					"2026-10-26T10:00:00Z",
					"2026-10-25T10:00:00Z",
				],
			},
			onSubmit,
			vi.fn()
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();

		const radios = modal.contentEl.querySelectorAll<HTMLInputElement>(
			'.pp-conflict-option input[type="radio"]'
		);
		expect(radios[0].value).toBe("2026-10-26T10:00:00Z");
		expect(radios[0].checked).toBe(true);
		radios[0].focus();
		radios[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		expect(onSubmit).toHaveBeenCalledWith({ modified_date: "2026-10-26T10:00:00Z" });
	});

	it("preserves the selected timestamp offset when editing a conflict with the native picker", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		catalog.properties.push({
			name: "modified_date",
			kinds: ["string"],
			values: ["2026-10-24T10:00:00+02:00", "2026-10-25T10:00:00+02:00"],
		});
		const modal = new SelectPropertiesModal(
			app as any,
			catalog,
			{ modified_date: ["2026-10-24T10:00:00+02:00", "2026-10-25T10:00:00+02:00"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();
		modal.contentEl.querySelectorAll<HTMLInputElement>(".pp-conflict-option input")[2]!.click();

		const picker = modal.propertyStates.get("modified_date")!.picker!;
		picker.inputEl.value = "2026-10-26T11:30";
		picker.inputEl.dispatchEvent(new Event("change"));

		expect(modal.propertyStates.get("modified_date")?.selected).toEqual([
			"2026-10-26T11:30+02:00",
		]);
		expect(picker.inputEl.value).toBe("2026-10-26T11:30");
	});

	it("shows only selected list values and removes them without opening suggestions", () => {
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
		expect(castCard.querySelector(".pp-list-actions")).toBeNull();
		expect(castCard.querySelector(".pp-options-container")).toBeNull();
		const picker = modal.propertyStates.get("cast")?.picker!;
		expect(picker.rootEl.dataset.valueStyle).toBe("plain");
		expect(picker.getValue()).toEqual(["Mark Hamill", "Harrison Ford", "Carrie Fisher"]);
		const removeButton = castCard.querySelector<HTMLButtonElement>(".commons-property-picker-remove")!;
		removeButton.focus();
		removeButton.click();
		expect(picker.getValue()).toEqual(["Harrison Ford", "Carrie Fisher"]);
		expect(document.activeElement).not.toBe(picker.inputEl);
		expect(castCard.querySelector(".suggestion-container")).toBeNull();

		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();
		expect(onSubmit).toHaveBeenCalledWith({
			cast: ["Harrison Ford", "Carrie Fisher"],
		});
	});

	it("uses tag bubbles only for the tags list", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ tags: ["dev"], cast: ["Mark Hamill"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		expect(modal.propertyStates.get("tags")?.picker?.rootEl.dataset.valueStyle).toBe("tag");
		expect(modal.propertyStates.get("cast")?.picker?.rootEl.dataset.valueStyle).toBe("plain");
	});

	it("closes on Escape and cannot accept while a conflict has no selected value", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"] },
			onSubmit,
			onCancel
		);
		modal.onOpen();

		modal.clearAll();
		const acceptButton = modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!;
		expect(acceptButton.disabled).toBe(true);
		modal.submit();
		expect(onSubmit).not.toHaveBeenCalled();

		modal.contentEl.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("keeps accept and keyboard guidance visible while the property list scrolls", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		expect(modal.contentEl.querySelector(".pp-select-properties-body")?.contains(
			modal.contentEl.querySelector(".pp-properties-list")
		)).toBe(true);
		expect(modal.contentEl.querySelector(".pp-multi-select-controls")?.parentElement).toBe(modal.contentEl);
		expect(modal.contentEl.querySelector(".pp-keyboard-hint")?.textContent).toContain("Esc cancels");
	});

	it("accepts the current clipboard with Enter from an empty property search", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft" },
			onSubmit,
			vi.fn()
		);
		modal.onOpen();
		modal.contentEl.querySelector<HTMLDetailsElement>(".pp-add-property-details")!.open = true;

		modal.inputEl!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		expect(onSubmit).toHaveBeenCalledWith({ status: "draft" });
	});

	it("leaves Enter available for property suggestions while the search has text", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft" },
			onSubmit,
			vi.fn()
		);
		modal.onOpen();
		modal.contentEl.querySelector<HTMLDetailsElement>(".pp-add-property-details")!.open = true;
		modal.inputEl!.value = "sta";

		modal.inputEl!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("allows adding a property that is not already shown", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const modal = new SelectPropertiesModal(app as any, catalog, {}, vi.fn(), vi.fn());
		modal.onOpen();
		modal.contentEl.querySelector<HTMLDetailsElement>(".pp-add-property-details")!.open = true;

		expect(modal.contentEl.querySelectorAll(".pp-property-card").length).toBe(0);

		modal.addProperty("year");
		expect(modal.contentEl.querySelectorAll(".pp-property-card").length).toBe(1);
		const card = modal.contentEl.querySelector(".pp-property-card")!;
		expect(card.querySelector(".pp-property-name")?.textContent).toBe("year");
		expect(card.querySelector(".pp-property-badge")?.textContent).toBe("Scalar");
	});

	it("adds a suggested property through the shared ValuePicker and focuses its value input", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ tags: ["dev"] },
			vi.fn(),
			vi.fn()
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		modal.contentEl.querySelector<HTMLDetailsElement>(".pp-add-property-details")!.open = true;

		const propertyInput = modal.inputEl!;
		expect(propertyInput.classList.contains("commons-property-picker-input")).toBe(true);
		const suggester = getInputSuggest(propertyInput);
		expect(suggester.suggestions("")).toEqual([]);
		propertyInput.value = "sta";
		const option = suggester
			.suggestions("sta")
			.find((candidate: any) => candidate.kind === "suggestion" && candidate.value === "status");
		expect(option).toBeDefined();
		suggester.select(option);

		const state = modal.propertyStates.get("status");
		expect(state).toBeDefined();
		expect(state?.picker?.inputEl).toBe(document.activeElement);
		expect(propertyInput.value).toBe("");
	});

	it("creates a typed property through the shared picker confirmation action", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(app as any, createMockCatalog(), {}, vi.fn(), vi.fn());
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		modal.contentEl.querySelector<HTMLDetailsElement>(".pp-add-property-details")!.open = true;
		const propertyInput = modal.inputEl!;
		propertyInput.value = "custom_property";
		const suggester = getInputSuggest(propertyInput);
		const createOption = suggester
			.suggestions("custom_property")
			.find((candidate: any) => candidate.kind === "create");
		expect(createOption).toBeDefined();

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			const createButton = Array.from(
				this.contentEl.querySelectorAll<HTMLButtonElement>(".commons-new-entry-button")
			).find((button) => button.textContent?.startsWith('Create "custom_property"'));
			expect(createButton).toBeDefined();
			createButton!.click();
		};
		suggester.select(createOption);

		const state = modal.propertyStates.get("custom_property");
		expect(state).toBeDefined();
		expect(state?.picker?.inputEl).toBe(document.activeElement);
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
		expect(excludeButton.textContent).toBe("Exclude");
		expect(excludeButton.title).toBe("Exclude this property from the selection");
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

	it("keeps checkbox false and true values distinct and returns a boolean selection", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		catalog.properties.push({
			name: "favorite",
			kinds: ["boolean"],
			values: ["false", "true"],
		});
		const modal = new SelectPropertiesModal(
			app as any,
			catalog,
			{ favorite: [false, true] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();

		const card = modal.contentEl.querySelector(".pp-property-card")!;
		const options = card.querySelectorAll(".pp-conflict-option");
		expect(options[0].querySelector(".pp-conflict-value")?.textContent).toBe("false");
		expect(options[1].querySelector(".pp-conflict-value")?.textContent).toBe("true");
		options[0].querySelector<HTMLInputElement>("input")!.click();

		expect(modal.propertyStates.get("favorite")?.hasConflict).toBe(true);
		expect(modal.getSelectedProperties()).toEqual({ favorite: false });
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
		expect(card.querySelectorAll(".pp-option-pill")).toHaveLength(0);
		expect(card.querySelector(".pp-property-notice")?.textContent).toContain(
			"Note-06 had tags twice with the same value; it will be pasted once."
		);
		expect(
			Array.from(card.querySelectorAll<HTMLElement>(".commons-property-picker-chip")).every(
				(chip) => chip.dataset.entry === undefined
			)
		).toBe(true);
		expect(card.querySelector<HTMLElement>(".commons-property-picker-status")?.hidden).toBe(true);
		expect(card.querySelector(".commons-property-picker")?.dataset.valueStyle).toBe("tag");
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
			expect(this.titleEl.textContent).toBe("Resolve property conflicts");
			expect(
				Array.from(this.contentEl.querySelectorAll(".pp-property-name")).map((element: any) =>
					element.textContent
				)
			).toEqual(["status", "tags"]);
			// Confirm conflicting status has options "draft" and "published"
			const statusCard = Array.from(this.contentEl.querySelectorAll(".pp-property-card")).find(
				(c: any) => c.querySelector(".pp-property-name")?.textContent === "status"
			) as HTMLElement;
			expect(statusCard.querySelector(".pp-property-warning")?.textContent).toBe(
				"Choose which status value to keep."
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

	it("shows a tag-only clipboard without adding unrelated properties", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.clipboard = { tags: ["dev"] };

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			expect(this.titleEl.textContent).toBe("Edit property clipboard");
			expect(
				Array.from(this.contentEl.querySelectorAll(".pp-property-name")).map((element: any) =>
					element.textContent
				)
			).toEqual(["tags"]);
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.editPropertyClipboard();
		expect(plugin.clipboard).toEqual({ tags: ["dev"] });
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
