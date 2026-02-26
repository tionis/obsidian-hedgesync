import {requestUrl} from "obsidian";
import {HedgeDocClient} from "hedgesync";
import type {HedgeSyncPluginSettings} from "./settings";
import type {HedgeDocReference} from "./types";

const WAIT_INTERVAL_MS = 100;

export interface PushResult {
	changed: boolean;
}

export class HedgeDocSyncService {
	private readonly getSettings: () => HedgeSyncPluginSettings;

	constructor(getSettings: () => HedgeSyncPluginSettings) {
		this.getSettings = getSettings;
	}

	async pull(reference: HedgeDocReference): Promise<string> {
		return this.withClient(reference, async (client) => {
			return client.getDocument();
		});
	}

	async push(reference: HedgeDocReference, content: string): Promise<PushResult> {
		return this.withClient(reference, async (client) => {
			const currentContent = client.getDocument();
			if (currentContent === content) {
				return {changed: false};
			}

			client.setContent(content);
			await this.waitUntilSynchronized(client, this.getSettings().requestTimeoutMs);
			return {changed: true};
		});
	}

	private async withClient<T>(
		reference: HedgeDocReference,
		action: (client: HedgeDocClient) => Promise<T>,
	): Promise<T> {
		const settings = this.getSettings();
		const cookie = await this.resolveSessionCookie(reference, settings);

		const client = new HedgeDocClient({
			serverUrl: reference.serverUrl,
			noteId: reference.noteId,
			cookie,
			operationTimeout: settings.requestTimeoutMs,
			reconnect: {
				enabled: false,
			},
			rateLimit: {
				enabled: false,
			},
		});
		this.forceDesktopRuntime(client);

		try {
			await withTimeout(
				client.connect(),
				settings.requestTimeoutMs,
				`Timed out connecting to ${reference.url}`,
			);
			return await action(client);
		} finally {
			client.disconnect();
		}
	}

	private async resolveSessionCookie(
		reference: HedgeDocReference,
		settings: HedgeSyncPluginSettings,
	): Promise<string> {
		const configuredCookie = settings.sessionCookie.trim();
		if (configuredCookie.length > 0) {
			return configuredCookie;
		}

		const response = await requestUrl({
			url: `${reference.serverUrl}/${reference.noteId}`,
			method: "GET",
			headers: {
				Accept: "text/html",
			},
			throw: false,
		});

		if (response.status >= 400) {
			throw new Error(`Failed to initialize session cookie from ${reference.url}: HTTP ${response.status}`);
		}

		const setCookieHeader = getHeaderCaseInsensitive(response.headers, "set-cookie");
		const parsedCookies = parseSetCookieHeader(setCookieHeader);
		if (parsedCookies.length === 0) {
			throw new Error(
				`Failed to initialize session cookie from ${reference.url}: no Set-Cookie header found.`,
			);
		}

		const sessionCookie = parsedCookies.find((cookie) => cookie.startsWith("connect.sid="));
		return sessionCookie ?? parsedCookies.join("; ");
	}

	private forceDesktopRuntime(client: HedgeDocClient): void {
		(client as unknown as HedgeDocClientWithInternals)._isBrowserRuntime = () => false;
	}

	private async waitUntilSynchronized(client: HedgeDocClient, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (client.isSynchronized() && client.getQueuedOperationCount() === 0) {
				return;
			}

			await wait(WAIT_INTERVAL_MS);
		}

		throw new Error("Timed out while waiting for HedgeDoc to acknowledge changes.");
	}
}

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	let timerId: number | null = null;

	const timeoutPromise = new Promise<never>((_, reject) => {
		timerId = window.setTimeout(() => {
			reject(new Error(message));
		}, timeoutMs);
	});

	try {
		return await Promise.race([promise, timeoutPromise]);
	} finally {
		if (timerId !== null) {
			window.clearTimeout(timerId);
		}
	}
}

interface HedgeDocClientWithInternals {
	_isBrowserRuntime?: () => boolean;
}

function getHeaderCaseInsensitive(headers: Record<string, string>, key: string): string | undefined {
	const target = key.toLowerCase();
	for (const [headerName, headerValue] of Object.entries(headers)) {
		if (headerName.toLowerCase() === target) {
			return headerValue;
		}
	}

	return undefined;
}

function parseSetCookieHeader(headerValue: string | undefined): string[] {
	if (headerValue === undefined || headerValue.trim().length === 0) {
		return [];
	}

	const matches = headerValue.matchAll(/(?:^|,\s*)([^=;, \t]+)=([^;,]+)/g);
	const cookies: string[] = [];

	for (const match of matches) {
		const cookieName = match[1];
		const cookieValue = match[2];
		if (cookieName !== undefined && cookieValue !== undefined) {
			cookies.push(`${cookieName}=${cookieValue}`);
		}
	}

	return cookies;
}
