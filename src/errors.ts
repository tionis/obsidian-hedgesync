/** Errors that mean "not allowed" rather than "not reachable". */
export function isAccessError(error: unknown): boolean {
	const status = (error as {statusCode?: unknown} | null)?.statusCode ?? (error as {code?: unknown} | null)?.code;
	if (status === 401 || status === 403) return true;
	const message = error instanceof Error ? error.message : String(error);
	return /forbidden|requires login|cannot edit this note|did not accept the session|not authenticated/i.test(message);
}
