// The push check of the agent's pre-push hook (git-hooks.ts): git hands the
// hook one line per ref it is about to update on the remote, so the check
// reads what the push sends, whatever command line started it.

/** Why the refs on the hook's input write a protected branch; empty when none does. */
export function protectedRefs(input: string, protectedBranches: readonly string[]): string[] {
	const reasons = new Set<string>();
	for (const line of input.split('\n')) {
		// <local ref> SP <local object name> SP <remote ref> SP <remote object name>
		const [, localObject, remoteRef] = line.trim().split(/\s+/);
		const branch = remoteRef?.startsWith('refs/heads/') ? remoteRef.slice('refs/heads/'.length) : undefined;
		if (!branch || !protectedBranches.includes(branch)) continue;
		reasons.add(/^0+$/.test(localObject ?? '') ? `a delete of the protected branch '${branch}'` : `a push to the protected branch '${branch}'`);
	}
	return [...reasons];
}
