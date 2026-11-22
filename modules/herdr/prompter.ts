// The questions the `kalfa space new` form asks, behind one small interface:
// the form depends on `Prompter`, never on the prompt library, so tests drive
// it with set answers and the library can change without touching the form.
// `inquirerPrompter` is the real one, over @inquirer/prompts; it needs a TTY.
import { confirm, input, search, select } from '@inquirer/prompts';

export interface Choice<T> {
	value: T;
	name: string;
	description?: string;
}

export interface Prompter {
	/** Free text; `validate` returns an error text or true. */
	input(message: string, options?: { default?: string; validate?: (value: string) => string | true }): Promise<string>;
	/** One of a short list. */
	select<T>(message: string, choices: readonly Choice<T>[], options?: { default?: T }): Promise<T>;
	/** One of a long list, filtered as the Operator types; the first match is preselected. */
	search<T>(message: string, choices: readonly Choice<T>[]): Promise<T>;
	confirm(message: string, options?: { default?: boolean }): Promise<boolean>;
}

/** Choices whose name or description holds every typed word, in their order. */
export function filterChoices<T>(choices: readonly Choice<T>[], term: string | undefined): Choice<T>[] {
	const words = (term ?? '').toLowerCase().split(/\s+/).filter(Boolean);
	return choices.filter((choice) => {
		const text = `${choice.name} ${choice.description ?? ''}`.toLowerCase();
		return words.every((word) => text.includes(word));
	});
}

export const inquirerPrompter: Prompter = {
	input: (message, options = {}) => input({ message, default: options.default, validate: options.validate }),
	select: (message, choices, options = {}) => select({ message, choices: [...choices], default: options.default }),
	search: (message, choices) => search({ message, source: (term) => filterChoices(choices, term) }),
	confirm: (message, options = {}) => confirm({ message, default: options.default }),
};
