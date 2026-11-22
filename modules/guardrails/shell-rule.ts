// The shell rule: it refuses a command line that makes the agent's git skip
// its hooks folder (git-hooks.ts), where the push check runs. The check of
// the push itself is in the pre-push hook, so this rule only reads the text:
// it splits each line into words, with quotes kept as one word, and expands
// nothing. A command that hides one of these forms in a script, or in
// `bash -c "…"`, gets through; the server's branch protection is the last stop.
//
// The forms (proved with git 2.34): `--no-verify` on a push; `core.hooksPath`
// for one git command (`-c`, `--config-env`), which comes after the
// environment's entry; a change of git's config entries in the environment;
// `env -i` on a line that pushes. The repository's own `core.hooksPath` comes
// before the environment's entry, so `git config core.hooksPath …` passes.

/** The environment variables that carry git config for one command. */
const GIT_CONFIG_VARIABLE = /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/;
/** `env` options that take the next word as their value. */
const ENV_VALUE_OPTIONS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
/** Characters that end a simple command outside quotes; backquotes and parentheses open a command in a command. */
const SEPARATORS = new Set([';', '&', '|', '(', ')', '`']);

/**
 * The simple commands of a command line, as words. A quoted text is one word
 * without its quotes. Each line starts with no quote open, so a lone
 * apostrophe in a heredoc body does not hide the lines after it.
 */
export function simpleCommands(text: string): string[][] {
	const commands: string[][] = [];
	for (const line of text.split(/\r?\n/)) {
		let words: string[] = [];
		let word: string | undefined;
		let quote: string | undefined;
		const endWord = () => {
			if (word !== undefined) words.push(word);
			word = undefined;
		};
		const endCommand = () => {
			endWord();
			if (words.length) commands.push(words);
			words = [];
		};
		for (let at = 0; at < line.length; at++) {
			const char = line[at]!;
			if (quote) {
				if (char === quote) quote = undefined;
				else word = (word ?? '') + (char === '\\' && quote === '"' ? (line[++at] ?? '') : char);
			} else if (char === '"' || char === "'") {
				quote = char;
				word ??= '';
			} else if (char === '\\') word = (word ?? '') + (line[++at] ?? '');
			else if (/\s/.test(char)) endWord();
			else if (SEPARATORS.has(char)) endCommand();
			else word = (word ?? '') + char;
		}
		endCommand();
	}
	return commands;
}

/** Why one simple command skips the hooks; `undefined` when it does not. */
type Rule = (words: readonly string[]) => string | undefined;

const noVerify: Rule = (words) => {
	const push = words.indexOf('push');
	return push >= 0 && words.slice(push + 1).includes('--no-verify') ? '--no-verify on a push skips the push check' : undefined;
};

const isHooksPath = (entry: string | undefined) => /^core\.hookspath(?:=|$)/i.test(entry ?? '');

const hooksPathForOneCommand: Rule = (words) => {
	const found = words.some((word, at) => {
		if (word === '-c' || word === '--config-env') return isHooksPath(words[at + 1]);
		return word.startsWith('--config-env=') && isHooksPath(word.slice('--config-env='.length));
	});
	return found ? "core.hooksPath for one git command replaces the agent's hooks folder" : undefined;
};

/** A set (`NAME=…` alone, after `export` or `env`) or an unset (`unset`, `export -n`, env's `-u`/`--unset`); a read passes. */
const gitConfigEnvironment: Rule = (words) => {
	const unsets = words.includes('unset') || (words.includes('export') && words.includes('-n'));
	const changed = words.find((word, at) => {
		const assigned = /^([A-Za-z_]\w*)=/.exec(word)?.[1];
		if (assigned) return GIT_CONFIG_VARIABLE.test(assigned);
		const name = word.replace(/^(?:--unset=|-u)/, '');
		if (!GIT_CONFIG_VARIABLE.test(name)) return false;
		return name !== word || unsets || words[at - 1] === '-u' || words[at - 1] === '--unset';
	});
	return changed ? `a change of git's config in the environment (${changed}) replaces the agent's hooks folder` : undefined;
};

/** `env` started with an empty environment: `-i`, `--ignore-environment`, `-`, or a short option group with `i`. */
function clearsEnvironment(words: readonly string[]): boolean {
	const start = words.findIndex((word) => word === 'env' || word.endsWith('/env'));
	if (start < 0) return false;
	for (let at = start + 1; at < words.length && words[at]!.startsWith('-'); at++) {
		const option = words[at]!;
		if (option === '-' || option === '--ignore-environment' || /^-[a-zA-Z]*i[a-zA-Z]*$/.test(option)) return true;
		if (ENV_VALUE_OPTIONS.has(option)) at++;
	}
	return false;
}

/** Why the command line makes the agent's git skip its hooks; empty when it does not. */
export function hookSkips(line: string): string[] {
	const commands = simpleCommands(line);
	const pushes = commands.some((words) => words.includes('push'));
	const reasons = new Set<string>();
	for (const words of commands) {
		for (const rule of [noVerify, hooksPathForOneCommand, gitConfigEnvironment]) {
			const reason = rule(words);
			if (reason) reasons.add(`${reason} (${words.join(' ')})`);
		}
		if (pushes && clearsEnvironment(words)) reasons.add(`env with an empty environment on a line that pushes drops the agent's hooks folder (${words.join(' ')})`);
	}
	return [...reasons];
}
