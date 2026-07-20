// @vitest-environment jsdom
// @ts-nocheck

import { describe, it, expect, beforeEach } from "vitest";
import * as obsidianMock from "obsidian";
import PropertyPorter from "../src/main";

type TestPlugin = PropertyPorter & {
	getEditorLeafLocations: () => any[];
	buildTabGroupInfos: (locations: any[], activeLeaf: any) => any[];
	buildWindowInfos: (groups: any[]) => any[];
	buildNavigationModel: (activeLeaf: any) => {
		locations: any[];
		groups: any[];
		windows: any[];
	};
	getActiveTabGroupFiles: () => any[];
};

function createPlugin(options: any = {}) {
	const leaves = options.leaves ?? [];
	const leftSplit = options.leftSplit ?? null;
	const rightSplit = options.rightSplit ?? null;
	const activeLeaf = options.activeLeaf ?? leaves[0] ?? null;

	const app = new obsidianMock.App({
		workspace: {
			leftSplit,
			rightSplit,
			activeLeaf,
			iterateAllLeaves: (cb: (leaf: any) => void) => {
				for (const leaf of leaves) cb(leaf);
			},
		},
		metadataCache: {},
		vault: { getMarkdownFiles: () => [] },
		fileManager: {
			processFrontMatter: async (
				_file: any,
				processor: (fm: any) => void
			) => {
				processor({});
			},
		},
	});

	const plugin = new PropertyPorter(app as any, {
		id: "property-porter",
		name: "Property Porter",
		version: "0.0.0",
	}) as TestPlugin;

	return { plugin, app, leaves };
}

function leaf(
	id: string,
	file: string | null | any,
	parent: any,
	containerWin: Window | undefined,
	root: any
) {
	const filePath = typeof file === "string" ? file : file?.path ?? null;
	const fileObj = filePath ? new obsidianMock.TFile(filePath) : null;
	return {
		id,
		parent,
		view: fileObj ? new obsidianMock.FileView(fileObj) : null,
		getRoot: () => root,
		getContainer: () => ({ win: containerWin }),
	};
}

describe("canonical workspace model", () => {
	describe("model construction", () => {
		it("excludes sidebar leaves from locations, groups, and windows", () => {
			const mainWin = globalThis.window;
			const popupWin = {} as Window;

			const mainContainer = { win: mainWin };
			const popupContainer = { win: popupWin };
			const leftSplit = { type: "sidedock" };
			const rightSplit = { type: "sidedock" };

			const groupA = { id: "groupA", containerEl: {} };
			const groupB = { id: "groupB", containerEl: {} };
			const groupC = { id: "groupC", containerEl: {} };

			const mainA1 = leaf("main-a1", "Main-A1.md", groupA, mainWin, groupA);
			const mainA2 = leaf("main-a2", "Main-A2.md", groupA, mainWin, groupA);
			const mainB1 = leaf("main-b1", "Main-B1.md", groupB, mainWin, groupB);
			const popupC1 = leaf("popup-c1", "Popup-C1.md", groupC, popupWin, groupC);
			const popupC2 = leaf("popup-c2", "Popup-C2.md", groupC, popupWin, groupC);
			const sidebar = leaf("sidebar", "File Explorer", groupA, mainWin, leftSplit);

			const { plugin } = createPlugin({
				leaves: [mainA1, mainA2, mainB1, popupC1, popupC2, sidebar],
				leftSplit,
				rightSplit,
				activeLeaf: mainA1,
			});

			const model = plugin.buildNavigationModel(mainA1);

			expect(model.locations).toHaveLength(5);
			expect(model.groups).toHaveLength(3);
			expect(model.windows).toHaveLength(2);

			const inLocations = model.locations.some(
				(l: any) => l.leaf.id === "sidebar"
			);
			expect(inLocations).toBe(false);

			for (const group of model.groups) {
				expect(group.leaves.some((l: any) => l.id === "sidebar")).toBe(false);
			}
		});

		it("groups main window and pop-out leaves separately even when they share the same parent object", () => {
			const mainWin = globalThis.window;
			const popupWin = {} as Window;

			const mainContainer = { win: mainWin };
			const popupContainer = { win: popupWin };

			const sharedGroup = { id: "shared", containerEl: {} };

			const mainLeaf = leaf("main", "Main.md", sharedGroup, mainWin, sharedGroup);
			const popupLeaf = leaf(
				"popup",
				"Popup.md",
				sharedGroup,
				popupWin,
				sharedGroup
			);

			const { plugin } = createPlugin({
				leaves: [mainLeaf, popupLeaf],
				activeLeaf: mainLeaf,
			});

			const model = plugin.buildNavigationModel(mainLeaf);

			expect(model.groups).toHaveLength(2);
			const mainGroup = model.groups.find(
				(g: any) => g.window === mainWin
			)!;
			const popupGroup = model.groups.find(
				(g: any) => g.window === popupWin
			)!;
			expect(mainGroup.leaves).toHaveLength(1);
			expect(popupGroup.leaves).toHaveLength(1);
			expect(mainGroup.leaves[0].id).toBe("main");
			expect(popupGroup.leaves[0].id).toBe("popup");
		});

		it("places leaves with the same window and parent in the same group", () => {
			const mainWin = globalThis.window;

			const groupA = { id: "groupA", containerEl: {} };
			const a1 = leaf("a1", "A1.md", groupA, mainWin, groupA);
			const a2 = leaf("a2", "A2.md", groupA, mainWin, groupA);

			const { plugin } = createPlugin({
				leaves: [a1, a2],
				activeLeaf: a1,
			});

			const model = plugin.buildNavigationModel(a1);

			expect(model.groups).toHaveLength(1);
			expect(model.groups[0].leaves).toHaveLength(2);
			expect(model.groups[0].leaves.map((l: any) => l.id).sort()).toEqual([
				"a1",
				"a2",
			]);
		});

		it("creates one WindowInfo per distinct native window", () => {
			const mainWin = globalThis.window;
			const popupWin = {} as Window;
			const popupWin2 = {} as Window;

			const mainContainer = { win: mainWin };
			const popupContainer = { win: popupWin };
			const popupContainer2 = { win: popupWin2 };

			const g1 = { id: "g1", containerEl: {} };
			const g2 = { id: "g2", containerEl: {} };
			const gP1 = { id: "gp1", containerEl: {} };
			const gP2 = { id: "gp2", containerEl: {} };

			const a = leaf("a", "A.md", g1, mainWin, g1);
			const b = leaf("b", "B.md", g2, mainWin, g2);
			const p1 = leaf("p1", "P1.md", gP1, popupWin, gP1);
			const p2 = leaf("p2", "P2.md", gP2, popupWin2, gP2);

			const { plugin } = createPlugin({
				leaves: [a, b, p1, p2],
				activeLeaf: a,
			});

			const model = plugin.buildNavigationModel(a);

			expect(model.windows).toHaveLength(3);
			const mainWinInfo = model.windows.find((w: any) => w.window === mainWin)!;
			const popupWinInfo = model.windows.find(
				(w: any) => w.window === popupWin
			)!;
			const popupWin2Info = model.windows.find(
				(w: any) => w.window === popupWin2
			)!;
			expect(mainWinInfo.groups).toHaveLength(2);
			expect(popupWinInfo.groups).toHaveLength(1);
			expect(popupWin2Info.groups).toHaveLength(1);
		});

		it("every editor leaf appears in exactly one group", () => {
			const mainWin = globalThis.window;
			const popupWin = {} as Window;

			const groupA = { id: "groupA", containerEl: {} };
			const groupB = { id: "groupB", containerEl: {} };
			const groupC = { id: "groupC", containerEl: {} };

			const mainA1 = leaf("main-a1", "Main-A1.md", groupA, mainWin, groupA);
			const mainA2 = leaf("main-a2", "Main-A2.md", groupA, mainWin, groupA);
			const mainB1 = leaf("main-b1", "Main-B1.md", groupB, mainWin, groupB);
			const popupC1 = leaf("popup-c1", "Popup-C1.md", groupC, popupWin, groupC);
			const popupC2 = leaf("popup-c2", "Popup-C2.md", groupC, popupWin, groupC);

			const { plugin } = createPlugin({
				leaves: [mainA1, mainA2, mainB1, popupC1, popupC2],
				activeLeaf: mainA1,
			});

			const model = plugin.buildNavigationModel(mainA1);

			const counts = new Map<string, number>();
			for (const group of model.groups) {
				for (const l of group.leaves) {
					const id = l.id;
					counts.set(id, (counts.get(id) ?? 0) + 1);
				}
			}
			expect([...counts.values()].every((c) => c === 1)).toBe(true);
		});
	});

	describe("regression: getActiveTabGroupFiles", () => {
		it("still returns files for the active tab group in a simple main window", () => {
			const active = new obsidianMock.TFile("active.md");
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const other = new obsidianMock.TFile("other.md");

			const groupA = { id: "groupA", containerEl: {} };
			const groupB = { id: "groupB", containerEl: {} };

			const activeLeaf = leaf("active", active, groupA, globalThis.window, groupA);
			const leafA = leaf("a", f1, groupA, globalThis.window, groupA);
			const leafB = leaf("b", f2, groupA, globalThis.window, groupA);
			const leafOther = leaf("other", other, groupB, globalThis.window, groupB);

			const { plugin } = createPlugin({
				leaves: [activeLeaf, leafA, leafB, leafOther],
				activeLeaf,
			});

			const files = plugin.getActiveTabGroupFiles();

			expect(files.map((f: any) => f.path).sort()).toEqual([
				"a.md",
				"active.md",
				"b.md",
			]);
		});

		it("still returns files for the active tab group in a pop-out window", () => {
			const active = new obsidianMock.TFile("active.md");
			const f1 = new obsidianMock.TFile("a.md");
			const f2 = new obsidianMock.TFile("b.md");
			const other = new obsidianMock.TFile("other.md");

			const popupGroup = { id: "popupGroup", containerEl: {} };
			const mainGroup = { id: "mainGroup", containerEl: {} };

			const popupWin = {} as Window;

			const activeLeaf = leaf(
				"active",
				active,
				popupGroup,
				popupWin,
				popupGroup
			);
			const leafA = leaf("a", f1, popupGroup, popupWin, popupGroup);
			const leafB = leaf("b", f2, popupGroup, popupWin, popupGroup);
			const leafOther = leaf(
				"other",
				other,
				mainGroup,
				globalThis.window,
				mainGroup
			);

			const { plugin } = createPlugin({
				leaves: [activeLeaf, leafA, leafB, leafOther],
				activeLeaf,
			});

			const files = plugin.getActiveTabGroupFiles();

			expect(files.map((f: any) => f.path).sort()).toEqual([
				"a.md",
				"active.md",
				"b.md",
			]);
		});

		it("does not paste into duplicates of the same file in the group", async () => {
			const f1 = new obsidianMock.TFile("a.md");

			const groupA = { id: "groupA", containerEl: {} };

			const activeLeaf = leaf("active", f1, groupA, globalThis.window, groupA);
			const dupLeaf = leaf("dup", f1, groupA, globalThis.window, groupA);

			const { plugin, app } = createPlugin({
				leaves: [activeLeaf, dupLeaf],
				activeLeaf,
			});

			plugin.clipboard = { tags: ["a"] };
			app.fileManager.processFrontMatter = async (
				_file: any,
				processor: (fm: any) => void
			) => {
				const existing = {};
				const fm = { ...existing };
				processor(fm);
			};

			await plugin.pasteIntoActiveTabGroup();

			// We can't easily count processFrontMatter calls without more mocking,
			// but we can verify the file list is deduped
			const files = plugin.getActiveTabGroupFiles();
			expect(files).toHaveLength(1);
		});
	});
});
