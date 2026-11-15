/**
 * Commands, context menus and automatic push: everything the user triggers
 * on a single note or the whole vault. Live sync itself lives in live/.
 */

import {Menu, normalizePath, Notice, TAbstractFile, TFile} from "obsidian";
import {buildNoteUrl, parseNoteUrl} from "hedgesync/obsidian";
import {HedgeDocReferenceError, resolveHedgeDocReference} from "./frontmatter";
import type {HedgeDocService} from "./hedgedoc-service";
import type {LiveSyncManager} from "./live/manager";
import type ObsidianHedgeSyncPlugin from "./main";
import {mergeMarkdownContent, splitMarkdownContent} from "./markdown";
import type {HedgeDocReference, MarkdownParts} from "./types";
import {requestConfirmation} from "./ui/confirmation-modal";
import {requestHedgeDocImport} from "./ui/import-modal";
import {choosePermission} from "./ui/permission-modal";

type SyncSource = "manual" | "auto" | "bulk";
type PullOutcome = "changed" | "unchanged" | "cancelled" | "failed";

interface SyncContext {
	parts: MarkdownParts;
	reference: HedgeDocReference;
}

const BULK_CONCURRENCY = 4;

export class SyncManager {
	private readonly pushTimers = new Map<string, number>();
	private readonly activePushes = new Set<string>();
	/** Body of each note as last pushed or pulled, so our own writes do not trigger a push. */
	private readonly lastSynced = new Map<string, string>();
	private bulkPullInProgress = false;

	constructor(
		private readonly plugin: ObsidianHedgeSyncPlugin,
		private readonly service: HedgeDocService,
		private readonly live: LiveSyncManager,
	) {}

	register(): void {
		this.registerCommands();
		this.registerContextMenus();
		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => this.onModify(file)));
		this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => {
			const body = this.lastSynced.get(oldPath);
			this.lastSynced.delete(oldPath);
			if (body !== undefined) this.lastSynced.set(file.path, body);
		}));
	}

	dispose(): void {
		for (const timerId of this.pushTimers.values()) window.clearTimeout(timerId);
		this.pushTimers.clear();
		this.activePushes.clear();
	}

	// ------------------------------------------------------------------
	// Registration
	// ------------------------------------------------------------------

	private registerCommands(): void {
		const forActiveNote = (id: string, name: string, run: (file: TFile) => Promise<unknown>) => {
			this.plugin.addCommand({
				id,
				name,
				checkCallback: (checking) => {
					const file = this.activeMarkdownFile();
					if (file === null) return false;
					if (!checking) void run(file);
					return true;
				},
			});
		};

		forActiveNote("sync-active-note-to-hedgedoc", "Sync active note to hedgedoc", (file) => this.push(file, "manual"));
		forActiveNote("sync-active-note-from-hedgedoc", "Sync active note from hedgedoc", (file) => this.pull(file, "manual"));
		forActiveNote("open-linked-hedgedoc-document", "Open linked hedgedoc document", (file) => this.openLinked(file));
		forActiveNote("toggle-live-sync-for-active-note", "Toggle live sync for active note", (file) => this.toggleLive(file));
		forActiveNote("create-hedgedoc-document-from-active-note", "Create hedgedoc document from active note", (file) => this.createDocument(file));
		forActiveNote("copy-published-link", "Copy published link of active note", (file) => this.copyLink(file, "publish"));
		forActiveNote("copy-slide-link", "Copy slide link of active note", (file) => this.copyLink(file, "slide"));
		forActiveNote("open-published-page", "Open published page of active note", (file) => this.openPublished(file));
		forActiveNote("set-hedgedoc-permission", "Change who can view and edit the linked hedgedoc note", (file) => this.changePermission(file));

		this.plugin.addCommand({
			id: "pull-all-linked-notes-from-hedgedoc",
			name: "Pull all linked notes from hedgedoc",
			callback: () => void this.pullAll(),
		});
		this.plugin.addCommand({
			id: "create-note-from-hedgedoc-document",
			name: "Create note from hedgedoc document",
			callback: () => void this.importDocument(),
		});
		this.plugin.addCommand({
			id: "log-in-to-hedgedoc",
			name: "Log in to hedgedoc",
			callback: () => void this.logInForActiveNote(),
		});
	}

	private registerContextMenus(): void {
		this.plugin.registerEvent(this.plugin.app.workspace.on("file-menu", (menu, file) => {
			if (isMarkdownFile(file)) this.addContextMenuItems(menu, file);
		}));
		this.plugin.registerEvent(this.plugin.app.workspace.on("editor-menu", (menu, _editor, info) => {
			if (isMarkdownFile(info.file)) this.addContextMenuItems(menu, info.file);
		}));
	}

	private addContextMenuItems(menu: Menu, file: TFile): void {
		if (!this.isLinked(file)) {
			menu.addItem((item) => item
				.setTitle("Create hedgedoc document from this note")
				.setIcon("plus-circle")
				.onClick(() => void this.createDocument(file)));
			return;
		}
		const live = this.live.isLive(file.path);
		if (!live) {
			menu.addItem((item) => item.setTitle("Push to hedgedoc").setIcon("upload").onClick(() => void this.push(file, "manual")));
			menu.addItem((item) => item.setTitle("Pull from hedgedoc").setIcon("download").onClick(() => void this.pull(file, "manual")));
		}
		menu.addItem((item) => item
			.setTitle(live ? "Stop live sync" : "Start live sync")
			.setIcon("radio")
			.onClick(() => void this.toggleLive(file)));
		menu.addItem((item) => item.setTitle("Open linked hedgedoc document").setIcon("external-link").onClick(() => void this.openLinked(file)));
		menu.addItem((item) => item.setTitle("Copy published link").setIcon("link").onClick(() => void this.copyLink(file, "publish")));
	}

	// ------------------------------------------------------------------
	// Push and pull
	// ------------------------------------------------------------------

	private onModify(file: TAbstractFile): void {
		if (!this.plugin.settings.autoPushOnSave || !isMarkdownFile(file) || this.live.isLive(file.path)) return;
		if (!this.isLinked(file)) return;
		const existing = this.pushTimers.get(file.path);
		if (existing !== undefined) window.clearTimeout(existing);
		this.pushTimers.set(file.path, window.setTimeout(() => {
			this.pushTimers.delete(file.path);
			void this.push(file, "auto");
		}, this.plugin.settings.autoPushDebounceMs));
	}

	async push(file: TFile, source: SyncSource): Promise<boolean> {
		if (this.live.isLive(file.path)) {
			if (source === "manual") new Notice(`"${file.basename}" is in live sync: changes are sent as you type.`);
			return false;
		}
		if (this.activePushes.has(file.path)) {
			if (source === "manual") new Notice(`A sync is already running for "${file.basename}".`);
			return false;
		}
		this.activePushes.add(file.path);
		try {
			const context = await this.context(file);
			const body = context.parts.body;
			if (source === "auto" && this.lastSynced.get(file.path) === body) return false;
			const confirm = source === "manual" && this.plugin.settings.warnBeforeOverwrite
				? () => requestConfirmation(this.plugin.app, {
					title: "Overwrite remote content?",
					message: `The hedgedoc note linked to "${file.basename}" has different content. Pushing replaces it with your local text.`,
					confirmText: "Overwrite remote",
					cancelText: "Cancel",
				})
				: undefined;
			const outcome = await this.service.push(context.reference, body, confirm);
			if (outcome !== "cancelled") this.lastSynced.set(file.path, body);
			if (source === "manual") {
				new Notice(outcome === "changed" ? `Pushed "${file.basename}" to hedgedoc.`
					: outcome === "unchanged" ? `"${file.basename}" is already in sync with hedgedoc.`
						: `Push cancelled for "${file.basename}".`);
			}
			return outcome === "changed";
		} catch (error) {
			this.reportError(error, file, source);
			return false;
		} finally {
			this.activePushes.delete(file.path);
		}
	}

	async pull(file: TFile, source: SyncSource, given?: SyncContext): Promise<PullOutcome> {
		if (this.live.isLive(file.path)) {
			if (source === "manual") new Notice(`"${file.basename}" is in live sync: remote changes arrive as they happen.`);
			return "unchanged";
		}
		try {
			const context = given ?? await this.context(file);
			// Bulk pulls read what the server saved; manual pulls the live document.
			const remote = source === "bulk"
				? await this.service.download(context.reference)
				: await this.service.pull(context.reference);

			if (remote === context.parts.body) {
				this.lastSynced.set(file.path, remote);
				if (source === "manual") new Notice(`"${file.basename}" is already up to date.`);
				return "unchanged";
			}
			if (source === "manual" && this.plugin.settings.warnBeforeOverwrite) {
				const confirmed = await requestConfirmation(this.plugin.app, {
					title: "Overwrite local content?",
					message: `Pulling replaces the text of "${file.basename}" (except its frontmatter) with the hedgedoc note.`,
					confirmText: "Overwrite local",
					cancelText: "Cancel",
				});
				if (!confirmed) {
					new Notice(`Pull cancelled for "${file.basename}".`);
					return "cancelled";
				}
			}
			this.lastSynced.set(file.path, remote);
			await this.plugin.app.vault.process(file, (current) => {
				const parts = splitMarkdownContent(current);
				return parts.body === remote ? current : mergeMarkdownContent(parts, remote);
			});
			if (source === "manual") new Notice(`Pulled "${file.basename}" from hedgedoc.`);
			return "changed";
		} catch (error) {
			this.reportError(error, file, source);
			return "failed";
		}
	}

	private async pullAll(): Promise<void> {
		if (this.bulkPullInProgress) {
			new Notice("A vault pull is already running.");
			return;
		}
		this.bulkPullInProgress = true;
		const linked = this.plugin.app.vault.getMarkdownFiles().filter((file) => this.isLinked(file));
		const counts = {changed: 0, unchanged: 0, failed: 0};
		const progress = new Notice(`Pulling ${linked.length} linked notes from hedgedoc...`, 0);
		try {
			let next = 0;
			const worker = async () => {
				while (next < linked.length) {
					const file = linked[next++];
					if (file === undefined) break;
					const outcome = await this.pull(file, "bulk");
					if (outcome === "changed") counts.changed++;
					else if (outcome === "failed") counts.failed++;
					else counts.unchanged++;
				}
			};
			await Promise.all(Array.from({length: BULK_CONCURRENCY}, worker));
		} finally {
			this.bulkPullInProgress = false;
			progress.hide();
		}
		new Notice(`Vault pull complete: ${counts.changed} updated, ${counts.unchanged} unchanged, ${counts.failed} failed${counts.failed > 0 ? " (see the developer console)" : ""}.`);
	}

	// ------------------------------------------------------------------
	// Live sync
	// ------------------------------------------------------------------

	async toggleLive(file: TFile): Promise<void> {
		if (this.live.isLive(file.path)) {
			this.live.stop(file.path, `Live sync stopped for "${file.basename}".`);
			return;
		}
		await this.startLive(file, false);
	}

	async startLive(file: TFile, automatic: boolean): Promise<void> {
		try {
			const context = await this.context(file);
			await this.live.start(file, context.reference, async () => {
				if (!this.plugin.settings.warnBeforeOverwrite) return "remote";
				const useLocal = await requestConfirmation(this.plugin.app, {
					title: "Local and remote text differ",
					message: `"${file.basename}" and its hedgedoc note have different text. Which should live sync start from? The other version is replaced.`,
					confirmText: "Use local text",
					cancelText: "Use hedgedoc text",
				});
				return useLocal ? "local" : "remote";
			});
			if (!automatic) new Notice(`Live sync started for "${file.basename}".`);
		} catch (error) {
			if (automatic && isMissingLinkError(error)) return;
			this.reportError(error, file, "manual");
		}
	}

	// ------------------------------------------------------------------
	// Links, permission, creation
	// ------------------------------------------------------------------

	private async openLinked(file: TFile): Promise<void> {
		try {
			window.open((await this.context(file)).reference.url, "_blank");
		} catch (error) {
			this.reportError(error, file, "manual");
		}
	}

	private async copyLink(file: TFile, kind: "publish" | "slide"): Promise<void> {
		try {
			const links = await this.service.links((await this.context(file)).reference);
			await navigator.clipboard.writeText(links[kind]);
			new Notice(`Copied ${kind === "publish" ? "published" : "slide"} link: ${links[kind]}`);
		} catch (error) {
			this.reportError(error, file, "manual");
		}
	}

	private async openPublished(file: TFile): Promise<void> {
		try {
			const links = await this.service.links((await this.context(file)).reference);
			window.open(links.publish, "_blank");
		} catch (error) {
			this.reportError(error, file, "manual");
		}
	}

	private async changePermission(file: TFile): Promise<void> {
		try {
			const {reference} = await this.context(file);
			if (this.service.cookieFor(reference.serverUrl) === undefined) {
				new Notice("Only the note's owner can change its permission. Log in first (command: Log in to hedgedoc).");
				return;
			}
			const info = await this.service.noteInfo(reference);
			const permission = await choosePermission(this.plugin.app, info.permission);
			if (permission === null || permission === info.permission) return;
			await this.service.setPermission(reference, permission);
			new Notice(`Permission of "${file.basename}" is now "${permission}".`);
		} catch (error) {
			this.reportError(error, file, "manual");
		}
	}

	private async createDocument(file: TFile): Promise<void> {
		if (this.isLinked(file)) {
			new Notice(`"${file.basename}" is already linked to a hedgedoc document.`);
			return;
		}
		const serverUrl = this.plugin.settings.defaultServerUrl;
		if (serverUrl.length === 0) {
			new Notice("Set a default hedgedoc server URL in the plugin settings first.");
			return;
		}
		try {
			const body = splitMarkdownContent(await this.plugin.app.vault.read(file)).body;
			const reference = await this.service.createNote(serverUrl, body);
			await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter[this.plugin.settings.frontmatterLinkProperty] = reference.url;
			});
			this.lastSynced.set(file.path, body);
			new Notice(`Created and linked a hedgedoc document for "${file.basename}".`);
		} catch (error) {
			this.reportError(error, file, "manual");
		}
	}

	private async importDocument(): Promise<void> {
		const app = this.plugin.app;
		const parent = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
		const folderPrefix = parent.isRoot() ? "" : `${parent.path}/`;
		const input = await requestHedgeDocImport(app, {defaultFilePath: `${folderPrefix}HedgeDoc import.md`});
		if (input === null) return;

		try {
			const reference = this.referenceFromInput(input.referenceInput);
			const body = await this.service.pull(reference);
			const path = this.availablePath(input.targetPath.length > 0 ? input.targetPath : `${folderPrefix}${reference.noteId}.md`);
			const key = this.plugin.settings.frontmatterLinkProperty;
			// The body must be exactly the remote text, or the note starts out of sync.
			const file = await app.vault.create(path, `---\n${key}: ${JSON.stringify(reference.url)}\n---\n${body}`);
			this.lastSynced.set(file.path, body);
			await app.workspace.getLeaf(true).openFile(file);
			new Notice(`Created "${file.basename}" from hedgedoc.`);
		} catch (error) {
			console.error("[hedgesync] import failed", error);
			new Notice(`Could not create a note from hedgedoc: ${errorMessage(error)}`);
		}
	}

	private referenceFromInput(input: string): HedgeDocReference {
		const trimmed = input.trim();
		if (trimmed.length === 0) throw new Error("Enter a hedgedoc URL or note ID.");
		if (/^https?:\/\//i.test(trimmed)) {
			const parsed = parseNoteUrl(trimmed);
			return {serverUrl: parsed.serverUrl, noteId: parsed.noteId, url: buildNoteUrl(parsed.serverUrl, parsed.noteId)};
		}
		const serverUrl = this.plugin.settings.defaultServerUrl.replace(/\/+$/, "");
		if (serverUrl.length === 0) throw new Error("Set a default hedgedoc server URL to import by note ID.");
		const noteId = trimmed.replace(/^\/+|\/+$/g, "");
		if (noteId.length === 0) throw new Error("The note ID is empty.");
		return {serverUrl, noteId, url: buildNoteUrl(serverUrl, noteId)};
	}

	private availablePath(input: string): string {
		const name = input.trim() || "Untitled";
		const basePath = normalizePath(name.toLowerCase().endsWith(".md") ? name : `${name}.md`);
		if (basePath.length === 0 || basePath === "." || basePath.startsWith("../")) {
			throw new Error("The note path must be inside the vault.");
		}
		let candidate = basePath;
		for (let suffix = 1; this.plugin.app.vault.getAbstractFileByPath(candidate) !== null; suffix++) {
			candidate = normalizePath(basePath.replace(/\.md$/i, ` ${suffix}.md`));
		}
		return candidate;
	}

	private async logInForActiveNote(): Promise<void> {
		const file = this.activeMarkdownFile();
		let serverUrl = this.plugin.settings.defaultServerUrl;
		if (file !== null && this.isLinked(file)) {
			try {
				serverUrl = (await this.context(file)).reference.serverUrl;
			} catch {
				// Fall back to the default server.
			}
		}
		if (serverUrl.length === 0) {
			new Notice("Set a default hedgedoc server URL in the plugin settings first.");
			return;
		}
		await this.plugin.logIn(serverUrl);
	}

	// ------------------------------------------------------------------
	// Helpers
	// ------------------------------------------------------------------

	isLinked(file: TFile): boolean {
		const frontmatter = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		const value = frontmatter?.[this.plugin.settings.frontmatterLinkProperty];
		return value !== undefined && value !== null && value !== "";
	}

	private async context(file: TFile): Promise<SyncContext> {
		const markdown = await this.plugin.app.vault.read(file);
		const reference = resolveHedgeDocReference(markdown, {
			linkProperty: this.plugin.settings.frontmatterLinkProperty,
			defaultServerUrl: this.plugin.settings.defaultServerUrl,
		});
		return {parts: splitMarkdownContent(markdown), reference};
	}

	private activeMarkdownFile(): TFile | null {
		const file = this.plugin.app.workspace.getActiveFile();
		return file !== null && file.extension === "md" ? file : null;
	}

	private reportError(error: unknown, file: TFile, source: SyncSource): void {
		if (source === "auto" && isMissingLinkError(error)) return;
		const message = errorMessage(error);
		console.error(`[hedgesync] ${source} sync failed for "${file.path}": ${message}`, error);
		if (source === "bulk") return;
		new Notice(source === "auto"
			? `Auto push failed for "${file.basename}": ${message}`
			: `Hedgesync: "${file.basename}": ${message}`);
	}
}

function isMarkdownFile(file: TAbstractFile | null): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

function isMissingLinkError(error: unknown): boolean {
	return error instanceof HedgeDocReferenceError
		&& (error.code === "missing-frontmatter" || error.code === "missing-link-property");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
