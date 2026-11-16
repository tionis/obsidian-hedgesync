/**
 * Everything that talks to HedgeDoc: one place that knows which cookie goes
 * to which server, how to connect, and how to push, pull and create notes.
 */

import {
	buildNoteUrl,
	normalizeCookie,
	HedgeDocAPI,
	HedgeDocClient,
	type HistoryEntry,
	type NoteLinks,
	type HedgeSyncRequestFn,
} from "hedgesync/obsidian";
import {createNodeRequest, trustedCertificates} from "./net/http";
import type {HedgeSyncPluginSettings} from "./settings";
import type {HedgeDocReference} from "./types";

export type PushOutcome = "changed" | "unchanged" | "cancelled";

/** Decides whether to overwrite `remote`; called only when it differs from the local body. */
export type OverwriteCheck = (remote: string) => Promise<boolean>;

export class HedgeDocService {
	private readonly request: HedgeSyncRequestFn;

	constructor(
		private readonly getSettings: () => HedgeSyncPluginSettings,
		/** The saved session cookie for a server, if any. Never another server's. */
		readonly cookieFor: (serverUrl: string) => string | undefined,
	) {
		this.request = createNodeRequest(() => this.getSettings().requestTimeoutMs);
	}

	api(serverUrl: string, cookie = this.cookieFor(serverUrl)): HedgeDocAPI {
		return new HedgeDocAPI({serverUrl, cookie, request: this.request});
	}

	createClient(reference: HedgeDocReference, live: boolean): HedgeDocClient {
		const settings = this.getSettings();
		const ca = trustedCertificates();
		return new HedgeDocClient({
			serverUrl: reference.serverUrl,
			noteId: reference.noteId,
			cookie: this.cookieFor(reference.serverUrl),
			runtime: "node",
			request: this.request,
			socketTransports: ["websocket"],
			socketOptions: ca !== undefined ? {ca} : undefined,
			connectTimeout: settings.requestTimeoutMs,
			operationTimeout: settings.requestTimeoutMs,
			reconnect: {enabled: live},
			// Undo belongs to the editor, not to the sync client.
			trackUndo: false,
		});
	}

	/** Connect, run `action`, disconnect. */
	async withClient<T>(reference: HedgeDocReference, action: (client: HedgeDocClient) => T | Promise<T>): Promise<T> {
		const client = this.createClient(reference, false);
		try {
			await client.connect();
			return await action(client);
		} finally {
			client.disconnect();
		}
	}

	/** The live document (fresher than download(), which reads what the server last saved). */
	pull(reference: HedgeDocReference): Promise<string> {
		return this.withClient(reference, (client) => client.getDocument());
	}

	/** The note as last saved by the server, over plain HTTP. */
	download(reference: HedgeDocReference): Promise<string> {
		return this.api(reference.serverUrl).downloadNote(reference.noteId);
	}

	/** Make the remote note equal `body` with a minimal edit, over a single connection. */
	push(reference: HedgeDocReference, body: string, confirm?: OverwriteCheck): Promise<PushOutcome> {
		return this.withClient(reference, async (client) => {
			const remote = client.getDocument();
			if (remote === body) return "unchanged";
			if (confirm !== undefined && !await confirm(remote)) return "cancelled";
			if (!client.canEdit()) {
				throw new Error(`You cannot edit this note (permission: ${client.noteInfo.permission || "unknown"}). Log in, or ask the owner to change its permission.`);
			}
			client.updateContent(body);
			await client.flush();
			return "changed";
		});
	}

	async createNote(serverUrl: string, body: string): Promise<HedgeDocReference> {
		const created = await this.api(serverUrl).createNoteRef(body);
		return {serverUrl: created.serverUrl, noteId: created.noteId, url: buildNoteUrl(created.serverUrl, created.noteId)};
	}

	links(reference: HedgeDocReference): Promise<NoteLinks> {
		return this.api(reference.serverUrl).getNoteLinks(reference.noteId);
	}

	setPermission(reference: HedgeDocReference, permission: string): Promise<void> {
		return this.withClient(reference, (client) => client.setPermission(permission));
	}

	/** Note owner and current permission. */
	noteInfo(reference: HedgeDocReference): Promise<{permission: string; owner: string | null}> {
		return this.withClient(reference, (client) => ({permission: client.noteInfo.permission, owner: client.noteInfo.owner}));
	}

	/** Notes the logged-in user has opened on a server (HedgeDoc's history). */
	async history(serverUrl: string): Promise<HistoryEntry[]> {
		if (this.cookieFor(serverUrl) === undefined) throw new Error("Log in to this server to see your notes on it.");
		const result = await this.api(serverUrl).getHistory();
		return Array.isArray(result?.history) ? result.history : [];
	}

	setPinned(serverUrl: string, noteId: string, pinned: boolean): Promise<void> {
		return this.api(serverUrl).setHistoryPinned(noteId, pinned);
	}

	/** Open the note as the logged-in user, which makes HedgeDoc add it to their history. */
	async visit(reference: HedgeDocReference): Promise<void> {
		if (this.cookieFor(reference.serverUrl) === undefined) throw new Error("Log in to this server first.");
		await this.withClient(reference, () => undefined);
	}

	/** Who a cookie belongs to on a server; null for an anonymous or expired session. */
	async whoAmI(serverUrl: string, cookie = this.cookieFor(serverUrl)): Promise<{id: string; name: string} | null> {
		if (cookie === undefined) return null;
		let profile;
		try {
			profile = await this.api(serverUrl, cookie).getProfile();
		} catch (error) {
			if ((error as {statusCode?: number}).statusCode === 403) return null;
			throw error;
		}
		if (profile.status !== "ok" || profile.id === undefined) return null;
		return {id: profile.id, name: profile.name ?? profile.id};
	}

	/** End a session on the server (HedgeDoc 1: GET /logout). */
	async endSession(serverUrl: string): Promise<void> {
		const cookie = this.cookieFor(serverUrl);
		if (cookie === undefined) return;
		await this.request({
			url: `${serverUrl.replace(/\/+$/, "")}/logout`,
			method: "GET",
			headers: {Cookie: normalizeCookie(cookie)},
			redirect: "manual",
		});
	}
}
