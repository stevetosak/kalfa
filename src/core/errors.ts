/** An error the operator can act on: the CLI prints its message, not a stack. */
export class KalfaError extends Error {
	override name = 'KalfaError';
}
