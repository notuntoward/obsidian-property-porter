// Obsidian's getAllTags() returns tags with a leading "#" (e.g. "#foo/bar"),
// but clipboard/known-tag comparisons expect the bare form. Centralized here
// so the picker and frontmatter merging strip it the same way.
export function stripHashTag(tag: string): string {
	return tag.replace(/^#/, "");
}

export function normalizeArrayItems(arr: unknown[]): unknown[] {
	return arr.map((item) =>
		typeof item === "string" ? stripHashTag(item) : item
	);
}

export function mergeArrays(
	source: unknown[],
	destination: unknown[]
): unknown[] {
	const normalizedSource = normalizeArrayItems(source);
	const normalizedDest = normalizeArrayItems(destination);

	const seen = new Set(normalizedDest.map((v) => JSON.stringify(v)));
	const result = [...normalizedDest];

	for (const item of normalizedSource) {
		const key = JSON.stringify(item);
		if (!seen.has(key)) {
			result.push(item);
			seen.add(key);
		}
	}

	return result;
}

// Parses a user-facing comma-separated settings string (e.g. "tags, status")
// into a trimmed, non-empty list. Shared by every setting that accepts this
// format (Only include, Exclude keys) so the parsing rules stay consistent.
export function parseCommaList(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function isEmptyPropertyValue(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		value === "" ||
		(Array.isArray(value) && value.length === 0)
	);
}

// Counts the number of individual values a property represents: array
// properties (e.g. tags) count each item, empty values count 0, and any
// other scalar counts as 1. This is what a user actually means by "how
// many things did I copy/paste", as opposed to counting frontmatter keys.
export function countPropertyValue(value: unknown): number {
	if (isEmptyPropertyValue(value)) return 0;
	if (Array.isArray(value)) return value.length;
	return 1;
}

export function deepMerge(source: unknown, destination: unknown): unknown {
	if (isEmptyPropertyValue(source)) {
		return destination;
	}
	if (isEmptyPropertyValue(destination)) {
		return source;
	}

	const sourceArray = Array.isArray(source);
	const destArray = Array.isArray(destination);

	if (sourceArray && destArray) {
		return mergeArrays(
			source as unknown[],
			destination as unknown[]
		);
	}
	if (sourceArray || destArray) {
		return source;
	}
	if (typeof source === "object" && typeof destination === "object") {
		const destObj = destination as Record<string, unknown>;
		const sourceObj = source as Record<string, unknown>;
		const out: Record<string, unknown> = { ...destObj };
		for (const key of Object.keys(sourceObj)) {
			if (key in destObj) {
				out[key] = deepMerge(sourceObj[key], destObj[key]);
			} else {
				out[key] = sourceObj[key];
			}
		}
		return out;
	}
	return source;
}

// Unions a sequence of frontmatter objects into a single result. List
// (array) properties accumulate every distinct value across the inputs via
// `mergeArrays`; scalar properties take the first non-empty value seen. Used
// when collecting properties from many notes (e.g. an active tab group) into
// one clipboard payload.
export function unionFrontmatter(
	inputs: Record<string, unknown>[]
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const input of inputs) {
		for (const [key, value] of Object.entries(input)) {
			if (key in result) {
				const existing = result[key];
				if (Array.isArray(existing) && Array.isArray(value)) {
					result[key] = mergeArrays(value, existing);
				}
				// scalar already set: keep the first value, ignore later
				continue;
			}
			result[key] = value;
		}
	}
	return result;
}

export type PasteMode = "overwrite" | "skip" | "merge";

export function mergeFrontmatter(
	source: Record<string, unknown>,
	destination: Record<string, unknown>,
	pasteMode: PasteMode
): Record<string, unknown> {
	const result: Record<string, unknown> = { ...destination };

	for (const key of Object.keys(source)) {
		if (pasteMode === "skip" && key in destination) continue;

		if (pasteMode === "merge") {
			result[key] = deepMerge(source[key], destination[key]);
		} else {
			result[key] = source[key];
		}
	}

	return result;
}

export function filterFrontmatter(
	fm: Record<string, unknown>,
	onlyInclude: string,
	excludeKeys: string
): Record<string, unknown> {
	const onlyList = parseCommaList(onlyInclude);

	let result: Record<string, unknown> = {};

	if (onlyList.length > 0) {
		for (const key of onlyList) {
			if (key in fm) result[key] = fm[key];
		}
	} else {
		const exclude = parseCommaList(excludeKeys).map((s) =>
			s.toLowerCase()
		);
		result = { ...fm };
		for (const key of Object.keys(result)) {
			if (exclude.includes(key.toLowerCase())) delete result[key];
		}
	}

	return result;
}
