/**
 * One note in live sync: keeps the note body and a HedgeDoc document equal,
 * in both directions, while the connection lasts.
 *
 * Open editors are the source of truth on the Obsidian side. Their edits are
 * forwarded synchronously as operations, so the editor body and the client
 * document never drift apart while connected; remote operations are applied
 * to the editors as CodeMirror changes (cursors stay put, undo history only
 * holds the user's own edits). Without an open editor the file on disk is
 * read and written instead.
 *
 * While the connection is down, local edits stay local. When it comes back,
 * a three-way merge against the last agreed document keeps edits from both
 * sides.
 *
 * Free of Obsidian imports; the plugin supplies a LiveHost.
 */

import type {CursorPosition, HedgeDocClient, TextOperation, UserInfo} from "hedgesync/obsidian";
import {cursorFromIndex, diffToOperation} from "hedgesync/obsidian";
import {mergeMarkdownContent, splitMarkdownContent} from "../markdown";
import type {HedgeDocReference} from "../types";
import {changesFromOperation, type EditorChange, mergeDivergent, operationFromChanges} from "./operations";

/** An open editor showing the note. */
export interface EditorPort {
	getText(): string;
	/** Apply changes as a remote edit: not added to undo history, not echoed back. */
	applyRemote(changes: EditorChange[]): void;
}

export interface LiveHost {
	/** Editors currently showing the file. */
	editors(path: string): EditorPort[];
	readFile(path: string): Promise<string>;
	/** Replace the file's content (only called when no editor shows it). */
	writeFile(path: string, transform: (current: string) => string): Promise<void>;
	notify(message: string): void;
}

export type LiveState = "connecting" | "live" | "read-only" | "offline" | "stopped";

export interface LiveStatus {
	state: LiveState;
	/** Other people connected to the note. */
	others: UserInfo[];
}

/** Another user's cursor, as a line/column in the note body. */
export interface RemoteCursor {
	id: string;
	name: string;
	color: string | null;
	cursor: CursorPosition;
}

/** How to resolve different local and remote content when starting. */
export type BaselineChoice = (local: string, remote: string) => Promise<"local" | "remote">;

const DISK_WRITE_DELAY_MS = 300;
/** Cursor moves are sent at most this often (HedgeDoc's editor debounces too). */
const CURSOR_SEND_DELAY_MS = 100;

export class LiveSession {
	state: LiveState = "connecting";
	/** Last body both sides agreed on. */
	private agreed = "";
	private diskTimer: number | null = null;
	/** The file changed on disk while offline (no editor open). */
	private fileChangedOffline = false;
	private readOnlyNoticeShown = false;
	private readonly listeners = new Set<(status: LiveStatus) => void>();
	private readonly cursorListeners = new Set<() => void>();
	/** The local cursor last sent (null: none shown), and one waiting to be sent. */
	private sentCursor: CursorPosition | null = null;
	private pendingCursor: CursorPosition | null = null;
	private cursorTimer: number | null = null;
	private readonly cleanup: (() => void)[] = [];

	constructor(
		public path: string,
		readonly reference: HedgeDocReference,
		readonly client: HedgeDocClient,
		private readonly host: LiveHost,
	) {}

	// ------------------------------------------------------------------
	// Lifecycle
	// ------------------------------------------------------------------

	async start(chooseBaseline: BaselineChoice): Promise<void> {
		this.listen("change", (event: {type: string; operation: TextOperation}) => {
			if (event.type === "remote") this.onRemoteOperation(event.operation);
		});
		// Document replacements (e.g. after a reconnect) arrive without an operation.
		this.listen("document", () => queueMicrotask(() => this.onDocumentReplaced()));
		this.listen("disconnect", () => this.onDisconnect());
		this.listen("ready", () => this.onReconnected());
		this.listen("users", () => {
			this.emitStatus();
			this.emitCursors();
		});
		this.listen("user:left", () => this.emitCursors());
		for (const event of ["cursor:focus", "cursor:activity", "cursor:blur"]) {
			this.listen(event, () => this.emitCursors());
		}
		this.listen("permission", () => this.refreshEditState());
		this.listen("refresh", () => this.refreshEditState());
		this.listen("reconnect:failed", () => {
			this.host.notify(`Live sync for "${this.reference.url}" lost its connection and gave up reconnecting.`);
		});

		await this.client.connect();
		if (this.stopped()) return;

		const local = splitMarkdownContent(await this.localText()).body;
		const remote = this.client.getDocument();
		if (local !== remote && this.client.canEdit() && await chooseBaseline(local, remote) === "local") {
			this.client.updateContent(local);
		}
		if (this.stopped()) return;
		this.agreed = this.client.getDocument();
		this.pushToLocal(this.agreed);
		this.refreshEditState();
		this.emitCursors();
		if (this.pendingCursor !== null) this.sendCursor(this.pendingCursor);
	}

	/** A method, not a field check, so TypeScript does not narrow across awaits. */
	stopped(): boolean {
		return this.state === "stopped";
	}

	stop(): void {
		if (this.state === "stopped") return;
		this.state = "stopped";
		if (this.diskTimer !== null) window.clearTimeout(this.diskTimer);
		if (this.cursorTimer !== null) window.clearTimeout(this.cursorTimer);
		for (const off of this.cleanup) off();
		this.cleanup.length = 0;
		this.client.disconnect();
		this.emitStatus();
		this.emitCursors();
		this.listeners.clear();
		this.cursorListeners.clear();
	}

	onStatus(listener: (status: LiveStatus) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	status(): LiveStatus {
		const selfId = this.client.socket?.id;
		const others = this.state === "stopped" ? [] : this.client.getOnlineUsers().filter((user) => user.id !== selfId);
		return {state: this.state, others};
	}

	// ------------------------------------------------------------------
	// Cursors
	// ------------------------------------------------------------------

	/** Called when others' cursors may have changed. */
	onCursors(listener: () => void): () => void {
		this.cursorListeners.add(listener);
		return () => this.cursorListeners.delete(listener);
	}

	/**
	 * Others' cursors in the shared document (the note body). Empty unless
	 * connected, since positions only fit the document both sides share.
	 */
	remoteCursors(): RemoteCursor[] {
		if (this.state !== "live" && this.state !== "read-only") return [];
		const selfId = this.client.socket?.id;
		const cursors: RemoteCursor[] = [];
		for (const user of this.client.getOnlineUsers()) {
			if (user.id === selfId || user.cursor === null || user.cursor === undefined) continue;
			cursors.push({id: user.id, name: user.name ?? "Guest", color: user.color ?? null, cursor: user.cursor});
		}
		return cursors;
	}

	/**
	 * The local cursor moved: `head` is an offset in the editor's `text`, or
	 * null when the editor lost focus. A cursor in the front matter is not
	 * shown to others, since they cannot see the front matter.
	 */
	setLocalCursor(text: string, head: number | null): void {
		let cursor: CursorPosition | null = null;
		if (head !== null) {
			const parts = splitMarkdownContent(text);
			const offset = parts.frontmatterBlock?.length ?? 0;
			if (head >= offset) cursor = cursorFromIndex(parts.body, head - offset);
		}
		this.pendingCursor = cursor;
		if (this.cursorTimer !== null) return;
		this.cursorTimer = window.setTimeout(() => {
			this.cursorTimer = null;
			this.sendCursor(this.pendingCursor);
		}, CURSOR_SEND_DELAY_MS);
	}

	private sendCursor(cursor: CursorPosition | null, force = false): void {
		if (this.state !== "live" && this.state !== "read-only") return;
		const sent = this.sentCursor;
		if (!force && (cursor === sent || (cursor !== null && sent !== null && cursor.line === sent.line && cursor.ch === sent.ch))) return;
		this.client.setCursor(cursor);
		this.sentCursor = cursor;
	}

	private emitCursors(): void {
		for (const listener of this.cursorListeners) listener();
	}

	private listen(event: string, handler: (...args: never[]) => void): void {
		const wrapped = (...args: unknown[]) => {
			if (this.state !== "stopped") (handler as (...a: unknown[]) => void)(...args);
		};
		this.client.on(event, wrapped);
		this.cleanup.push(() => this.client.off(event, wrapped));
	}

	private emitStatus(): void {
		const status = this.status();
		for (const listener of this.listeners) listener(status);
	}

	private setState(state: LiveState): void {
		if (this.state === state || this.state === "stopped") return;
		this.state = state;
		this.emitStatus();
	}

	private refreshEditState(): void {
		if (this.state === "stopped" || this.state === "offline" || !this.client.ready) return;
		this.setState(this.client.canEdit() ? "live" : "read-only");
	}

	private get sending(): boolean {
		return this.state === "live";
	}

	// ------------------------------------------------------------------
	// Local → remote
	// ------------------------------------------------------------------

	/** An editor changed (not by us). `changes` are relative to `before`. */
	onEditorChange(before: string, after: string, changes: EditorChange[]): void {
		if (!this.sending) {
			this.noteUnsentEdit();
			return;
		}
		const afterBody = splitMarkdownContent(after).body;
		if (afterBody === this.client.getDocument()) return; // e.g. the same edit echoed by a second pane
		const beforeParts = splitMarkdownContent(before);
		const offset = beforeParts.frontmatterBlock?.length ?? 0;
		let operation: TextOperation | null = null;
		if (beforeParts.body === this.client.getDocument()) {
			operation = operationFromChanges(changes, offset, beforeParts.body.length);
			if (operation !== null && operation.apply(beforeParts.body) !== afterBody) operation = null;
		}
		try {
			if (operation !== null) {
				this.client.applyOperation(operation);
			} else {
				this.client.updateContent(afterBody);
			}
		} catch (error) {
			console.error("[hedgesync] could not send a local edit", error);
		}
		this.agreed = this.client.getDocument();
	}

	/** The file changed on disk (used when no editor shows it). */
	onFileChanged(text: string): void {
		if (this.host.editors(this.path).length > 0) return; // the editor reports its own changes
		const body = splitMarkdownContent(text).body;
		if (body === this.client.getDocument()) return;
		if (!this.sending) {
			this.fileChangedOffline = true;
			this.noteUnsentEdit();
			return;
		}
		try {
			this.client.updateContent(body);
		} catch (error) {
			console.error("[hedgesync] could not send a file change", error);
		}
		this.agreed = this.client.getDocument();
	}

	private noteUnsentEdit(): void {
		if (this.state === "read-only" && !this.readOnlyNoticeShown) {
			this.readOnlyNoticeShown = true;
			this.host.notify("You cannot edit this hedgedoc note, so local changes are not sent and will be replaced by remote changes.");
		}
	}

	// ------------------------------------------------------------------
	// Remote → local
	// ------------------------------------------------------------------

	private onRemoteOperation(operation: TextOperation): void {
		if (this.state === "offline" || this.state === "connecting") return;
		const previous = this.agreed;
		const next = this.client.getDocument();
		this.agreed = next;
		const editors = this.host.editors(this.path);
		if (editors.length === 0) {
			this.scheduleDiskWrite();
			return;
		}
		for (const editor of editors) {
			const parts = splitMarkdownContent(editor.getText());
			if (parts.body === next) continue;
			const offset = parts.frontmatterBlock?.length ?? 0;
			editor.applyRemote(parts.body === previous
				? changesFromOperation(operation, offset)
				: changesFromOperation(diffToOperation(parts.body, next), offset));
		}
	}

	private onDocumentReplaced(): void {
		if (this.state !== "live" && this.state !== "read-only") return;
		const document = this.client.getDocument();
		if (document === this.agreed) return;
		this.agreed = document;
		this.pushToLocal(document);
	}

	/** Make every editor (or the file) show `body`. */
	private pushToLocal(body: string): void {
		const editors = this.host.editors(this.path);
		if (editors.length === 0) {
			this.scheduleDiskWrite();
			return;
		}
		for (const editor of editors) {
			const parts = splitMarkdownContent(editor.getText());
			if (parts.body !== body) {
				editor.applyRemote(changesFromOperation(diffToOperation(parts.body, body), parts.frontmatterBlock?.length ?? 0));
			}
		}
	}

	/** Bring a newly opened editor up to date. */
	syncEditor(editor: EditorPort): void {
		if (this.state !== "live" && this.state !== "read-only") return;
		const parts = splitMarkdownContent(editor.getText());
		const document = this.client.getDocument();
		if (parts.body !== document) {
			editor.applyRemote(changesFromOperation(diffToOperation(parts.body, document), parts.frontmatterBlock?.length ?? 0));
		}
	}

	private scheduleDiskWrite(): void {
		if (this.diskTimer !== null) window.clearTimeout(this.diskTimer);
		this.diskTimer = window.setTimeout(() => {
			this.diskTimer = null;
			if (this.state === "stopped" || this.host.editors(this.path).length > 0) return;
			const body = this.client.getDocument();
			this.host.writeFile(this.path, (current) => {
				const parts = splitMarkdownContent(current);
				return parts.body === body ? current : mergeMarkdownContent(parts, body);
			}).catch((error: unknown) => console.error("[hedgesync] could not write the note", error));
		}, DISK_WRITE_DELAY_MS);
	}

	// ------------------------------------------------------------------
	// Connection loss
	// ------------------------------------------------------------------

	private onDisconnect(): void {
		if (this.state === "connecting") return;
		this.setState("offline");
		this.emitCursors();
	}

	private onReconnected(): void {
		if (this.state !== "offline") return;
		const editors = this.host.editors(this.path);
		const editor = editors[0];
		if (editor !== undefined) {
			this.mergeAfterReconnect(splitMarkdownContent(editor.getText()).body);
			return;
		}
		if (!this.fileChangedOffline) {
			this.finishReconnect();
			return;
		}
		// Keep "offline" while reading: remote changes meanwhile only update the client.
		void this.host.readFile(this.path).then((text) => {
			if (this.state === "offline") this.mergeAfterReconnect(splitMarkdownContent(text).body);
		}, (error: unknown) => {
			console.error("[hedgesync] could not read the note after reconnecting", error);
			if (this.state === "offline") this.finishReconnect();
		});
	}

	private mergeAfterReconnect(local: string): void {
		this.fileChangedOffline = false;
		const remote = this.client.getDocument();
		const result = mergeDivergent(this.agreed, local, remote);
		if (result.toServer !== null && this.client.canEdit()) {
			try {
				this.client.applyOperation(result.toServer);
			} catch (error) {
				console.error("[hedgesync] could not send edits made while offline", error);
			}
		}
		this.finishReconnect();
	}

	private finishReconnect(): void {
		this.agreed = this.client.getDocument();
		this.state = this.client.canEdit() ? "live" : "read-only";
		this.pushToLocal(this.agreed);
		this.emitStatus();
		this.emitCursors();
		// The server forgot our cursor with the old connection.
		const cursor = this.pendingCursor;
		this.sentCursor = null;
		if (cursor !== null) this.sendCursor(cursor, true);
	}

	/** Read the note as the user sees it: an open editor, else the file. */
	private async localText(): Promise<string> {
		const editor = this.host.editors(this.path)[0];
		return editor !== undefined ? editor.getText() : this.host.readFile(this.path);
	}
}
