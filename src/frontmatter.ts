export function normalizeArrayItems(arr: unknown[]): unknown[] {
	return arr.map((item) =>
		typeof item === "string" ? item.replace(/^#/, "") : item
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

export function deepMerge(source: unknown, destination: unknown): unknown {
	if (
		source === null ||
		source === undefined ||
		source === "" ||
		(Array.isArray(source) && (source as unknown[]).length === 0)
	) {
		return destination;
	}
	if (
		destination === null ||
		destination === undefined ||
		destination === "" ||
		(Array.isArray(destination) && (destination as unknown[]).length === 0)
	) {
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
	const onlyList = onlyInclude
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

	let result: Record<string, unknown> = {};

	if (onlyList.length > 0) {
		for (const key of onlyList) {
			if (key in fm) result[key] = fm[key];
		}
	} else {
		const exclude = excludeKeys
			.split(",")
			.map((s) => s.trim().toLowerCase())
			.filter(Boolean);
		result = { ...fm };
		for (const key of Object.keys(result)) {
			if (exclude.includes(key.toLowerCase())) delete result[key];
		}
	}

	return result;
}
