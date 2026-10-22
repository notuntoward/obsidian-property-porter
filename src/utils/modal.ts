export {
	getChooser,
	setSelectedItemSafely,
	renderHighlightedText,
	registerEmacsMotionKeys,
	type ChooserLike,
	FileSuggestModal,
	ItemSuggestModal,
} from "commons/modal";

/**
 * Returns a fuzzy match result for `query` against `target`.
 * Higher score is better. Returns `null` when the query does not match.
 *
 * The `matches` array contains `[start, end]` index pairs for each
 * matched character in `target`, suitable for rendering highlighted text.
 *
 * Scoring factors:
 *  - Each matched character contributes 1 point.
 *  - Consecutive matches earn a bonus (2 points per consecutive char).
 *  - Matches at the start of a word (after space, hyphen, or underscore)
 *    earn a 5-point bonus.
 *  - Shorter targets are slightly preferred.
 */
export function fuzzyMatch(
	query: string,
	target: string,
): { score: number; matches: number[][] } | null {
	const q = query.toLowerCase();
	const t = target.toLowerCase();

	if (q === "") return { score: 0, matches: [] };

	let qi = 0;
	let score = 0;
	let lastMatchIndex = -1;
	let consecutive = 0;
	const matches: number[][] = [];

	for (let ti = 0; ti < t.length && qi < q.length; ti++) {
		if (t[ti] === q[qi]) {
			if (lastMatchIndex === ti - 1) {
				consecutive++;
				score += consecutive * 2;
			} else {
				consecutive = 0;
				score += 1;
			}
			if (
				ti === 0 ||
				t[ti - 1] === " " ||
				t[ti - 1] === "-" ||
				t[ti - 1] === "_"
			) {
				score += 5;
			}
			matches.push([ti, ti + 1]);
			lastMatchIndex = ti;
			qi++;
		}
	}

	if (qi < q.length) return null;

	score -= t.length * 0.1;

	return { score, matches };
}
