import { describe, it, expect, vi } from "vitest";
import {
	filterFrontmatter,
	unionFrontmatter,
	getFrontmatterLines,
	mergeArrays,
	deepMerge,
	mergeFrontmatter,
	findOverlappingPropertyFilters,
	removeOverlappingExcludedProperties,
	isEmptyPropertyValue,
	countPropertyValue,
	parseCommaList,
	parseRawFrontmatter,
	applyDuplicateResolution,
	formatRawValue,
	findPasteChanges,
	type PasteMode,
} from "../src/frontmatter";

describe("findPasteChanges", () => {
	it("reports keys whose existing value differs, with old and new values", () => {
		expect(
			findPasteChanges(
				{ version: "4", tags: ["a", "b"], same: "x", fresh: "y", blank: "z" },
				{ version: "2", tags: ["c"], same: "x", blank: "" },
				"overwrite"
			)
		).toEqual([
			{ key: "version", from: "2", to: "4" },
			{ key: "tags", from: "c", to: "a, b" },
		]);
	});

	it("reports the same differences for skip mode and nothing for merge mode", () => {
		const source = { version: "4" };
		const destination = { version: "2" };
		expect(findPasteChanges(source, destination, "skip")).toHaveLength(1);
		expect(findPasteChanges(source, destination, "merge")).toEqual([]);
	});
});

describe("parseCommaList", () => {
	it("preserves typed identity and Windows line endings when repairing", () => {
		const text = '---\r\nx: 1\r\nx: "1"\r\nflag: true\r\nflag: "true"\r\n---\r\nBody\r\n';
		expect(applyDuplicateResolution(text, [
			{ key: "x", keep: "1" }, { key: "flag", keep: "true" },
		])).toBe('---\r\nx: "1"\r\nflag: "true"\r\n---\r\nBody\r\n');
	});

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

	it("applies excludes after the include whitelist", () => {
		const result = filterFrontmatter(fm, "tags", "tags, aliases");
		expect(result).toEqual({});
	});

	it("finds overlapping include and exclude names case-insensitively and across underscores", () => {
		expect(findOverlappingPropertyFilters("Created Date, status", "created_date, aliases")).toEqual([
			"Created Date",
		]);
	});

	it("removes legacy overlapping exclusions while preserving other exclusions", () => {
		expect(removeOverlappingExcludedProperties("Created Date, status", "created_date, aliases")).toEqual({
			excludeKeys: "aliases",
			removed: ["created_date"],
		});
	});

	it("allows disjoint include and exclude filters together", () => {
		const result = filterFrontmatter(fm, "tags, status", "aliases");
		expect(result).toEqual({ tags: ["a", "b"], status: "completed" });
	});

	it("returns empty object when fm is empty", () => {
		expect(filterFrontmatter({}, "tags", "aliases")).toEqual({});
	});
});

describe("unionFrontmatter", () => {
	it("deduplicates repeated list values when parsing frontmatter", () => {
		const parsed = parseRawFrontmatter("---\ntags:\n  - a\n  - a\n  - b\n---\n");
		expect(parsed.map.tags).toEqual(["a", "b"]);
	});

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

describe("filterFrontmatter key normalization", () => {
	it("excludes underscore variants of configured keys", () => {
		expect(
			filterFrontmatter(
				{ created_date: "x", modified_date: "y", tags: ["t"] },
				"",
				"created date, modified date"
			)
		).toEqual({ tags: ["t"] });
	});

	it("matches Only include entries case-insensitively and across underscores", () => {
		expect(
			filterFrontmatter({ Status: "a", created_date: "x" }, "status, Created Date", "")
		).toEqual({ Status: "a", created_date: "x" });
	});
});

describe("parseRawFrontmatter", () => {
	it("extracts only frontmatter lines from notes with large bodies", () => {
		const content = `---\ntitle: Note\n---\n${"body line\n".repeat(10_000)}`;
		const split = vi.spyOn(String.prototype, "split");

		const lines = getFrontmatterLines(content);
		const splitWholeNote = split.mock.contexts.some((context) => context === content);
		split.mockRestore();

		expect(lines).toEqual(["---", "title: Note", "---"]);
		expect(splitWholeNote).toBe(false);
	});

	it("returns no duplicates for a note with unique keys", () => {
		const parsed = parseRawFrontmatter("---\ntitle: Note Six\nversion: 2\n---\n\nbody");
		expect(parsed.map).toEqual({ title: "Note Six", version: 2 });
		expect(parsed.duplicates).toEqual([]);
	});

	it("does not split a large note body when parsing frontmatter", () => {
		const content = `---\ntitle: Note\n---\n${"body line\n".repeat(10_000)}`;
		const split = vi.spyOn(String.prototype, "split");

		const parsed = parseRawFrontmatter(content);
		const splitWholeNote = split.mock.contexts.some((context) => context === content);
		split.mockRestore();

		expect(parsed.map).toEqual({ title: "Note" });
		expect(splitWholeNote).toBe(false);
	});

	it("detects duplicate scalar keys and keeps every occurrence with spans", () => {
		const parsed = parseRawFrontmatter(
			"---\ntitle: T\nmodified_date: 2026-10-13T16:58:17\nmodified_date: 2026-10-13T15:45:00\n---\n"
		);
		expect(parsed.duplicates).toEqual([
			{
				key: "modified_date",
				values: ["2026-10-13T16:58:17", "2026-10-13T15:45:00"],
				spans: [
					[2, 2],
					[3, 3],
				],
			},
		]);
		// First occurrence wins for the value map; the conflict UI decides.
		expect(parsed.map.modified_date).toBe("2026-10-13T16:58:17");
	});

	it("detects duplicate list keys and parses both lists with spans", () => {
		const parsed = parseRawFrontmatter("---\ntags:\n  - a\n  - b\ntags:\n  - c\n---\n");
		expect(parsed.duplicates).toEqual([
			{
				key: "tags",
				values: [
					["a", "b"],
					["c"],
				],
				spans: [
					[1, 3],
					[4, 5],
				],
			},
		]);
	});

	it("flags identical duplicate values as redundant too", () => {
		const parsed = parseRawFrontmatter("---\nstatus: draft\nstatus: draft\n---\n");
		expect(parsed.duplicates).toHaveLength(1);
		expect(parsed.duplicates[0].values).toEqual(["draft", "draft"]);
		expect(parsed.duplicates[0].key).toBe("status");
	});

	it("dedupes repeated items inside a single list without flagging a conflict", () => {
		const parsed = parseRawFrontmatter("---\ntags:\n  - a\n  - b\n  - a\n---\n");
		expect(parsed.map.tags).toEqual(["a", "b"]);
		expect(parsed.duplicates).toEqual([]);
	});

	it("returns empty for content without a frontmatter block", () => {
		expect(parseRawFrontmatter("just body text\n")).toEqual({ map: {}, duplicates: [] });
	});

	it("stops at the closing marker so body lines are ignored", () => {
		const parsed = parseRawFrontmatter("---\ntitle: X\n---\nmodified_date: 1\nmodified_date: 2\n");
		expect(parsed.duplicates).toEqual([]);
	});

	it("parses booleans, numbers, and quoted strings", () => {
		const parsed = parseRawFrontmatter('---\nis_active: true\nversion: 2\ntitle: "Note: Six"\n---\n');
		expect(parsed.map).toEqual({ is_active: true, version: 2, title: "Note: Six" });
	});

	it("keeps quoted booleans, leading-zero numbers, and exponent forms as strings", () => {
		const parsed = parseRawFrontmatter('---\nquoted_false: "false"\nzero_padded: "001"\n---\n');
		expect(parsed.map).toEqual({ quoted_false: "false", zero_padded: "001" });
	});
});

describe("applyDuplicateResolution", () => {
	const note06 = [
		"---",
		"title: Note Six",
		"is_active: true",
		"version: 2",
		"tags:",
		"  - a",
		"  - b",
		"  - c",
		"modified_date: 2026-10-13T16:58:17",
		"created_date: 2026-08-19T21:26:00",
		"modified_date: 2026-10-13T15:45:00",
		"---",
		"",
		"a# heading 1",
		"",
		"This note has boolean and number properties.",
	].join("\n");

	it("keeps only the chosen occurrence and preserves every other line", () => {
		const resolved = applyDuplicateResolution(note06, [
			{ key: "modified_date", keep: "2026-10-13T15:45:00" },
		]);
		expect(resolved).toBe(
			[
				"---",
				"title: Note Six",
				"is_active: true",
				"version: 2",
				"tags:",
				"  - a",
				"  - b",
				"  - c",
				"created_date: 2026-08-19T21:26:00",
				"modified_date: 2026-10-13T15:45:00",
				"---",
				"",
				"a# heading 1",
				"",
				"This note has boolean and number properties.",
			].join("\n")
		);
	});

	it("keeps the first occurrence when both duplicates are identical", () => {
		const resolved = applyDuplicateResolution("---\nstatus: draft\nstatus: draft\n---\n", [
			{ key: "status", keep: "draft" },
		]);
		expect(resolved).toBe("---\nstatus: draft\n---\n");
	});

	it("keeps only the chosen list occurrence", () => {
		const resolved = applyDuplicateResolution("---\ntags:\n  - a\n  - b\ntags:\n  - c\n---\n", [
			{ key: "tags", keep: ["c"] },
		]);
		expect(resolved).toBe("---\ntags:\n  - c\n---\n");
	});

	it("renders a hand-typed value into the first occurrence's place", () => {
		const resolved = applyDuplicateResolution("---\nstatus: one\nstatus: two\n---\n", [
			{ key: "status", keep: "custom" },
		]);
		expect(resolved).toBe("---\nstatus: custom\n---\n");
	});

	it("preserves quoted strings and comments elsewhere in the frontmatter", () => {
		const content = [
			"---",
			"# a comment",
			'title: "Note: Six"',
			"status: one",
			"status: two",
			"---",
		].join("\n");
		const resolved = applyDuplicateResolution(content, [{ key: "status", keep: "two" }]);
		expect(resolved).toBe(
			["---", "# a comment", 'title: "Note: Six"', "status: two", "---"].join("\n")
		);
	});
});

describe("formatRawValue", () => {
	it("joins list values and stringifies scalars", () => {
		expect(formatRawValue(["a", "b"])).toBe("a, b");
		expect(formatRawValue(2)).toBe("2");
		expect(formatRawValue(true)).toBe("true");
	});
});
