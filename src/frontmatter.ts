import { formatRawValue, isEmptyPropertyValue } from "commons/properties/values";

export { formatRawValue, isEmptyPropertyValue };

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
// format (Only include properties, Exclude properties) so the parsing rules stay consistent.
export function parseCommaList(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function findOverlappingPropertyFilters(onlyInclude: string, excludeKeys: string): string[] {
	const excluded = new Set(parseCommaList(excludeKeys).map(normalizeKeyForMatch));
	return parseCommaList(onlyInclude).filter((key) => excluded.has(normalizeKeyForMatch(key)));
}

export function removeOverlappingExcludedProperties(
	onlyInclude: string,
	excludeKeys: string
): { excludeKeys: string; removed: string[] } {
	const included = new Set(parseCommaList(onlyInclude).map(normalizeKeyForMatch));
	const excluded = parseCommaList(excludeKeys);
	const removed = excluded.filter((key) => included.has(normalizeKeyForMatch(key)));
	return {
		excludeKeys: excluded.filter((key) => !included.has(normalizeKeyForMatch(key))).join(", "),
		removed,
	};
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
// `mergeArrays`. For scalar properties, by default the first non-empty value seen
// is kept; when `gatherConflicts` is true, conflicting scalar values are gathered
// into an array of candidate values for conflict resolution.
export function unionFrontmatter(
	inputs: Record<string, unknown>[],
	options?: { gatherConflicts?: boolean }
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	const gatherConflicts = options?.gatherConflicts ?? false;
	for (const input of inputs) {
		for (const [key, value] of Object.entries(input)) {
			if (isEmptyPropertyValue(value)) continue;

			if (key in result) {
				const existing = result[key];
				if (Array.isArray(existing) && Array.isArray(value)) {
					result[key] = mergeArrays(value, existing);
				} else if (gatherConflicts) {
					const existingArr = Array.isArray(existing) ? existing : [existing];
					const valueArr = Array.isArray(value) ? value : [value];
					const merged = mergeArrays(valueArr, existingArr);
					if (merged.length === 1 && !Array.isArray(existing) && !Array.isArray(value)) {
						result[key] = merged[0];
					} else {
						result[key] = merged;
					}
				}
				// scalar already set: keep the first value when gatherConflicts is false
				continue;
			}
			result[key] = value;
		}
	}
	return result;
}

export type PasteMode = "overwrite" | "skip" | "merge";

export interface PasteChange {
	key: string;
	/** The value already in the note. */
	from: string;
	/** The clipboard value that overwrites it, or is left unpasted in skip mode. */
	to: string;
}

// The properties an Overwrite or Skip paste would replace or leave alone in a
// note: only keys that already hold a different, non-empty value. Merge mode
// resolves its own conflicts, so it reports nothing.
export function findPasteChanges(
	source: Record<string, unknown>,
	destination: Record<string, unknown>,
	pasteMode: PasteMode
): PasteChange[] {
	if (pasteMode === "merge") return [];
	const changes: PasteChange[] = [];
	for (const [key, value] of Object.entries(source)) {
		const existing = destination[key];
		if (isEmptyPropertyValue(value) || isEmptyPropertyValue(existing)) continue;
		const from = formatRawValue(existing).trim();
		const to = formatRawValue(value).trim();
		if (from !== to) changes.push({ key, from, to });
	}
	return changes;
}

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

// Matches a settings key against a property name case-insensitively, treating
// underscores as spaces, so "created date" in Exclude properties also matches a
// "created_date" property.
function normalizeKeyForMatch(key: string): string {
	return key.trim().toLowerCase().replace(/_/g, " ");
}

export function filterFrontmatter(
	fm: Record<string, unknown>,
	onlyInclude: string,
	excludeKeys: string
): Record<string, unknown> {
	const onlyList = parseCommaList(onlyInclude);
	let result: Record<string, unknown>;

	if (onlyList.length > 0) {
		result = {};
		for (const key of onlyList) {
			if (key in fm) {
				result[key] = fm[key];
				continue;
			}
			const wanted = normalizeKeyForMatch(key);
			const match = Object.keys(fm).find(
				(k) => normalizeKeyForMatch(k) === wanted
			);
			if (match) result[match] = fm[match];
		}
	} else {
		result = { ...fm };
	}

	const excluded = new Set(parseCommaList(excludeKeys).map(normalizeKeyForMatch));
	for (const key of Object.keys(result)) {
		if (excluded.has(normalizeKeyForMatch(key))) delete result[key];
	}

	return result;
}

// ─── Raw frontmatter parsing ───────────────────────────────────────
// Obsidian's metadata cache can return no frontmatter at all for a note with a
// duplicated property key, so duplicate detection and repair read the raw file
// text. This parser is intentionally line-based: it only needs top-level keys
// and their values, and it must keep every occurrence of a duplicated key
// instead of collapsing them the way a YAML object would.

export interface FrontmatterDuplicate {
	key: string;
	/** One entry per occurrence of the key, in document order. */
	values: unknown[];
	/**
	 * Line span of each occurrence, `[startLine, endLine]` inclusive, so a
	 * repair can remove exactly the lines of the redundant occurrences.
	 */
	spans: Array<[number, number]>;
}

export interface RawFrontmatter {
	/** First occurrence wins; list items are deduplicated in place. */
	map: Record<string, unknown>;
	duplicates: FrontmatterDuplicate[];
}

function unquoteValue(raw: string): string {
	const trimmed = raw.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1)
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

// Parses an inline scalar loosely, preserving intent: quoted values are always
// strings, booleans stay booleans, and numbers only convert when the string
// round-trips (so "001" and "1e3" stay strings).
function parseInlineScalar(raw: string): unknown {
	const trimmed = raw.trim();
	const isQuoted =
		(trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length > 1);
	if (isQuoted) return trimmed.slice(1, -1);
	if (trimmed === "true") return true;
	if (trimmed === "false") return false;
	if (
		trimmed !== "" &&
		!Number.isNaN(Number(trimmed)) &&
		String(Number(trimmed)) === trimmed
	) {
		return Number(trimmed);
	}
	return trimmed;
}

// Renders the lines of one property occurrence for the rare case where a
// conflict is settled on a value that did not exist in the note.
function renderOccurrenceLines(key: string, value: unknown): string[] {
	if (Array.isArray(value)) {
		return [`${key}:`, ...value.map((item) => `  - ${String(item)}`)];
	}
	return [`${key}: ${value === null || value === undefined ? "" : String(value)}`];
}

/**
 * Parses the frontmatter block of a raw markdown file, reporting top-level
 * keys that appear more than once. Values keep their loose types (booleans,
 * numbers, strings); list values become arrays of item strings with duplicate
 * items removed.
 */
export function getFrontmatterLines(content: string): string[] {
	const firstNewline = content.indexOf("\n");
	const firstLineEnd = firstNewline === -1 ? content.length : firstNewline;
	const firstLine =
		content.charCodeAt(firstLineEnd - 1) === 13
			? content.slice(0, firstLineEnd - 1)
			: content.slice(0, firstLineEnd);
	if (firstLine.trim() !== "---") return [];

	const lines = [firstLine];
	if (firstNewline === -1) return lines;

	let lineStart = firstNewline + 1;
	while (lineStart <= content.length) {
		const newline = content.indexOf("\n", lineStart);
		const lineEnd = newline === -1 ? content.length : newline;
		const contentEnd =
			lineEnd > lineStart && content.charCodeAt(lineEnd - 1) === 13
				? lineEnd - 1
				: lineEnd;
		const line = content.slice(lineStart, contentEnd);
		lines.push(line);
		if (line.trim() === "---" || newline === -1) break;
		lineStart = newline + 1;
	}
	return lines;
}

export function parseRawFrontmatter(content: string): RawFrontmatter {
	const result: RawFrontmatter = { map: {}, duplicates: [] };
	const lines = getFrontmatterLines(content);
	if (lines.length === 0) return result;

	const occurrences = new Map<string, { values: unknown[]; spans: Array<[number, number]> }>();
	let pendingListKey: string | null = null;
	let pendingListStart = -1;
	let pendingList: string[] = [];
	let pendingListEnd = -1;

	const pushOccurrence = (key: string, value: unknown, span: [number, number]): void => {
		const entry = occurrences.get(key);
		if (entry) {
			entry.values.push(value);
			entry.spans.push(span);
		} else {
			occurrences.set(key, { values: [value], spans: [span] });
		}
	};

	const flushPendingList = (): void => {
		if (pendingListKey === null) return;
		// A key line with nothing after the colon starts a list; an empty list
		// means the property was set to nothing.
		pushOccurrence(pendingListKey, pendingList, [pendingListStart, pendingListEnd]);
		pendingListKey = null;
		pendingList = [];
	};

	const keyLine = /^(?:"([^"]+)"|'([^']+)'|([^\s:#][^:]*)):\s?(.*)$/;

	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		if (line.trim() === "---") break;

		const match = keyLine.exec(line);
		if (match) {
			flushPendingList();
			const key = unquoteValue(match[1] ?? match[2] ?? match[3] ?? "");
			const inline = match[4] ?? "";
			if (key) {
				if (inline.trim() === "") {
					pendingListKey = key;
					pendingListStart = i;
					pendingListEnd = i;
					pendingList = [];
				} else {
					pushOccurrence(key, parseInlineScalar(inline), [i, i]);
				}
			}
			continue;
		}

		const item = /^\s+-\s+(.*)$/.exec(line);
		if (item && pendingListKey !== null) {
			pendingList.push(unquoteValue(item[1]));
			pendingListEnd = i;
		}
		// Any other indented line (folded scalar, comment) is ignored.
	}
	flushPendingList();

	for (const [key, entry] of occurrences) {
		let first = entry.values[0];
		if (Array.isArray(first)) {
			first = [...new Set(first)];
		}
		result.map[key] = first;
		if (entry.values.length > 1) {
			result.duplicates.push({ key, values: entry.values, spans: entry.spans });
		}
	}
	return result;
}

export interface DuplicateResolution {
	key: string;
	/** The value to keep; every other occurrence of the key is dropped. */
	keep: unknown;
}

/**
 * Rewrites raw markdown content so each duplicated property key keeps only
 * the chosen occurrence. The edit is purely textual: every
 * other line of the file, including comments and unrelated frontmatter, is
 * preserved byte for byte.
 */
export function applyDuplicateResolution(
	content: string,
	decisions: DuplicateResolution[]
): string {
	const lines = content.split(/\r?\n/);
	const parsed = parseRawFrontmatter(content);
	const dropLines = new Set<number>();
	const replacements = new Map<number, string[]>();

	for (const decision of decisions) {
		const dup = parsed.duplicates.find((candidate) => candidate.key === decision.key);
		if (!dup) continue;

		let keepIndex = dup.values.findIndex((value) =>
			JSON.stringify(value) === JSON.stringify(decision.keep)
		);
		const isCustomValue = keepIndex === -1;
		if (isCustomValue) keepIndex = 0;

		dup.spans.forEach((span, index) => {
			if (index === keepIndex) return;
			for (let ln = span[0]; ln <= span[1]; ln++) dropLines.add(ln);
		});

		if (isCustomValue) {
			// The user typed a value that existed nowhere in the note: replace the
			// first occurrence's lines with a rendering of the chosen value.
			replacements.set(dup.spans[0][0], renderOccurrenceLines(decision.key, decision.keep));
			for (let ln = dup.spans[0][0]; ln <= dup.spans[0][1]; ln++) dropLines.add(ln);
		}
	}

	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const replacement = replacements.get(i);
		if (replacement) out.push(...replacement);
		if (dropLines.has(i)) continue;
		out.push(lines[i]);
	}
	return out.join(content.includes("\r\n") ? "\r\n" : "\n");
}
