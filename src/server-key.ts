/** Canonical key for a server URL: lower-case origin plus path, no trailing slash. */
export function serverKey(serverUrl: string): string {
	try {
		const url = new URL(serverUrl.trim());
		return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return serverUrl.trim().replace(/\/+$/, "");
	}
}

/** Why a server URL is unusable, or null if it is fine. */
export function serverUrlProblem(value: string): string | null {
	try {
		const url = new URL(value.trim());
		if (url.protocol === "https:" || url.protocol === "http:") return null;
	} catch {
		// fall through
	}
	return value.trim().length === 0
		? "Enter the server URL, for example https://md.example.com."
		: `"${value.trim()}" is not a valid server URL. Use the full address, for example https://md.example.com.`;
}

/** A server key without "https://", for display. */
export function displayServer(key: string): string {
	return key.replace(/^https:\/\//, "");
}
