/**
 * Live sync sessions in Obsidian: connects LiveSession to CodeMirror editors,
 * vault events and the workspace.
 */

import {Annotation, Transaction} from "@codemirror/state";
import {EditorView, type ViewUpdate} from "@codemirror/view";
import {editorInfoField, MarkdownView, type TAbstractFile, TFile, type WorkspaceLeaf} from "obsidian";
import type {HedgeDocService} from "../hedgedoc-service";
import type {HedgeDocReference} from "../types";
import {indexFromCursor} from "hedgesync/obsidian";
import {splitMarkdownContent} from "../markdown";
import {type CursorMark, remoteCursorExtension, setRemoteCursors} from "./cursors";
import type {EditorChange} from "./operations";
import {type BaselineChoice, type EditorPort, type LiveHost, LiveSession, type LiveStatus} from "./session";
import type ObsidianHedgeSyncPlugin from "../main";

/** Marks transactions that carry remote edits, so they are not sent back. */
const remoteEdit = Annotation.define<boolean>();

function editorView(view: MarkdownView): EditorView | null {
	const cm = (view.editor as unknown as {cm?: unknown}).cm;
	return cm instanceof EditorView ? cm : null;
}

function portFor(cm: EditorView): EditorPort {
	return {
		getText: () => cm.state.doc.toString(),
		applyRemote: (changes: EditorChange[]) => {
			if (changes.length === 0) return;
			cm.dispatch({
				changes,
				annotations: [remoteEdit.of(true), Transaction.addToHistory.of(false)],
			});
		},
	};
}

export class LiveSyncManager {
	private readonly sessions = new Map<string, LiveSession>();
	private readonly statusListeners = new Set<() => void>();
	private readonly host: LiveHost;
	/** Paths open in some tab at the last layout change (for auto start/stop). */
	private openPaths = new Set<string>();

	constructor(
		private readonly plugin: ObsidianHedgeSyncPlugin,
		private readonly service: HedgeDocService,
	) {
		const app = plugin.app;
		this.host = {
			editors: (path) => this.editorsFor(path),
			readFile: async (path) => {
				const file = app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) throw new Error(`${path} no longer exists`);
				return app.vault.read(file);
			},
			writeFile: async (path, transform) => {
				const file = app.vault.getAbstractFileByPath(path);
				if (!(file instanceof TFile)) throw new Error(`${path} no longer exists`);
				await app.vault.process(file, transform);
			},
			notify: (message) => plugin.notify(message),
		};
	}

	register(): void {
		const {app} = this.plugin;
		this.plugin.registerEditorExtension([
			remoteCursorExtension,
			EditorView.updateListener.of((update) => this.onEditorUpdate(update)),
		]);
		this.plugin.registerEvent(app.vault.on("modify", (file) => this.onModify(file)));
		this.plugin.registerEvent(app.vault.on("rename", (file, oldPath) => this.onRename(file, oldPath)));
		this.plugin.registerEvent(app.vault.on("delete", (file) => {
			if (this.sessions.has(file.path)) this.stop(file.path, "Live sync stopped because the note was deleted.");
		}));
		this.plugin.registerEvent(app.workspace.on("layout-change", () => this.onLayoutChange()));
		// Opening another note in the same tab does not always change the layout.
		this.plugin.registerEvent(app.workspace.on("file-open", () => this.onLayoutChange()));
		app.workspace.onLayoutReady(() => this.onLayoutChange());
	}

	dispose(): void {
		for (const path of [...this.sessions.keys()]) this.stop(path, null);
		this.statusListeners.clear();
	}

	isLive(path: string): boolean {
		return this.sessions.has(path);
	}

	status(path: string): LiveStatus | null {
		return this.sessions.get(path)?.status() ?? null;
	}

	/** Called whenever any session's status changes, or sessions start/stop. */
	onStatusChange(listener: () => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	private emitStatus(): void {
		for (const listener of this.statusListeners) listener();
	}

	async start(file: TFile, reference: HedgeDocReference, chooseBaseline: BaselineChoice): Promise<void> {
		this.stop(file.path, null);
		const client = this.service.createClient(reference, true);
		const session = new LiveSession(file.path, reference, client, this.host);
		this.sessions.set(file.path, session);
		session.onStatus(() => this.emitStatus());
		session.onCursors(() => this.showCursors(session));
		this.emitStatus();
		try {
			await session.start(chooseBaseline);
		} catch (error) {
			if (this.sessions.get(file.path) === session) this.sessions.delete(file.path);
			session.stop();
			this.emitStatus();
			throw error;
		}
	}

	stop(path: string, message: string | null): void {
		const session = this.sessions.get(path);
		if (session === undefined) return;
		this.sessions.delete(path);
		session.stop();
		this.showCursors(session);
		this.emitStatus();
		if (message !== null) this.plugin.notify(message);
	}

	/** The reference a live note is connected to (to notice relinking). */
	reference(path: string): HedgeDocReference | null {
		return this.sessions.get(path)?.reference ?? null;
	}

	private editorsFor(path: string): EditorPort[] {
		return this.viewsFor(path).map(portFor);
	}

	private viewsFor(path: string): EditorView[] {
		const views: EditorView[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf: WorkspaceLeaf) => {
			const view = leaf.view;
			if (view instanceof MarkdownView && view.file?.path === path) {
				const cm = editorView(view);
				if (cm !== null) views.push(cm);
			}
		});
		return views;
	}

	/** Draw a session's remote cursors in every editor of its note (none once stopped). */
	private showCursors(session: LiveSession): void {
		const cursors = session.remoteCursors();
		for (const cm of this.viewsFor(session.path)) {
			const text = cm.state.doc.toString();
			const parts = splitMarkdownContent(text);
			const offset = parts.frontmatterBlock?.length ?? 0;
			const marks: CursorMark[] = cursors.map((remote) => ({
				id: remote.id,
				name: remote.name,
				color: remote.color,
				pos: offset + indexFromCursor(parts.body, remote.cursor),
			}));
			cm.dispatch({effects: setRemoteCursors.of(marks)});
		}
	}

	private onEditorUpdate(update: ViewUpdate): void {
		if (this.sessions.size === 0) return;
		const file = update.state.field(editorInfoField, false)?.file;
		if (file === null || file === undefined) return;
		const session = this.sessions.get(file.path);
		if (session === undefined) return;
		if (update.docChanged && !update.transactions.some((tr) => tr.annotation(remoteEdit) === true)) {
			const changes: EditorChange[] = [];
			update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
				changes.push({from: fromA, to: toA, insert: inserted.toString()});
			});
			session.onEditorChange(update.startState.doc.toString(), update.state.doc.toString(), changes);
		}
		// Share where the cursor is while this editor has focus (after the edit, so
		// the position refers to the text others now have).
		if (update.focusChanged || update.selectionSet || (update.docChanged && update.view.hasFocus)) {
			if (update.view.hasFocus) {
				session.setLocalCursor(update.state.doc.toString(), update.state.selection.main.head);
			} else if (!this.viewsFor(file.path).some((cm) => cm.hasFocus)) {
				// Focus may have moved to another pane of the same note.
				session.setLocalCursor(update.state.doc.toString(), null);
			}
		}
	}

	private onModify(file: TAbstractFile): void {
		const session = this.sessions.get(file.path);
		if (session === undefined || !(file instanceof TFile)) return;
		if (this.editorsFor(file.path).length > 0) return;
		void this.plugin.app.vault.read(file).then((text) => {
			if (this.sessions.get(file.path) === session) session.onFileChanged(text);
		});
	}

	private onRename(file: TAbstractFile, oldPath: string): void {
		const session = this.sessions.get(oldPath);
		if (session === undefined) return;
		this.sessions.delete(oldPath);
		session.path = file.path;
		this.sessions.set(file.path, session);
		this.emitStatus();
	}

	private onLayoutChange(): void {
		const open = new Set<string>();
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.file !== null) open.add(leaf.view.file.path);
		});
		const opened = [...open].filter((path) => !this.openPaths.has(path));
		const closed = [...this.openPaths].filter((path) => !open.has(path));
		this.openPaths = open;

		for (const path of opened) {
			const session = this.sessions.get(path);
			if (session !== undefined) {
				for (const editor of this.editorsFor(path)) session.syncEditor(editor);
				this.showCursors(session);
			} else if (this.plugin.settings.liveSyncAutoStart) {
				const file = this.plugin.app.vault.getAbstractFileByPath(path);
				if (file instanceof TFile) void this.plugin.autoStartLiveSync(file);
			}
		}
		if (this.plugin.settings.liveSyncAutoStart) {
			for (const path of closed) {
				if (this.sessions.has(path)) this.stop(path, null);
			}
		}
	}
}
