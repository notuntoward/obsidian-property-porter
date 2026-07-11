import { describe, it, expect } from "vitest";
import {
	filterFrontmatter,
	mergeArrays,
	deepMerge,
	mergeFrontmatter,
	type PasteMode,
} from "../src/frontmatter";

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
