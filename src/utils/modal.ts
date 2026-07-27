import type { SuggestModal } from "obsidian";

interface ChooserLike {
	selectedItem?: number;
	values?: unknown[];
	setSelectedItem(index: number, scrollIntoView: boolean): void;
}

function getChooser(modal: SuggestModal<unknown>): ChooserLike | undefined {
	return (modal as unknown as { chooser?: ChooserLike }).chooser;
}

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

/**
 * Renders `text` into `parentEl` with matched character ranges bolded.
 * Each `[start, end]` pair in `matches` is rendered in a
 * `suggestion-highlight` span; unmatched segments are plain text.
 */
export function renderHighlightedText(
	parentEl: HTMLElement,
	text: string,
	matches: number[][],
): void {
	if (!matches || matches.length === 0) {
		parentEl.setText(text);
		return;
	}

	let lastIndex = 0;
	for (const [start, end] of matches) {
		if (start > lastIndex) {
			parentEl.createSpan().setText(text.slice(lastIndex, start));
		}
		const highlightSpan = parentEl.createSpan({
			cls: "suggestion-highlight",
		});
		highlightSpan.setText(text.slice(start, end));
		lastIndex = end;
	}

	if (lastIndex < text.length) {
		parentEl.createSpan().setText(text.slice(lastIndex));
	}
}

export function registerEmacsMotionKeys(modal: SuggestModal<unknown>): void {
	const { inputEl, scope } = modal;

	scope.register(["Ctrl"], "F", (evt) => {
		evt.preventDefault();
		const start = inputEl.selectionStart ?? 0;
		const end = inputEl.selectionEnd ?? 0;

		if (start !== end) {
			inputEl.setSelectionRange(end, end);
		} else if (end < inputEl.value.length) {
			inputEl.setSelectionRange(end + 1, end + 1);
		}
		return false;
	});

	scope.register(["Ctrl"], "B", (evt) => {
		evt.preventDefault();
		const start = inputEl.selectionStart ?? 0;
		const end = inputEl.selectionEnd ?? 0;

		if (start !== end) {
			inputEl.setSelectionRange(start, start);
		} else if (start > 0) {
			inputEl.setSelectionRange(start - 1, start - 1);
		}
		return false;
	});

	scope.register(["Ctrl"], "N", (evt) => {
		evt.preventDefault();
		const chooser = getChooser(modal);
		if (!chooser || typeof chooser.setSelectedItem !== "function") {
			return false;
		}

		const current =
			typeof chooser.selectedItem === "number" ? chooser.selectedItem : 0;
		const count = Array.isArray(chooser.values) ? chooser.values.length : 0;
		const next = current + 1;

		if (next >= 0 && next < count) {
			chooser.setSelectedItem(next, true);
		}
		return false;
	});

	scope.register(["Ctrl"], "P", (evt) => {
		evt.preventDefault();
		const chooser = getChooser(modal);
		if (!chooser || typeof chooser.setSelectedItem !== "function") {
			return false;
		}

		const current =
			typeof chooser.selectedItem === "number" ? chooser.selectedItem : 0;
		const previous = current - 1;

		if (previous >= 0) {
			chooser.setSelectedItem(previous, true);
		}
		return false;
	});

	scope.register(["Ctrl"], "A", (evt) => {
		evt.preventDefault();
		inputEl.setSelectionRange(0, 0);
		return false;
	});

	scope.register(["Ctrl"], "E", (evt) => {
		evt.preventDefault();
		inputEl.setSelectionRange(
			inputEl.value.length,
			inputEl.value.length,
		);
		return false;
	});
}