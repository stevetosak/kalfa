// The continue word: a first prompt after /clear that says "go on with the
// branch's Task". Any other first prompt starts a new task.

export const CONTINUE_WORDS: readonly string[] = ['continue', 'c', 'go on'];

/** Case, outer spaces and a closing `.` or `!` do not count. */
export function isContinueWord(prompt: string): boolean {
	const word = prompt.trim().toLowerCase().replace(/[.!]+$/, '').replace(/\s+/g, ' ');
	return CONTINUE_WORDS.includes(word);
}
