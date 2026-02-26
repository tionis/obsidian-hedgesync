import {HedgeDocClient} from "hedgesync/obsidian";
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
		const cookie = settings.sessionCookie.trim();

		const client = new HedgeDocClient({
			serverUrl: reference.serverUrl,
			noteId: reference.noteId,
			cookie: cookie.length > 0 ? cookie : undefined,
			operationTimeout: settings.requestTimeoutMs,
			reconnect: {
				enabled: false,
			},
			rateLimit: {
				enabled: false,
			},
		});

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
