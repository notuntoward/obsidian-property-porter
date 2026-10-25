// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as obsidianMock from "obsidian";
import { ConfirmNewEntryModal } from "commons/properties";
import PropertyPorter, {
	SelectPropertiesModal,
	NOTICE_CLEARED_COPIED_PROPERTIES,
} from "../src/main";
import { PropertyNameSuggest, addedStatusText, propertyTypeLabel } from "../src/select-properties-modal";
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
			on: (event: string, callback: (...args: any[]) => void) => ({ event, callback }),
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

function getModalShortcut(modal: SelectPropertiesModal, modifiers: string[], key: string): any {
	const register = vi.spyOn(modal.scope, "register");
	modal.onOpen();
	const registration = register.mock.calls.find(
		([registeredModifiers, registeredKey]) =>
			registeredKey === key &&
			JSON.stringify(registeredModifiers) === JSON.stringify(modifiers)
	);
	expect(registration).toBeDefined();
	return registration?.[2];
}

const originalModalOpen = obsidianMock.Modal.prototype.open;

function key(target: HTMLElement, name: string, init: KeyboardEventInit = {}): KeyboardEvent {
	const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

function pressEscape(modal: SelectPropertiesModal): void {
	const handler = (modal.scope as any).handlers.find(
		(candidate: any) => candidate.key === "Escape" && candidate.modifiers?.length === 0
	);
	expect(handler).toBeDefined();
	expect(handler.fn(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
}

function openAddProperty(modal: SelectPropertiesModal): void {
	key(modal.contentEl.querySelector<HTMLElement>(".pp-add-property-row")!, "Enter");
}

afterEach(() => {
	obsidianMock.Modal.prototype.open = originalModalOpen;
	vi.restoreAllMocks();
});

describe("SelectPropertiesModal", () => {
	it("registers Mod+Enter to submit and return false", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft" },
			onSubmit,
			vi.fn()
		);
		const submitShortcut = getModalShortcut(modal, ["Mod"], "Enter");

		expect(submitShortcut(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
		expect(onSubmit).toHaveBeenCalledWith({ status: "draft" });
	});

	it("moves focus between property cards with Alt+ArrowUp and Alt+ArrowDown", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft", title: "A New Hope" },
			vi.fn(),
			vi.fn()
		);
		const register = vi.spyOn(modal.scope, "register");
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const downRegistration = register.mock.calls.find(
			([modifiers, key]) => key === "ArrowDown" && JSON.stringify(modifiers) === JSON.stringify(["Alt"])
		);
		const upRegistration = register.mock.calls.find(
			([modifiers, key]) => key === "ArrowUp" && JSON.stringify(modifiers) === JSON.stringify(["Alt"])
		);
		expect(downRegistration).toBeDefined();
		expect(upRegistration).toBeDefined();

		const firstCard = modal.propertyStates.get("status")!.cardEl!;
		const secondCard = modal.propertyStates.get("title")!.cardEl!;
		modal.propertyStates.get("status")!.picker!.inputEl.focus();
		downRegistration?.[2](new KeyboardEvent("keydown", { key: "ArrowDown" }));
		expect(document.activeElement).toBe(secondCard);
		upRegistration?.[2](new KeyboardEvent("keydown", { key: "ArrowUp" }));
		expect(document.activeElement).toBe(firstCard);
	});

	it("selects conflict candidates with number keys and opens Other value with O", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();
		const radios = modal.contentEl.querySelectorAll<HTMLInputElement>(".pp-conflict-option input");
		const selectSecond = new KeyboardEvent("keydown", { key: "2", bubbles: true, cancelable: true });
		radios[0]!.dispatchEvent(selectSecond);
		expect(selectSecond.defaultPrevented).toBe(true);
		expect(radios[1]!.checked).toBe(true);
		expect(modal.propertyStates.get("status")?.selected).toEqual(["published"]);

		const outOfRange = new KeyboardEvent("keydown", { key: "3", bubbles: true, cancelable: true });
		radios[1]!.dispatchEvent(outOfRange);
		expect(outOfRange.defaultPrevented).toBe(false);
		expect(radios[2]!.checked).toBe(false);

		const selectOther = new KeyboardEvent("keydown", { key: "o", bubbles: true, cancelable: true });
		radios[1]!.dispatchEvent(selectOther);
		expect(selectOther.defaultPrevented).toBe(true);
		expect(radios[2]!.checked).toBe(true);
		expect(modal.propertyStates.get("status")?.picker).toBeDefined();
	});

	it("binds no Alt+X, Delete or Backspace shortcut", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft", title: "A New Hope" },
			vi.fn(),
			vi.fn()
		);
		const register = vi.spyOn(modal.scope, "register");
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const registered = register.mock.calls.map(([modifiers, key]) => `${modifiers.join("+")}|${key}`);
		expect(registered).not.toContain("Alt|X");
		expect(registered.some((entry) => /Backspace|Delete/.test(entry))).toBe(false);

		const row = modal.propertyStates.get("status")!.cardEl!;
		row.focus();
		key(row, "x", { altKey: true });
		expect(modal.propertyStates.has("status")).toBe(true);
		expect(modal.propertyStates.get("status")!.skipped).toBe(false);
	});

	it("does not submit on plain Enter while a suggestion dropdown is open", () => {
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
		const dropdown = document.createElement("div");
		dropdown.className = "suggestion-container";
		document.body.appendChild(dropdown);
		try {
			modal.inputEl!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
			expect(onSubmit).not.toHaveBeenCalled();
		} finally {
			dropdown.remove();
		}
	});

	it("Escape leaves an open row first and only then cancels the modal", () => {
		const { app } = createApp();
		const onCancel = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft" },
			vi.fn(),
			onCancel
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const card = modal.propertyStates.get("status")!.cardEl!;
		card.focus();
		key(card, "Enter");
		const input = modal.propertyStates.get("status")!.picker!.inputEl;
		expect(document.activeElement).toBe(input);
		expect(card.classList.contains("is-open")).toBe(true);

		pressEscape(modal);
		expect(document.activeElement).toBe(card);
		expect(card.classList.contains("is-open")).toBe(false);
		expect(onCancel).not.toHaveBeenCalled();

		pressEscape(modal);
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("leaves Escape to an open suggestion list instead of leaving the row", () => {
		const { app } = createApp();
		const onCancel = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft" },
			vi.fn(),
			onCancel
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		openAddProperty(modal);
		const input = modal.inputEl!;
		expect(document.activeElement).toBe(input);
		const dropdown = document.createElement("div");
		dropdown.className = "suggestion-container";
		dropdown.createDiv({ cls: "suggestion-item" });
		document.body.appendChild(dropdown);
		try {
			(modal as any).navigator.leaveOpenRow(input);
			expect(document.activeElement).toBe(input);
		} finally {
			dropdown.remove();
		}
	});

	it("labels property cards and updates live keyboard guidance for the focused control", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"] },
			vi.fn(),
			vi.fn()
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const card = modal.contentEl.querySelector<HTMLElement>(".pp-property-card")!;
		const name = card.querySelector<HTMLElement>(".pp-property-name")!;
		expect(card.getAttribute("role")).toBe("group");
		expect(card.getAttribute("aria-labelledby")).toBe(name.id);
		expect(modal.contentEl.querySelector(".pp-keyboard-hint")?.getAttribute("aria-live")).toBe("polite");

		const hint = modal.contentEl.querySelector(".pp-keyboard-hint")!;
		card.querySelector<HTMLInputElement>(".pp-conflict-option input")!.focus();
		expect(hint.textContent).toContain("1-9");
		card.querySelectorAll<HTMLInputElement>(".pp-conflict-option input")[2]!.click();
		modal.propertyStates.get("status")!.picker!.inputEl.focus();
		expect(hint.textContent).toContain("Backspace");
		card.focus();
		expect(hint.textContent).toContain("Enter choose value");
		expect(hint.textContent).not.toContain("Enter edit");
		modal.contentEl.querySelector<HTMLInputElement>(".pp-property-skip-checkbox")!.focus();
		expect(hint.textContent).toContain("Esc done");
	});

	it.each([
		["clipboard editor", {}],
		["conflict resolver", { conflictNames: ["status"] }],
	])("places the add-property row above the property list in the %s", (_label, options: any) => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"], title: "x" },
			vi.fn(),
			vi.fn(),
			{},
			options
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const addRow = modal.contentEl.querySelector(".pp-add-property-row")!;
		const list = modal.contentEl.querySelector(".pp-properties-list:not(.pp-conflicts-list)")!;
		expect(addRow).not.toBeNull();
		expect(addRow.parentElement).toBe(list.parentElement);
		expect(addRow.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});

	it("shows an Enter hint in each card header, worded for conflicts and plain rows", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"], title: "x" },
			vi.fn(),
			vi.fn(),
			{},
			{ conflictNames: ["status"] }
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		expect(modal.contentEl.querySelector(".pp-property-enter-hint")).toBeNull();
		const hint = modal.contentEl.querySelector(".pp-keyboard-hint")!;
		modal.propertyStates.get("status")!.cardEl!.focus();
		expect(hint.textContent).toContain("Enter choose value");
	});

	it("renders non-conflict cards compact and keeps conflict cards stacked", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"], tags: ["dev"] },
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();
		expect(modal.propertyStates.get("status")!.cardEl!.classList.contains("is-compact")).toBe(false);
		expect(modal.propertyStates.get("tags")!.cardEl!.classList.contains("is-compact")).toBe(true);
	});

	it("opens with the first conflict row highlighted, not open", () => {
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
			expect(document.activeElement).toBe(modal.propertyStates.get("status")!.cardEl);
			expect(modal.contentEl.querySelector(".pp-add-property-row .pp-search-container")?.hasAttribute("hidden")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["tags", "tag copies"],
		["add", "property copies"],
	] as const)("opens on %s for %s when nothing conflicts", (initialFocus) => {
		vi.useFakeTimers();
		try {
			const { app } = createApp();
			const modal = new SelectPropertiesModal(
				app as any,
				createMockCatalog(),
				{ status: "draft", tags: ["dev"] },
				vi.fn(),
				vi.fn(),
				{},
				{ title: "Edit property clipboard", initialFocus }
			);
			document.body.appendChild(modal.contentEl);
			modal.onOpen();
			vi.runOnlyPendingTimers();

			const addRow = modal.contentEl.querySelector(".pp-add-property-row")!;
			expect(document.activeElement).toBe(
				initialFocus === "tags" ? modal.propertyStates.get("tags")!.cardEl : addRow
			);
			expect(addRow.nextElementSibling?.classList.contains("pp-properties-list")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("always opens a conflict resolver on the first conflict", () => {
		vi.useFakeTimers();
		try {
			const { app } = createApp();
			const modal = new SelectPropertiesModal(
				app as any,
				createMockCatalog(),
				{ tags: ["dev"], status: ["draft", "published"] },
				vi.fn(),
				vi.fn(),
				{},
				{ conflictNames: ["status"], initialFocus: "tags" }
			);
			document.body.appendChild(modal.contentEl);
			modal.onOpen();
			vi.runOnlyPendingTimers();
			expect(document.activeElement).toBe(modal.propertyStates.get("status")!.cardEl);
		} finally {
			vi.useRealTimers();
		}
	});

	it("falls back to the add-property row when the clipboard is empty", () => {
		vi.useFakeTimers();
		try {
			const { app } = createApp();
			const modal = new SelectPropertiesModal(app as any, createMockCatalog(), {}, vi.fn(), vi.fn());
			document.body.appendChild(modal.contentEl);
			modal.onOpen();
			vi.runOnlyPendingTimers();
			expect(document.activeElement).toBe(modal.contentEl.querySelector(".pp-add-property-row"));
		} finally {
			vi.useRealTimers();
		}
	});

	it("cycles Tab through rows, the add row and the buttons, then loops", () => {
		vi.useFakeTimers();
		try {
			const { app } = createApp();
			const modal = new SelectPropertiesModal(
				app as any,
				createMockCatalog(),
				{ tags: ["dev"], status: "draft" },
				vi.fn(),
				vi.fn(),
				{},
				{ initialFocus: "tags" }
			);
			document.body.appendChild(modal.contentEl);
			modal.onOpen();
			vi.runOnlyPendingTimers();

			const expected = [
				modal.propertyStates.get("status")!.cardEl,
				modal.contentEl.querySelector(".pp-skip-all-button"),
				modal.contentEl.querySelector(".pp-finish-button"),
				modal.contentEl.querySelector(".pp-add-property-row"),
				modal.propertyStates.get("tags")!.cardEl,
			];
			for (const stop of expected) {
				key(document.activeElement as HTMLElement, "Tab");
				expect(document.activeElement).toBe(stop);
			}
			key(document.activeElement as HTMLElement, "Tab", { shiftKey: true });
			expect(document.activeElement).toBe(expected[3]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("Enter opens the highlighted tags row and Backspace removes the last tag", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ tags: ["dev", "notes"] },
			onSubmit,
			vi.fn()
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const card = modal.propertyStates.get("tags")!.cardEl!;
		card.focus();
		key(card, "Enter");
		const input = modal.propertyStates.get("tags")!.picker!.inputEl;
		expect(document.activeElement).toBe(input);
		expect(onSubmit).not.toHaveBeenCalled();

		key(input, "Backspace");
		expect(modal.propertyStates.get("tags")!.picker!.getValue()).toEqual(["dev"]);
		key(input, "Enter");
		expect(document.activeElement).toBe(card);
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("Enter accepts when no row or button is focused", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ tags: ["dev"] },
			onSubmit,
			vi.fn()
		);
		modal.onOpen();
		key(modal.contentEl.querySelector<HTMLElement>(".pp-select-properties-body")!, "Enter");
		expect(onSubmit).toHaveBeenCalledWith({ tags: ["dev"] });
	});

	it("a newly added property opens for editing and joins the Tab cycle after the other rows", () => {
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
		openAddProperty(modal);
		const state = modal.addProperty("status")!;
		state.picker!.inputEl.focus();
		expect(state.cardEl!.classList.contains("is-open")).toBe(true);

		pressEscape(modal);
		expect(document.activeElement).toBe(state.cardEl);
		key(state.cardEl!, "Tab");
		expect(document.activeElement).toBe(modal.contentEl.querySelector(".pp-skip-all-button"));
		expect(modal.contentEl.querySelector(".pp-add-property-row .pp-search-container")?.hasAttribute("hidden")).toBe(true);
	});

	it("Escape after Enter on the add row returns to the row even with a stale suggestion container", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(app as any, createMockCatalog(), { tags: ["dev"] }, vi.fn(), vi.fn());
		const close = vi.spyOn(modal, "close");
		document.body.appendChild(modal.contentEl);
		const stale = document.body.createDiv({ cls: "suggestion-container" });
		modal.onOpen();
		const addRow = modal.contentEl.querySelector<HTMLElement>(".pp-add-property-row")!;
		openAddProperty(modal);
		expect(document.activeElement).toBe(modal.inputEl);

		pressEscape(modal);
		expect(close).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(addRow);
		key(addRow, "Tab");
		expect(document.activeElement).not.toBe(addRow);
		stale.remove();
	});

	it("clicking the add row or a card opens it for mouse users", () => {
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
		modal.contentEl.querySelector<HTMLElement>(".pp-add-property-label")!.click();
		expect(document.activeElement).toBe(modal.inputEl);
		modal.propertyStates.get("tags")!.cardEl!.querySelector<HTMLElement>(".pp-property-name")!.click();
		expect(document.activeElement).toBe(modal.propertyStates.get("tags")!.picker!.inputEl);
	});

	it("shows the copy type as a titled badge", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ tags: ["dev"] },
			vi.fn(),
			vi.fn(),
			{},
			{ title: "Edit property clipboard", subtitle: "Tag copy", subtitleHint: "union" }
		);
		modal.onOpen();
		const badge = modal.titleEl.querySelector(".pp-clipboard-mode")!;
		expect(badge.textContent).toBe("Tag copy");
		expect(badge.getAttribute("title")).toBe("union");
	});

	it("has no Alt+N shortcut: the add-property row is reached with Tab and opened with Enter", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(app as any, createMockCatalog(), { tags: ["dev"] }, vi.fn(), vi.fn());
		const register = vi.spyOn(modal.scope, "register");
		modal.onOpen();
		expect(register.mock.calls.some(([modifiers, key]) => modifiers?.[0] === "Alt" && key === "N")).toBe(false);
	});

	it.each([
		["clipboard editor", { title: "Edit property clipboard" }],
		["conflict resolver", { title: "Resolve property conflicts", conflictNames: ["status"] }],
	])("shows and accepts the mouse submit button in the %s", (_name, options) => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			options.conflictNames ? { status: ["draft", "published"] } : { tags: ["dev"] },
			onSubmit,
			vi.fn(),
			{},
			options
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		if (options.conflictNames) {
			modal.contentEl.querySelector<HTMLInputElement>('.pp-conflict-option input[value="draft"]')!.click();
		}
		const controls = modal.contentEl.querySelector(".pp-multi-select-controls")!;
		const acceptButton = controls.querySelector<HTMLButtonElement>(".pp-finish-button")!;

		expect(acceptButton.isConnected).toBe(true);
		expect(acceptButton.parentElement?.classList.contains("pp-multi-select-buttons")).toBe(true);
		acceptButton.click();

		expect(onSubmit).toHaveBeenCalled();
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

		expect(tagsCard?.querySelector(".pp-property-type")?.getAttribute("aria-label")).toBe("Tags");
		expect(statusCard?.querySelector(".pp-property-type")?.getAttribute("aria-label")).toBe("Text");
		expect(tagsCard?.querySelector(".pp-property-type")?.getAttribute("data-icon")).toBe("tags");
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
		const register = vi.spyOn(modal.scope, "register");
		modal.onOpen();

		const statusCard = modal.contentEl.querySelector(".pp-property-card")!;
		expect(statusCard).not.toBeNull();
		expect(statusCard.querySelector(".pp-property-warning")?.textContent).toBe(
			"Conflict: status has different values. Pick one or skip it."
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

		expect(modal.contentEl.querySelector(".pp-conflict-section .pp-section-title")?.textContent).toBe(
			"Conflicts"
		);
		expect(modal.contentEl.querySelector(".pp-conflict-info")?.textContent).toBe(
			"Each property below has different values. Pick one, or skip it."
		);
		expect(modal.contentEl.querySelector(".pp-properties-section .pp-section-title")?.textContent).toBe("Other properties");
		expect(modal.contentEl.querySelector(".pp-properties-section .pp-properties-info")?.textContent).toBe(
			"These properties have no conflicts and need no action. Edit or skip them only if you want."
		);
		const addPropertyRow = modal.contentEl.querySelector(".pp-properties-section .pp-add-property-row");
		expect(addPropertyRow?.querySelector(".pp-add-property-label")?.textContent).toBe("+ Add property");
		expect(addPropertyRow?.nextElementSibling?.classList.contains("pp-properties-list")).toBe(true);

		radios[1].click();
		expect(radios[1].checked).toBe(true);
		expect(modal.propertyStates.get("status")?.selected).toEqual(["published"]);
		expect(modal.getSelectedProperties()).toEqual({ status: "published" });

		const modEnter = register.mock.calls.find(
			([modifiers, key]) => key === "Enter" && JSON.stringify(modifiers) === JSON.stringify(["Mod"])
		);
		expect(modEnter).toBeDefined();
		modEnter?.[2](new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true }));

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
		expect(card.querySelector(".pp-property-warning")?.textContent).toBe("Conflict: status has different values. Pick one or skip it.");
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

	it("sorts date conflicts newest first and Enter on the highlighted conflict does not accept", () => {
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
		expect(onSubmit).not.toHaveBeenCalled();

		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.click();
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

	it("uses the newly selected candidate offset when editing another datetime value", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		catalog.properties.push({
			name: "modified_date",
			kinds: ["string"],
			values: ["2026-10-24T10:00:00-07:00", "2026-10-25T10:00:00+02:00"],
		});
		const modal = new SelectPropertiesModal(
			app as any,
			catalog,
			{
				modified_date: [
					"2026-10-24T10:00:00-07:00",
					"2026-10-25T10:00:00+02:00",
				],
			},
			vi.fn(),
			vi.fn()
		);
		modal.onOpen();
		const radios = modal.contentEl.querySelectorAll<HTMLInputElement>(".pp-conflict-option input");
		radios[0]!.click();
		radios[2]!.click();

		const picker = modal.propertyStates.get("modified_date")!.picker!;
		picker.inputEl.value = "2026-10-26T11:30";
		picker.inputEl.dispatchEvent(new Event("change"));

		expect(modal.propertyStates.get("modified_date")?.selected).toEqual([
			"2026-10-26T11:30+02:00",
		]);
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
		expect(castCard.querySelector(".pp-property-type")?.getAttribute("aria-label")).toBe("List");
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

	it("lets Continue proceed with an unresolved conflict, leaving that property out", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: ["draft", "published"] },
			onSubmit,
			vi.fn()
		);
		modal.onOpen();

		modal.contentEl.querySelectorAll<HTMLInputElement>(".pp-conflict-option input")[2]!.click();
		const acceptButton = modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!;
		expect(acceptButton.disabled).toBe(false);
		acceptButton.click();
		expect(onSubmit).toHaveBeenCalledWith({});
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
		document.body.appendChild(modal.contentEl);
		modal.onOpen();

		expect(modal.contentEl.querySelector(".pp-select-properties-body")?.contains(
			modal.contentEl.querySelector(".pp-properties-list")
		)).toBe(true);
		expect(modal.contentEl.querySelector(".pp-multi-select-controls")?.parentElement).toBe(modal.contentEl);
		modal.contentEl.querySelector<HTMLButtonElement>(".pp-finish-button")!.focus();
		expect(modal.contentEl.querySelector(".pp-keyboard-hint")?.textContent).toContain("Esc cancel");
	});

	it("saves with Enter from nothing highlighted but not from inside an empty property search", () => {
		const { app } = createApp();
		const onSubmit = vi.fn();
		const modal = new SelectPropertiesModal(
			app as any,
			createMockCatalog(),
			{ status: "draft" },
			onSubmit,
			vi.fn()
		);
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		openAddProperty(modal);

		key(modal.inputEl!, "Enter");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(modal.contentEl.querySelector(".pp-add-property-row"));
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
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		openAddProperty(modal);
		modal.inputEl!.value = "sta";

		key(modal.inputEl!, "Enter");

		expect(onSubmit).not.toHaveBeenCalled();
		expect(document.activeElement).toBe(modal.inputEl);
	});

	it("allows adding a property that is not already shown", () => {
		const { app } = createApp();
		const catalog = createMockCatalog();
		const modal = new SelectPropertiesModal(app as any, catalog, {}, vi.fn(), vi.fn());
		modal.onOpen();

		expect(modal.contentEl.querySelectorAll(".pp-property-card").length).toBe(0);

		modal.addProperty("year");
		expect(modal.contentEl.querySelectorAll(".pp-property-card").length).toBe(1);
		const card = modal.contentEl.querySelector(".pp-property-card")!;
		expect(card.querySelector(".pp-property-name")?.textContent).toBe("year");
		expect(card.querySelector(".pp-property-type")?.getAttribute("aria-label")).toBe("Number");
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
		openAddProperty(modal);

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
		openAddProperty(modal);
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

	describe("skipping properties", () => {
		function openModal(initial: Record<string, unknown>, onSubmit = vi.fn(), onCancel = vi.fn()) {
			const { app } = createApp();
			const modal = new SelectPropertiesModal(app as any, createMockCatalog(), initial, onSubmit, onCancel);
			document.body.appendChild(modal.contentEl);
			modal.onOpen();
			const card = (name: string) => modal.propertyStates.get(name)!.cardEl!;
			const skipBox = (name: string) =>
				card(name).querySelector<HTMLInputElement>(".pp-property-skip-checkbox")!;
			const button = (cls: string) => modal.contentEl.querySelector<HTMLButtonElement>(cls)!;
			const status = () => modal.contentEl.querySelector(".pp-multi-select-hint")!.textContent;
			const hint = () => modal.contentEl.querySelector(".pp-keyboard-hint")!.textContent;
			return { modal, card, skipBox, button, status, hint, onSubmit, onCancel };
		}

		it("replaces the X button with a Skip checkbox on non-conflict rows", () => {
			const { card, skipBox } = openModal({ status: "draft" });
			expect(card("status").querySelector(".pp-property-remove-btn")).toBeNull();
			expect(skipBox("status").type).toBe("checkbox");
			expect(skipBox("status").getAttribute("aria-label")).toBe("Skip property");
			expect(skipBox("status").title).toBe("Skip property");
		});

		it("Space on the focused row toggles skipped and added", () => {
			const { modal, card, skipBox } = openModal({ status: "draft", title: "A New Hope" });
			card("status").focus();
			const event = key(card("status"), " ");
			expect(event.defaultPrevented).toBe(true);
			expect(modal.propertyStates.get("status")!.skipped).toBe(true);
			expect(card("status").classList.contains("is-skipped")).toBe(true);
			expect(skipBox("status").checked).toBe(true);
			expect(skipBox("status").title).toBe("Add back");
			expect(card("status").querySelector(".pp-property-skipped-badge")).toBeNull();
			expect(document.activeElement).toBe(card("status"));

			key(card("status"), " ");
			expect(modal.propertyStates.get("status")!.skipped).toBe(false);
			expect(card("status").classList.contains("is-skipped")).toBe(false);
			expect(skipBox("status").title).toBe("Skip property");
		});

		it("Space inside a value input types a space instead of toggling", () => {
			const { modal } = openModal({ status: "draft" });
			const input = modal.propertyStates.get("status")!.picker!.inputEl;
			input.focus();
			const event = key(input, " ");
			expect(event.defaultPrevented).toBe(false);
			expect(modal.propertyStates.get("status")!.skipped).toBe(false);
		});

		it("a mouse click toggles the state and leaves focus on the row", () => {
			const { modal, card, skipBox } = openModal({ status: "draft" });
			skipBox("status").focus();
			skipBox("status").click();
			expect(modal.propertyStates.get("status")!.skipped).toBe(true);
			expect(document.activeElement).toBe(card("status"));
			skipBox("status").click();
			expect(modal.propertyStates.get("status")!.skipped).toBe(false);
			expect(document.activeElement).toBe(card("status"));
		});

		it("keeps values on a skipped row and restores them when added back", () => {
			const { modal, card, onSubmit, button } = openModal({ cast: ["Mark Hamill", "Carrie Fisher"], title: "x" });
			card("cast").focus();
			key(card("cast"), " ");
			expect(modal.propertyStates.get("cast")!.picker!.getValue()).toEqual(["Mark Hamill", "Carrie Fisher"]);
			key(card("cast"), " ");
			button(".pp-finish-button").click();
			expect(onSubmit).toHaveBeenCalledWith({ cast: ["Mark Hamill", "Carrie Fisher"], title: "x" });
		});

		it("leaves skipped properties out only when Continue is pressed", () => {
			const { card, onSubmit, button } = openModal({ status: "draft", title: "x" });
			card("title").focus();
			key(card("title"), " ");
			expect(onSubmit).not.toHaveBeenCalled();
			button(".pp-finish-button").click();
			expect(onSubmit).toHaveBeenCalledWith({ status: "draft" });
		});

		it("Skip all and Add all toggle every row without clearing values and set disabled states", () => {
			const { modal, button } = openModal({ status: "draft", title: "x" });
			expect(button(".pp-skip-all-button").disabled).toBe(false);
			expect(button(".pp-add-all-button").disabled).toBe(true);

			button(".pp-skip-all-button").click();
			expect([...modal.propertyStates.values()].every((state) => state.skipped)).toBe(true);
			expect(modal.propertyStates.get("status")!.picker!.getValue()).toEqual(["draft"]);
			expect(button(".pp-skip-all-button").disabled).toBe(true);
			expect(button(".pp-add-all-button").disabled).toBe(false);

			button(".pp-add-all-button").click();
			expect([...modal.propertyStates.values()].some((state) => state.skipped)).toBe(false);
			expect(button(".pp-skip-all-button").disabled).toBe(false);
			expect(button(".pp-add-all-button").disabled).toBe(true);
		});

		it("updates N, the Continue label and the status line live", () => {
			const { card, button, status } = openModal({ status: "draft", title: "x", year: "1977" });
			expect(button(".pp-finish-button").textContent).toBe("Continue (3)");
			expect(status()).toBe("3 properties will be added to the note.");

			card("year").focus();
			key(card("year"), " ");
			expect(button(".pp-finish-button").textContent).toBe("Continue (2)");
			expect(status()).toBe("2 properties will be added. 1 skipped.");

			card("title").focus();
			key(card("title"), " ");
			expect(status()).toBe("1 property will be added. 2 skipped.");
			expect(button(".pp-finish-button").title).toBe("");

			card("status").focus();
			key(card("status"), " ");
			expect(button(".pp-finish-button").textContent).toBe("Continue (0)");
			expect(status()).toBe("No properties will be added. Continue will clear the copied properties.");
			expect(button(".pp-finish-button").title).toBe("Close and clear copied properties");
		});

		it("labels property types with Obsidian's names", () => {
			expect(propertyTypeLabel("tags", true)).toBe("Tags");
			expect(propertyTypeLabel("x", true)).toBe("List");
			expect(propertyTypeLabel("x", false, "number")).toBe("Number");
			expect(propertyTypeLabel("x", false, "checkbox")).toBe("Checkbox");
			expect(propertyTypeLabel("x", false, "date")).toBe("Date");
			expect(propertyTypeLabel("x", false, "datetime")).toBe("Date & time");
			expect(propertyTypeLabel("x", false, "text")).toBe("Text");
			expect(propertyTypeLabel("x", false)).toBe("Text");
		});

		it("formats the single-property status without skips", () => {
			expect(addedStatusText(1, 0)).toBe("1 property will be added to the note.");
			expect(addedStatusText(0, 0)).toBe(
				"No properties will be added. Continue will clear the copied properties."
			);
		});

		it("Continue at N = 0 submits an empty selection and closes without cancelling", () => {
			const { button, onSubmit, onCancel } = openModal({ status: "draft" });
			button(".pp-skip-all-button").click();
			button(".pp-finish-button").click();
			expect(onSubmit).toHaveBeenCalledWith({});
			expect(onCancel).not.toHaveBeenCalled();
		});

		it("Ctrl/Cmd+Enter continues", () => {
			const { modal, onSubmit } = openModal({ status: "draft", title: "x" });
			modal.propertyStates.get("title")!.skipped = true;
			const handler = (modal.scope as any).handlers.find(
				(candidate: any) => candidate.key === "Enter" && candidate.modifiers?.[0] === "Mod"
			);
			handler.fn(new KeyboardEvent("keydown", { key: "Enter" }));
			expect(onSubmit).toHaveBeenCalledWith({ status: "draft" });
		});

		it("Esc cancels without submitting or changing skip states", () => {
			const { modal, card, onSubmit, onCancel } = openModal({ status: "draft", title: "x" });
			card("title").focus();
			key(card("title"), " ");
			pressEscape(modal);
			expect(onCancel).toHaveBeenCalledTimes(1);
			expect(onSubmit).not.toHaveBeenCalled();
			expect(modal.propertyStates.get("title")!.skipped).toBe(true);
			expect(modal.propertyStates.get("status")!.skipped).toBe(false);
		});

		it("words the footer hint by focus: Space skip, Space add back, none inside inputs", () => {
			const { modal, card, hint } = openModal({ status: "draft", cast: ["Mark Hamill"] });
			card("status").focus();
			expect(hint()).toBe("Enter edit Tab next Space skip Ctrl/Cmd+Enter continue Esc cancel");
			key(card("status"), " ");
			expect(hint()).toContain("Space add back");
			expect(hint()).not.toContain("Space skip");
			modal.propertyStates.get("cast")!.picker!.inputEl.focus();
			expect(hint()).not.toContain("Space");
			expect(hint()).toContain("Ctrl/Cmd+Enter continue");
		});

		it("uses 'Enter choose value' on conflict rows", () => {
			const { card, hint } = openModal({ status: ["draft", "published"] });
			card("status").focus();
			expect(hint()).toContain("Enter choose value");
		});

		it("conflict rows get the same bare Skip checkbox; a skipped conflict does not block Continue", () => {
			const { modal, card, skipBox, hint, button, onSubmit } = openModal({
				status: ["draft", "published"],
				title: "x",
			});
			expect(card("status").querySelector(".pp-property-remove-btn")).toBeNull();
			expect(card("status").querySelector(".pp-property-skip-text")).toBeNull();
			expect(skipBox("status").getAttribute("aria-label")).toBe("Skip property");
			card("status").focus();
			expect(hint()).toContain("Space skip");
			key(card("status"), " ");
			expect(modal.propertyStates.get("status")!.skipped).toBe(true);
			expect(hint()).toContain("Space add back");
			expect(button(".pp-finish-button").disabled).toBe(false);
			button(".pp-finish-button").click();
			expect(onSubmit).toHaveBeenCalledWith({ title: "x" });
		});

		it("Skip all also skips conflict rows", () => {
			const { modal, button } = openModal({ status: ["draft", "published"] });
			button(".pp-skip-all-button").click();
			expect(modal.propertyStates.get("status")!.skipped).toBe(true);
			expect(button(".pp-skip-all-button").disabled).toBe(true);
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
				"Conflict: status has different values. Pick one or skip it."
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

	it("labels values added in the clipboard editor so conflict cards show a source", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.clipboard = { title: "a", status: "x" };
		(plugin as any).clipboardValueSources = {
			title: { a: [{ note: "Note A", count: 1 }] },
		};
		vi.spyOn(plugin as any, "openPropertySelectionModal").mockResolvedValue({
			cancelled: false,
			properties: { title: ["a", "b"].slice(1)[0], status: "x" },
		});

		await plugin.editPropertyClipboard();

		const sources = (plugin as any).clipboardValueSources;
		expect(sources.title).toEqual({ b: [{ note: "Edited clipboard", count: 1 }] });
		expect(sources.status).toBeUndefined();
	});

	it("keeps a single selection modal open: a new one cancels the previous", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		const first = plugin.openPropertySelectionModal({ tags: ["a"] });
		const second = plugin.openPropertySelectionModal({ tags: ["b"] });

		await expect(first).resolves.toEqual({ properties: {}, skipped: {}, propertyTypes: {}, cancelled: true });
		const open = (plugin as any).selectionModal;
		expect(open).not.toBeNull();
		open.close();
		await expect(second).resolves.toEqual({ properties: {}, skipped: {}, propertyTypes: {}, cancelled: true });
		expect((plugin as any).selectionModal).toBeNull();
	});

	it("shows a tag-only clipboard without adding unrelated properties", async () => {
		const { plugin } = createPlugin();
		await plugin.onload();
		plugin.clipboard = { tags: ["dev"] };
		plugin.clipboardKind = "tags";

		obsidianMock.Modal.prototype.open = function (this: any) {
			this.onOpen();
			expect(this.titleEl.childNodes[0]?.textContent).toBe("Edit property clipboard");
			const modeBadge = this.titleEl.querySelector(".pp-clipboard-mode");
			expect(modeBadge?.textContent).toBe("Tag copy");
			expect(modeBadge?.parentElement).toBe(this.titleEl);
			expect(this.contentEl.querySelector(".pp-clipboard-mode")).toBeNull();
			expect(
				Array.from(this.contentEl.querySelectorAll(".pp-property-name")).map((element: any) =>
					element.textContent
				)
			).toEqual(["tags"]);
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.editPropertyClipboard();
		expect(plugin.clipboard).toEqual({ tags: ["dev"] });
		expect(plugin.clipboardKind).toBe("tags");
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
			this.skipAll();
			this.contentEl.querySelector(".pp-finish-button").click();
		};

		await plugin.selectPropertiesToPaste();
		expect(plugin.clipboard).toEqual({});
		expect(spy).toHaveBeenCalledWith(NOTICE_CLEARED_COPIED_PROPERTIES);
	});
});

describe("SelectPropertiesModal Ctrl+N / Ctrl+P", () => {
	function ctrlHandler(modal: SelectPropertiesModal, name: string) {
		const handler = (modal.scope as any).handlers.find(
			(candidate: any) => candidate.key === name && JSON.stringify(candidate.modifiers) === JSON.stringify(["Ctrl"])
		);
		expect(handler).toBeDefined();
		return handler.fn as (event: KeyboardEvent) => boolean;
	}

	it("moves between rows like ArrowDown/ArrowUp and swallows the key", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(app as any, createMockCatalog(), { status: "draft", title: "A New Hope" }, vi.fn(), vi.fn());
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const first = modal.propertyStates.get("status")!.cardEl!;
		const second = modal.propertyStates.get("title")!.cardEl!;
		first.focus();

		expect(ctrlHandler(modal, "n")(new KeyboardEvent("keydown", { key: "n", ctrlKey: true }))).toBe(false);
		expect(document.activeElement).toBe(second);
		ctrlHandler(modal, "p")(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }));
		expect(document.activeElement).toBe(first);
		key(first, "ArrowDown");
		expect(document.activeElement).toBe(second);
	});

	it("steps through conflict choices and leaves text inputs alone", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(app as any, createMockCatalog(), { status: ["draft", "published"], title: "A" }, vi.fn(), vi.fn());
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const radios = modal.contentEl.querySelectorAll<HTMLInputElement>(".pp-conflict-option input");
		radios[0]!.focus();
		ctrlHandler(modal, "n")(new KeyboardEvent("keydown", { key: "n", ctrlKey: true }));
		expect(document.activeElement).toBe(radios[1]);
		expect(modal.propertyStates.get("status")?.selected).toEqual(["published"]);
		ctrlHandler(modal, "p")(new KeyboardEvent("keydown", { key: "p", ctrlKey: true }));
		expect(radios[0]!.checked).toBe(true);

		const input = modal.propertyStates.get("title")!.picker!.inputEl;
		input.focus();
		ctrlHandler(modal, "n")(new KeyboardEvent("keydown", { key: "n", ctrlKey: true }));
		expect(document.activeElement).toBe(input);
	});
});

describe("SelectPropertiesModal property type for new properties", () => {
	function openWithNewProperty(name = "brandnew") {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(app as any, createMockCatalog(), { status: "draft" }, vi.fn(), vi.fn());
		document.body.appendChild(modal.contentEl);
		modal.onOpen();
		const state = modal.addProperty(name)!;
		return { modal, state };
	}

	function choose(label: string): void {
		const item = obsidianMock.Menu.last!.items.find((candidate) => candidate.title === label);
		expect(item).toBeDefined();
		item!.onClickCallback?.();
	}

	it("offers Obsidian's type choices on an unknown property only", () => {
		const { modal, state } = openWithNewProperty();
		const button = state.cardEl!.querySelector<HTMLButtonElement>("button.pp-property-type")!;
		button.click();
		expect(obsidianMock.Menu.last!.items.map((item) => item.title)).toEqual([
			"Automatic", "Text", "List", "Number", "Checkbox", "Date", "Date & time",
		]);
		expect(modal.propertyStates.get("status")!.cardEl!.querySelector("button.pp-property-type")).toBeNull();
	});

	it("switches the editor to a list and reports the chosen widget", () => {
		const { modal, state } = openWithNewProperty();
		state.picker!.setValue(["a"]);
		state.cardEl!.querySelector<HTMLButtonElement>("button.pp-property-type")!.click();
		choose("List");
		const next = modal.propertyStates.get("brandnew")!;
		expect(next.isList).toBe(true);
		expect(next.widget).toBe("multitext");
		expect(modal.getChosenTypes()).toEqual({ brandnew: "multitext" });
		choose("Automatic");
		expect(modal.getChosenTypes()).toEqual({});
	});

	it("opens the type menu with T on the focused row", () => {
		const { state } = openWithNewProperty();
		obsidianMock.Menu.last = null;
		state.cardEl!.focus();
		key(state.cardEl!, "t");
		expect(obsidianMock.Menu.last).not.toBeNull();
	});
});

describe("SelectPropertiesModal conflict notes", () => {
	it("names the notes with the conflict on the card", () => {
		const { app } = createApp();
		const modal = new SelectPropertiesModal(
			app as any, createMockCatalog(), { status: ["a", "b"] }, vi.fn(), vi.fn(),
			{ status: { conflictNotes: ["Alpha", "Beta"], conflictPaths: ["Alpha.md", "Beta.md"] } }
		);
		modal.onOpen();
		expect(modal.contentEl.querySelector(".pp-conflict-notes")?.textContent).toBe(
			"Notes with this conflict: Alpha, Beta"
		);
	});
});
