/**
 * HTTP transport for hedgesync, built on Node's http/https modules (the
 * plugin is desktop-only).
 *
 * Obsidian's requestUrl cannot be used: it always follows redirects, but
 * HedgeDoc reports a new note's id only in the redirect of POST /new, and the
 * anonymous session bootstrap needs Set-Cookie. Node's TLS stack also needs
 * the system certificate store to reach servers behind a private CA, which
 * the WebSocket connection shares (see trustedCertificates).
 */

import * as http from "node:http";
import * as https from "node:https";
import * as tls from "node:tls";
import type {HedgeSyncHttpRequest, HedgeSyncHttpResponse, HedgeSyncRequestFn} from "hedgesync/obsidian";

const MAX_REDIRECTS = 5;

let cachedCertificates: string[] | null | undefined;

/**
 * Node's bundled CA list plus the operating system's certificates, when this
 * Node version can read them (tls.getCACertificates, Node 22.15+). Undefined
 * means "use Node's default".
 */
export function trustedCertificates(): string[] | undefined {
	if (cachedCertificates === undefined) {
		cachedCertificates = null;
		const getCACertificates = (tls as unknown as {getCACertificates?: (type?: string) => string[]}).getCACertificates;
		if (typeof getCACertificates === "function") {
			try {
				const system = getCACertificates("system");
				if (system.length > 0) {
					cachedCertificates = [...new Set([...getCACertificates("default"), ...system])];
				}
			} catch {
				// Keep Node's defaults.
			}
		}
	}
	return cachedCertificates ?? undefined;
}

export function createNodeRequest(getTimeoutMs: () => number): HedgeSyncRequestFn {
	return async (request) => {
		let url = new URL(request.url);
		let method = request.method ?? "GET";
		let body = request.body;
		for (let redirects = 0; ; redirects++) {
			const response = await send(url, method, request.headers ?? {}, body, getTimeoutMs());
			const location = response.headers.location;
			if (request.redirect !== "follow" || response.status < 300 || response.status >= 400 || location === undefined) {
				return response;
			}
			if (redirects >= MAX_REDIRECTS) {
				throw new Error(`Too many redirects from ${request.url}`);
			}
			url = new URL(location, url);
			if (response.status !== 307 && response.status !== 308) {
				method = "GET";
				body = undefined;
			}
		}
	};
}

function send(
	url: URL,
	method: string,
	headers: Record<string, string>,
	body: HedgeSyncHttpRequest["body"],
	timeoutMs: number,
): Promise<HedgeSyncHttpResponse & {headers: Record<string, string>}> {
	return new Promise((resolve, reject) => {
		const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : new Uint8Array(body));
		const outgoing: Record<string, string> = {...headers};
		if (payload !== undefined) outgoing["Content-Length"] = String(payload.length);

		const secure = url.protocol === "https:";
		const options: https.RequestOptions = {method, headers: outgoing, timeout: timeoutMs};
		if (secure) {
			const ca = trustedCertificates();
			if (ca !== undefined) options.ca = ca;
		}

		const req = (secure ? https : http).request(url, options, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("error", reject);
			res.on("end", () => {
				const data = Buffer.concat(chunks);
				const responseHeaders: Record<string, string> = {};
				for (const [name, value] of Object.entries(res.headers)) {
					if (value === undefined) continue;
					responseHeaders[name] = Array.isArray(value) ? value.join(name === "set-cookie" ? "\n" : ", ") : value;
				}
				const text = () => data.toString("utf8");
				resolve({
					status: res.statusCode ?? 0,
					headers: responseHeaders,
					text: () => Promise.resolve(text()),
					json: <T = unknown>() => Promise.resolve(JSON.parse(text()) as T),
					arrayBuffer: () => Promise.resolve(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)),
				});
			});
		});
		req.on("timeout", () => req.destroy(new Error(`Request to ${url.origin} timed out after ${timeoutMs} ms`)));
		req.on("error", (error) => reject(describeNetworkError(error, url)));
		if (payload !== undefined) req.write(payload);
		req.end();
	});
}

/** Readable messages for the network errors users actually hit. */
export function describeNetworkError(error: Error & {code?: string}, url: URL): Error {
	const code = error.code ?? "";
	let message: string | null = null;
	if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/.test(code)) {
		message = `The TLS certificate of ${url.host} is not trusted (${code}). If the server uses a private certificate authority, install it in the operating system's certificate store.`;
	} else if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
		message = `Cannot resolve ${url.hostname}. Check the server URL and your network connection.`;
	} else if (code === "ECONNREFUSED") {
		message = `${url.host} refused the connection.`;
	}
	if (message === null) return error;
	const wrapped = new Error(message);
	(wrapped as Error & {cause?: unknown}).cause = error;
	return wrapped;
}
