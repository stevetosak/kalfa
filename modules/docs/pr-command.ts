// Reads what the Definition of Done gate needs out of a shell command line.
// The agent writes `gh pr create` in a few shapes (a `cd … &&` prefix, a
// heredoc body), so the command is searched as text, not executed or fully
// parsed. The PR command is GitHub's; another forge adds its own.
import { homedir } from 'node:os';

export interface PrCreate {
	/** Directory from a leading `cd <dir> &&`, if any (not resolved). */
	cdDir?: string;
	base?: string;
	head?: string;
	/** `owner/name` from `--repo`/`-R`. */
	repo?: string;
	bodyFile?: string;
}

// `gh` in command position: the start, or after `;` `&&` `||` `|` `(` `$(` or a
// newline, with optional `VAR=value` prefixes. `echo gh pr create` is not one.
const PR_CREATE = /(?:^|[;&|(\n])[ \t]*(?:\w+=\S*[ \t]+)*gh[ \t]+pr[ \t]+create\b/;

export const isPrCreate = (command: string) => PR_CREATE.test(command);

/** The value of the first of `flags`, in `--flag value`, `--flag=value` or quoted form. */
function flag(command: string, ...flags: string[]): string | undefined {
	const names = flags.map((f) => f.replace(/-/g, '\\-')).join('|');
	const match = new RegExp(`(?:^|\\s)(?:${names})(?:=|\\s+)(?:"([^"]*)"|'([^']*)'|([^\\s;&|]+))`).exec(command);
	return match ? (match[1] ?? match[2] ?? match[3]) : undefined;
}

const expandHome = (path: string) => (path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path);

export function parsePrCreate(command: string): PrCreate {
	const cd = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*(?:&&|;)/.exec(command);
	const cdDir = cd ? expandHome((cd[1] ?? cd[2] ?? cd[3])!) : undefined;
	const bodyFile = flag(command, '--body-file', '-F');
	return {
		cdDir,
		base: flag(command, '--base', '-B'),
		head: flag(command, '--head', '-H'),
		repo: flag(command, '--repo', '-R'),
		bodyFile: bodyFile === undefined ? undefined : expandHome(bodyFile),
	};
}

/**
 * The reason in a `Docs: none — <reason>` line, the PR body's way to skip the
 * Definition of Done. The line is visible in the PR, so every skip is on record.
 */
export function docsSkipReason(text: string): string | undefined {
	// At a line start, or right after the quote of a one-line `--body "…"`. The
	// reason ends at the line end or a quote.
	const match = /(?:^|["'])[ \t]*Docs:[ \t]*none[ \t]*(?:—|–|-{1,2})[ \t]*([^"'\n]*[^"'\s])/im.exec(text);
	return match?.[1];
}
