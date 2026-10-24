import { describe, it, expect } from "vitest";
import {
	filterFrontmatter,
	unionFrontmatter,
	mergeArrays,
	deepMerge,
	mergeFrontmatter,
	isEmptyPropertyValue,
	countPropertyValue,
	parseCommaList,
	type PasteMode,
} from "../src/frontmatter";

describe("parseCommaList", () => {
	it("trims whitespace and drops empty entries", () => {
		expect(parseCommaList(" tags ,  status ,,aliases")).toEqual([
			"tags",
			"status",
			"aliases",
		]);
	});

	it("returns an empty array for blank input", () => {
		expect(parseCommaList("")).toEqual([]);
		expect(parseCommaList("   ")).toEqual([]);
	});
});

describe("countPropertyValue", () => {
	it("counts each array item individually", () => {
		expect(countPropertyValue(["a", "b", "c"])).toBe(3);
	});

	it("counts a non-empty scalar as 1", () => {
		expect(countPropertyValue("done")).toBe(1);
		expect(countPropertyValue(0)).toBe(1);
		expect(countPropertyValue(false)).toBe(1);
	});

	it("counts empty values as 0", () => {
		expect(countPropertyValue([])).toBe(0);
		expect(countPropertyValue(null)).toBe(0);
		expect(countPropertyValue(undefined)).toBe(0);
		expect(countPropertyValue("")).toBe(0);
	});
});

describe("isEmptyPropertyValue", () => {
	it("treats null, undefined, empty string, and empty array as empty", () => {
		expect(isEmptyPropertyValue(null)).toBe(true);
		expect(isEmptyPropertyValue(undefined)).toBe(true);
		expect(isEmptyPropertyValue("")).toBe(true);
		expect(isEmptyPropertyValue([])).toBe(true);
	});

	it("treats non-empty strings, arrays, numbers, booleans, and objects as non-empty", () => {
		expect(isEmptyPropertyValue("x")).toBe(false);
		expect(isEmptyPropertyValue(["a"])).toBe(false);
		expect(isEmptyPropertyValue(0)).toBe(false);
		expect(isEmptyPropertyValue(false)).toBe(false);
		expect(isEmptyPropertyValue({})).toBe(false);
	});
});

describe("normalizeArrayItems", () => {
	const normalize = (arr: unknown[]) =>
		// Import is internal; test through mergeArrays behavior
		mergeArrays(arr, []);

	it("strips leading # from string items", () => {
		expect(normalize(["#a", "#b", "#c"])).toEqual(["a", "b", "c"]);
	});

	it("leaves non-string items untouched", () => {
		expect(normalize([1, true, null])).toEqual([1, true, null]);
	});

	it("handles mixed arrays", () => {
		expect(normalize(["#a", 1, "#b"])).toEqual(["a", 1, "b"]);
	});
});

describe("mergeArrays", () => {
	it("returns destination when source is empty", () => {
		expect(mergeArrays([], ["b", "c"])).toEqual(["b", "c"]);
	});

	it("returns source when destination is empty", () => {
		expect(mergeArrays(["a", "b"], [])).toEqual(["a", "b"]);
	});

	it("unions arrays, preserving destination order then appending new source items", () => {
		expect(mergeArrays(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual([
			"b",
			"c",
			"d",
			"e",
			"a",
		]);
	});

	it("treats #a and a as duplicates", () => {
		expect(mergeArrays(["#a", "b"], ["a", "c"])).toEqual(["a", "c", "b"]);
	});

	it("deduplicates within source", () => {
		expect(mergeArrays(["a", "a", "b"], ["b", "c"])).toEqual([
			"b",
			"c",
			"a",
		]);
	});

	it("handles arrays of objects by JSON equality", () => {
		const a = { x: 1 };
		const b = { x: 2 };
		expect(mergeArrays([a], [b])).toEqual([b, a]);
	});
});

describe("deepMerge", () => {
	it("returns destination when source is empty string", () => {
		expect(deepMerge("", "dest")).toBe("dest");
	});

	it("returns destination when source is empty array", () => {
		expect(deepMerge([], ["dest"])).toEqual(["dest"]);
	});

	it("returns source when destination is empty string", () => {
		expect(deepMerge("src", "")).toBe("src");
	});

	it("returns source when destination is empty array", () => {
		expect(deepMerge(["src"], [])).toEqual(["src"]);
	});

	it("merges arrays by union", () => {
		expect(deepMerge(["a", "b"], ["b", "c"])).toEqual(["b", "c", "a"]);
	});

	it("recursively merges objects", () => {
		expect(deepMerge({ a: { x: 1 } }, { a: { y: 2 } })).toEqual({
			a: { x: 1, y: 2 },
		});
	});

	it("returns source scalar for scalar types", () => {
		expect(deepMerge("src", "dest")).toBe("src");
		expect(deepMerge(1, 2)).toBe(1);
	});

	it("returns source when one value is an array and the other is not", () => {
		expect(deepMerge(["a"], "dest")).toEqual(["a"]);
		expect(deepMerge("src", ["b"])).toBe("src");
	});
});

describe("mergeFrontmatter", () => {
	const base = { tags: ["b", "c", "d", "e"], status: "draft" };
	const incoming = { tags: ["#a", "#b", "#c"], title: "New Title" };

	it("overwrite replaces destination keys unconditionally", () => {
		const result = mergeFrontmatter(incoming, base, "overwrite");
		expect(result).toEqual({
			tags: ["#a", "#b", "#c"],
			status: "draft",
			title: "New Title",
		});
	});

	it("skip keeps existing destination keys", () => {
		const result = mergeFrontmatter(incoming, base, "skip");
		expect(result).toEqual({
			tags: ["b", "c", "d", "e"],
			status: "draft",
			title: "New Title",
		});
	});

	it("merge unions arrays and preserves non-array values", () => {
		const result = mergeFrontmatter(incoming, base, "merge");
		expect(result).toEqual({
			tags: ["b", "c", "d", "e", "a"],
			status: "draft",
			title: "New Title",
		});
	});
});

describe("filterFrontmatter", () => {
	const fm = {
		title: "Note",
		tags: ["a", "b"],
		status: "completed",
		aliases: "",
		number: 123,
	};

	it("onlyInclude whitelists keys", () => {
		const result = filterFrontmatter(fm, "tags, status", "");
		expect(result).toEqual({ tags: ["a", "b"], status: "completed" });
	});

	it("excludeKeys removes matched keys case-insensitively", () => {
		const result = filterFrontmatter(fm, "", "aliases, created date");
		expect(result).toEqual({
			title: "Note",
			tags: ["a", "b"],
			status: "completed",
			number: 123,
		});
	});

	it("onlyInclude takes precedence over excludeKeys", () => {
		const result = filterFrontmatter(fm, "tags", "tags, aliases");
		expect(result).toEqual({ tags: ["a", "b"] });
	});

	it("returns empty object when fm is empty", () => {
		expect(filterFrontmatter({}, "tags", "aliases")).toEqual({});
	});
});

describe("unionFrontmatter", () => {
	it("unions list properties across inputs", () => {
		const r = unionFrontmatter([
			{ tags: ["a", "b"] },
			{ tags: ["b", "c"] },
		]);
		expect(r).toEqual({ tags: ["a", "b", "c"] });
	});

	it("preserves identical scalar values as scalar", () => {
		const r = unionFrontmatter([
			{ status: "draft" },
			{ status: "draft" },
		]);
		expect(r).toEqual({ status: "draft" });
	});

	it("keeps first scalar by default when conflicting values exist", () => {
		const r = unionFrontmatter([
			{ status: "draft" },
			{ status: "published" },
		]);
		expect(r).toEqual({ status: "draft" });
	});

	it("gathers conflicting scalar values into an array of candidate values when gatherConflicts is true", () => {
		const r = unionFrontmatter(
			[
				{ status: "draft" },
				{ status: "published" },
			],
			{ gatherConflicts: true }
		);
		expect(r).toEqual({ status: ["draft", "published"] });
	});

	it("ignores empty property values", () => {
		const r = unionFrontmatter([
			{ status: "draft", tags: [] },
			{ tags: ["work"] },
		]);
		expect(r).toEqual({ status: "draft", tags: ["work"] });
	});
});
