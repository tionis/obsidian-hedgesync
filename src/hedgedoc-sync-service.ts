import {requestUrl} from "obsidian";
import {
	buildNoteUrl,
	CreatedNoteRef,
	HedgeDocAPI,
	HedgeDocClient,
	type HedgeSyncHttpRequest,
	type HedgeSyncHttpResponse,
	type HedgeSyncRequestFn,
} from "hedgesync/obsidian";
import type {HedgeSyncPluginSettings} from "./settings";
import type {HedgeDocReference} from "./types";

const WAIT_INTERVAL_MS = 100;

export interface PushResult {
	changed: boolean;
}

export class HedgeDocSyncService {
	private readonly getSettings: () => HedgeSyncPluginSettings;
	private readonly requestFn: HedgeSyncRequestFn;

	constructor(getSettings: () => HedgeSyncPluginSettings) {
		this.getSettings = getSettings;
		this.requestFn = (request) => this.requestWithObsidian(request);
	}

	async pull(reference: HedgeDocReference): Promise<string> {
		return this.withClient(reference, false, (client) => client.getDocument());
	}

	async push(reference: HedgeDocReference, content: string): Promise<PushResult> {
		return this.withClient(reference, false, async (client) => {
			const currentContent = client.getDocument();
			if (currentContent === content) {
				return {changed: false};
			}

			client.updateContent(content);
			await this.waitUntilSynchronized(client, this.getSettings().requestTimeoutMs);
			return {changed: true};
		});
	}

	async download(reference: HedgeDocReference): Promise<string> {
		const api = this.createApi(reference.serverUrl);
		return api.downloadNote(reference.noteId);
	}

	async createNote(serverUrl: string, content: string): Promise<HedgeDocReference> {
		const api = this.createApi(serverUrl);
		const created = await api.createNoteRef(content);
		return toReference(created);
	}

	async connectLiveClient(reference: HedgeDocReference): Promise<HedgeDocClient> {
		const client = this.createClient(reference, true);
		try {
			await withTimeout(
				client.connect(),
				this.getSettings().requestTimeoutMs,
				`Timed out connecting to ${reference.url}`,
			);
			return client;
		} catch (error) {
			client.disconnect();
			throw error;
		}
	}

	private async withClient<T>(
		reference: HedgeDocReference,
		reconnect: boolean,
		action: (client: HedgeDocClient) => T | Promise<T>,
	): Promise<T> {
		const client = this.createClient(reference, reconnect);
		const timeoutMs = this.getSettings().requestTimeoutMs;

		try {
			await withTimeout(
				client.connect(),
				timeoutMs,
				`Timed out connecting to ${reference.url}`,
			);
			return await action(client);
		} finally {
			client.disconnect();
		}
	}

	private createClient(reference: HedgeDocReference, reconnect: boolean): HedgeDocClient {
		const settings = this.getSettings();
		const cookie = settings.sessionCookie.trim();

		return new HedgeDocClient({
			serverUrl: reference.serverUrl,
			noteId: reference.noteId,
			cookie: cookie.length > 0 ? cookie : undefined,
			runtime: "node",
			request: this.requestFn,
			operationTimeout: settings.requestTimeoutMs,
			reconnect: {
				enabled: reconnect,
			},
			rateLimit: {
				enabled: true,
			},
		});
	}

	private createApi(serverUrl: string): HedgeDocAPI {
		const settings = this.getSettings();
		const cookie = settings.sessionCookie.trim();
		return new HedgeDocAPI({
			serverUrl,
			cookie: cookie.length > 0 ? cookie : undefined,
			request: this.requestFn,
		});
	}

	private async requestWithObsidian(request: HedgeSyncHttpRequest): Promise<HedgeSyncHttpResponse> {
		const response = await requestUrl({
			url: request.url,
			method: request.method,
			headers: request.headers,
			body: request.body,
			throw: false,
		});

		const headers: Record<string, string> = {};
		for (const [key, value] of Object.entries(response.headers as Record<string, string | string[]>)) {
			headers[key] = Array.isArray(value) ? value.join('\n') : value;
		}

		return {
			status: response.status,
			headers,
			text: () => Promise.resolve(response.text),
			json: <T = unknown>() => Promise.resolve(JSON.parse(response.text) as T),
			arrayBuffer: () => Promise.resolve(response.arrayBuffer),
		};
	}

	private async waitUntilSynchronized(client: HedgeDocClient, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (client.isSynchronized() && client.getQueuedOperationCount() === 0) {
				return;
			}

			await wait(WAIT_INTERVAL_MS);
		}

		throw new Error("Timed out while waiting for hedgedoc to acknowledge changes.");
	}
}

function toReference(created: CreatedNoteRef): HedgeDocReference {
	return {
		serverUrl: created.serverUrl,
		noteId: created.noteId,
		url: buildNoteUrl(created.serverUrl, created.noteId),
	};
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
