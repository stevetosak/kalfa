// The words search and the lint compare: lower case, without the common
// English words that match every page and say nothing about it.
const STOP_WORDS = new Set(
	(
		'a an and are as at be been but by can do does for from has have if in into is it its no not of on or so such than that the their then there ' +
		'these this to was we were what when which who will with without you your our one each also only all any may must should would could ' +
		'i me my he she they them his her us out up over under after before more most other some same own just very now how why where'
	).split(' '),
);

/** One term as the index keeps it, or `null` when it carries no meaning. */
export function keepTerm(term: string): string | null {
	const lower = term.toLowerCase();
	return lower.length < 2 || STOP_WORDS.has(lower) ? null : lower;
}

/** The distinct meaningful words of a text (three letters or more). */
export function wordsOf(text: string): Set<string> {
	const words = new Set<string>();
	for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
		const word = keepTerm(raw);
		if (word && word.length >= 3) words.add(word);
	}
	return words;
}

/** How much two word sets overlap: shared words over all words (0 to 1). */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (!a.size || !b.size) return 0;
	let shared = 0;
	for (const word of a) if (b.has(word)) shared++;
	return shared / (a.size + b.size - shared);
}
