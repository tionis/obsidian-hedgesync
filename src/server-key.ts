/** Canonical key for a server URL: lower-case origin plus path, no trailing slash. */
export function serverKey(serverUrl: string): string {
	try {
		const url = new URL(serverUrl.trim());
		return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, "")}`;
	} catch {
		return serverUrl.trim().replace(/\/+$/, "");
	}
}
