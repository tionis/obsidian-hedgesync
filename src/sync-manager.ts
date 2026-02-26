import {Editor, Menu, normalizePath, Notice, TAbstractFile, TFile} from "obsidian";
import {buildNoteUrl, HedgeDocClient, parseNoteUrl} from "hedgesync/obsidian";
import {requestConfirmation} from "./confirmation-modal";
import {HedgeDocReferenceError, mergeMarkdownContent, resolveHedgeDocReference, splitMarkdownContent} from "./frontmatter";
import {requestHedgeDocImport} from "./hedgedoc-import-modal";
import {HedgeDocSyncService} from "./hedgedoc-sync-service";
import type ObsidianHedgeSyncPlugin from "./main";
import type {HedgeDocReference} from "./types";

type SyncSource = "manual" | "auto" | "live" | "bulk";
type PullOutcome = "changed" | "unchanged" | "cancelled" | "failed";

interface SyncContext {
	parts: ReturnType<typeof splitMarkdownContent>;
	reference: HedgeDocReference;
}

interface PushOptions {
	showResultNotice: boolean;
	confirmOverwrite: boolean;
}

interface PullOptions {
	showResultNotice: boolean;
	showUpToDateNotice: boolean;
	confirmOverwrite: boolean;
	useDownloadEndpoint: boolean;
	stripRemoteFrontmatter: boolean;
}

interface LiveSyncSession {
	filePath: string;
	reference: HedgeDocReference;
	client: HedgeDocClient;
	localSyncTimerId: number | null;
	writeQueue: Promise<void>;
	onDocument: () => void;
	onError: (error: unknown) => void;
	onDelete: () => void;
}

export class SyncManager {
	private readonly plugin: ObsidianHedgeSyncPlugin;
	private readonly syncService: HedgeDocSyncService;
	private readonly pushTimers = new Map<string, number>();
	private readonly activePushes = new Set<string>();
	private readonly suppressAutoPushUntil = new Map<string, number>();
	private bulkPullInProgress = false;
	private liveSession: LiveSyncSession | null = null;

	constructor(plugin: ObsidianHedgeSyncPlugin, syncService: HedgeDocSyncService) {
		this.plugin = plugin;
		this.syncService = syncService;
	}

	register(): void {
		this.registerCommands();
		this.registerContextMenus();

		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			void this.handleVaultModify(file);
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => {
			this.handleFileRename(file, oldPath);
		}));

		this.plugin.registerEvent(this.plugin.app.vault.on("delete", (file) => {
			this.handleFileDelete(file);
		}));

		this.plugin.register(() => this.dispose());
	}

	dispose(): void {
		for (const timerId of this.pushTimers.values()) {
			window.clearTimeout(timerId);
		}
		this.pushTimers.clear();
		this.activePushes.clear();
		this.suppressAutoPushUntil.clear();
		this.stopLiveSync(null);
	}

	onSettingsChanged(): void {
		const liveSession = this.liveSession;
		if (liveSession === null) {
			return;
		}

		if (liveSession.localSyncTimerId !== null) {
			window.clearTimeout(liveSession.localSyncTimerId);
			liveSession.localSyncTimerId = null;
		}
	}

	private registerCommands(): void {
		this.plugin.addCommand({
			id: "sync-active-note-to-hedgedoc",
			name: "Sync active note to hedgedoc",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (file === null) {
					return false;
				}

				if (!checking) {
					void this.pushFile(file, "manual");
				}

				return true;
			},
		});

		this.plugin.addCommand({
			id: "sync-active-note-from-hedgedoc",
			name: "Sync active note from hedgedoc",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (file === null) {
					return false;
				}

				if (!checking) {
					void this.pullFile(file, "manual");
				}

				return true;
			},
		});

		this.plugin.addCommand({
			id: "open-linked-hedgedoc-document",
			name: "Open linked hedgedoc document",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (file === null) {
					return false;
				}

				if (!checking) {
					void this.openLinkedDocument(file);
				}

				return true;
			},
		});

		this.plugin.addCommand({
			id: "toggle-live-sync-for-active-note",
			name: "Toggle live sync for active note",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (file === null) {
					return false;
				}

				if (!checking) {
					void this.toggleLiveSyncForFile(file);
				}

				return true;
			},
		});

		this.plugin.addCommand({
			id: "pull-all-linked-notes-from-hedgedoc",
			name: "Pull all linked notes from hedgedoc",
			callback: () => {
				void this.pullAllLinkedNotesFromVault();
			},
		});

		this.plugin.addCommand({
			id: "create-hedgedoc-document-from-active-note",
			name: "Create hedgedoc document from active note",
			checkCallback: (checking) => {
				const file = this.getActiveMarkdownFile();
				if (file === null) {
					return false;
				}

				if (!checking) {
					void this.createHedgeDocDocumentFromFile(file);
				}

				return true;
			},
		});

		this.plugin.addCommand({
			id: "create-note-from-hedgedoc-document",
			name: "Create note from hedgedoc document",
			callback: () => {
				void this.createNoteFromHedgeDocDocument();
			},
		});
	}

	private registerContextMenus(): void {
		this.plugin.registerEvent(this.plugin.app.workspace.on("file-menu", (menu, file) => {
			if (isMarkdownFile(file)) {
				this.addContextMenuItems(menu, file);
			}
		}));

		this.plugin.registerEvent(this.plugin.app.workspace.on("editor-menu", (menu, _editor: Editor, info) => {
			if (isMarkdownFile(info.file)) {
				this.addContextMenuItems(menu, info.file);
			}
		}));
	}

	private addContextMenuItems(menu: Menu, file: TFile): void {
		const isLinked = this.hasLinkInFrontmatterCache(file);

		if (isLinked) {
			menu.addItem((item) => item
				.setTitle("Push to hedgedoc")
				.setIcon("upload")
				.onClick(() => {
					void this.pushFile(file, "manual");
				}));
			menu.addItem((item) => item
				.setTitle("Pull from hedgedoc")
				.setIcon("download")
				.onClick(() => {
					void this.pullFile(file, "manual");
				}));
			menu.addItem((item) => item
				.setTitle(this.liveSession?.filePath === file.path ? "Stop live sync" : "Start live sync")
				.setIcon("refresh-cw")
				.onClick(() => {
					void this.toggleLiveSyncForFile(file);
				}));
			menu.addItem((item) => item
				.setTitle("Open linked hedgedoc document")
				.setIcon("external-link")
				.onClick(() => {
					void this.openLinkedDocument(file);
				}));
		} else {
			menu.addItem((item) => item
				.setTitle("Create hedgedoc document from this note")
				.setIcon("plus-circle")
				.onClick(() => {
					void this.createHedgeDocDocumentFromFile(file);
				}));
		}
	}

	private async handleVaultModify(file: TAbstractFile): Promise<void> {
		if (!isMarkdownFile(file)) {
			return;
		}

		if (this.isAutoPushSuppressed(file.path)) {
			return;
		}

		if (this.liveSession?.filePath === file.path) {
			this.scheduleLiveLocalSync();
			return;
		}

		if (!this.plugin.settings.autoPushOnSave) {
			return;
		}

		this.schedulePush(file, "auto", this.plugin.settings.autoPushDebounceMs);
	}

	private handleFileRename(file: TAbstractFile, oldPath: string): void {
		if (!isMarkdownFile(file)) {
			return;
		}

		const liveSession = this.liveSession;
		if (liveSession !== null && liveSession.filePath === oldPath) {
			liveSession.filePath = file.path;
		}
	}

	private handleFileDelete(file: TAbstractFile): void {
		const liveSession = this.liveSession;
		if (liveSession !== null && liveSession.filePath === file.path) {
			this.stopLiveSync("Live sync stopped because the note was deleted.");
		}
	}

	private schedulePush(file: TFile, source: SyncSource, debounceMs: number): void {
		const existingTimer = this.pushTimers.get(file.path);
		if (existingTimer !== undefined) {
			window.clearTimeout(existingTimer);
		}

		const timerId = window.setTimeout(() => {
			this.pushTimers.delete(file.path);
			void this.pushFile(file, source);
		}, debounceMs);

		this.pushTimers.set(file.path, timerId);
	}

	private async pushFile(
		file: TFile,
		source: SyncSource,
		options: Partial<PushOptions> = {},
	): Promise<boolean> {
		if (this.liveSession?.filePath === file.path) {
			return this.pushWithLiveSession(file, source, options);
		}

		if (this.activePushes.has(file.path)) {
			if (source === "manual") {
				new Notice(`Sync already running for "${file.basename}".`);
			}
			return false;
		}

		this.activePushes.add(file.path);
		const resolvedOptions = resolvePushOptions(source, this.plugin.settings.warnBeforeOverwrite, options);

		try {
			const context = await this.buildSyncContext(file);

			if (resolvedOptions.confirmOverwrite) {
				const remoteBody = await this.syncService.pull(context.reference);
				if (remoteBody !== context.parts.body) {
					const confirmed = await requestConfirmation(this.plugin.app, {
						title: "Overwrite remote content?",
						message: `The remote hedgedoc note for "${file.basename}" has different content. Pushing now will overwrite the remote body with your local body.`,
						confirmText: "Overwrite remote",
						cancelText: "Cancel",
					});

					if (!confirmed) {
						new Notice(`Push cancelled for "${file.basename}".`);
						return false;
					}
				}
			}

			const result = await this.syncService.push(context.reference, context.parts.body);
			if (resolvedOptions.showResultNotice) {
				new Notice(result.changed
					? `Synced "${file.basename}" to hedgedoc.`
					: `"${file.basename}" is already in sync with hedgedoc.`);
			}

			return result.changed;
		} catch (error) {
			this.handleSyncError(error, file, source);
			return false;
		} finally {
			this.activePushes.delete(file.path);
		}
	}

	private async pushWithLiveSession(
		file: TFile,
		source: SyncSource,
		options: Partial<PushOptions>,
	): Promise<boolean> {
		const liveSession = this.liveSession;
		if (liveSession === null || liveSession.filePath !== file.path) {
			return false;
		}

		const resolvedOptions = resolvePushOptions(source, this.plugin.settings.warnBeforeOverwrite, options);

		try {
			const context = await this.buildSyncContext(file);
			if (context.reference.url !== liveSession.reference.url) {
				this.stopLiveSync(`Live sync stopped for "${file.basename}" because its linked hedgedoc note changed.`);
				return false;
			}

			if (resolvedOptions.confirmOverwrite && liveSession.client.getDocument() !== context.parts.body) {
				const confirmed = await requestConfirmation(this.plugin.app, {
					title: "Overwrite remote content?",
					message: `The remote hedgedoc note for "${file.basename}" has different content. Pushing now will overwrite the remote body with your local body.`,
					confirmText: "Overwrite remote",
					cancelText: "Cancel",
				});

				if (!confirmed) {
					new Notice(`Push cancelled for "${file.basename}".`);
					return false;
				}
			}

			const operationCount = liveSession.client.updateContent(context.parts.body);
			if (resolvedOptions.showResultNotice) {
				new Notice(operationCount > 0
					? `Synced "${file.basename}" to hedgedoc.`
					: `"${file.basename}" is already in sync with hedgedoc.`);
			}

			return operationCount > 0;
		} catch (error) {
			this.handleSyncError(error, file, source);
			return false;
		}
	}

	private async pullFile(
		file: TFile,
		source: SyncSource,
		options: Partial<PullOptions> = {},
		context?: SyncContext,
	): Promise<PullOutcome> {
		const resolvedOptions = resolvePullOptions(source, this.plugin.settings.warnBeforeOverwrite, options);

		try {
			const syncContext = context ?? await this.buildSyncContext(file);
			let remoteContent: string;

			if (this.liveSession?.filePath === file.path && !resolvedOptions.useDownloadEndpoint) {
				remoteContent = this.liveSession.client.getDocument();
			} else {
				remoteContent = resolvedOptions.useDownloadEndpoint
					? await this.syncService.download(syncContext.reference)
					: await this.syncService.pull(syncContext.reference);
			}

			const remoteBody = resolvedOptions.stripRemoteFrontmatter
				? splitMarkdownContent(remoteContent).body
				: remoteContent;

			if (remoteBody === syncContext.parts.body) {
				if (resolvedOptions.showUpToDateNotice) {
					new Notice(`"${file.basename}" is already up to date.`);
				}
				return "unchanged";
			}

			if (resolvedOptions.confirmOverwrite) {
				const confirmed = await requestConfirmation(this.plugin.app, {
					title: "Overwrite local content?",
					message: `Pulling now will replace the local body of "${file.basename}" with the remote hedgedoc body.`,
					confirmText: "Overwrite local",
					cancelText: "Cancel",
				});

				if (!confirmed) {
					new Notice(`Pull cancelled for "${file.basename}".`);
					return "cancelled";
				}
			}

				this.markAutoPushSuppressed(file.path);
				const changed = await this.replaceFileBodyPreservingFrontmatter(file, remoteBody);
				if (!changed) {
					if (resolvedOptions.showUpToDateNotice) {
						new Notice(`"${file.basename}" is already up to date.`);
					}
					return "unchanged";
				}

			if (resolvedOptions.showResultNotice) {
				new Notice(`Pulled changes from hedgedoc into "${file.basename}".`);
			}

			return "changed";
		} catch (error) {
			this.handleSyncError(error, file, source);
			return "failed";
		}
	}

	private async openLinkedDocument(file: TFile): Promise<void> {
		try {
			const context = await this.buildSyncContext(file);
			window.open(context.reference.url, "_blank");
		} catch (error) {
			this.handleSyncError(error, file, "manual");
		}
	}

	private async toggleLiveSyncForFile(file: TFile): Promise<void> {
		if (this.liveSession?.filePath === file.path) {
			this.stopLiveSync(`Live sync disabled for "${file.basename}".`);
			return;
		}

		try {
			await this.startLiveSync(file);
			new Notice(`Live sync enabled for "${file.basename}".`);
		} catch (error) {
			this.handleSyncError(error, file, "manual");
		}
	}

	private async startLiveSync(file: TFile): Promise<void> {
		this.stopLiveSync(null);

		const context = await this.buildSyncContext(file);
		const client = await this.syncService.connectLiveClient(context.reference);

		const liveSession: LiveSyncSession = {
			filePath: file.path,
			reference: context.reference,
			client,
			localSyncTimerId: null,
			writeQueue: Promise.resolve(),
			onDocument: () => {
				void this.applyLiveDocumentToFile();
			},
			onError: (error) => {
				console.error("[hedgesync] live sync client error", error);
			},
			onDelete: () => {
				this.stopLiveSync("Live sync stopped because the remote hedgedoc note was deleted.");
			},
		};

		client.on("document", liveSession.onDocument);
		client.on("error", liveSession.onError);
		client.on("delete", liveSession.onDelete);

		this.liveSession = liveSession;
		await this.reconcileLiveSessionStart(file, context.parts.body);
	}

	private async reconcileLiveSessionStart(file: TFile, localBody: string): Promise<void> {
		const liveSession = this.liveSession;
		if (liveSession === null) {
			return;
		}

		const remoteBody = liveSession.client.getDocument();
		if (remoteBody === localBody) {
			return;
		}

		if (this.plugin.settings.warnBeforeOverwrite) {
			const useLocal = await requestConfirmation(this.plugin.app, {
				title: "Resolve live sync content mismatch",
				message: `Local and remote content differ for "${file.basename}". Use your local content as the live sync baseline?`,
				confirmText: "Use local content",
				cancelText: "Use remote content",
			});

			if (useLocal) {
				liveSession.client.updateContent(localBody);
				return;
			}
		}

		await this.applyLiveBodyToFile(remoteBody);
	}

	private scheduleLiveLocalSync(): void {
		const liveSession = this.liveSession;
		if (liveSession === null) {
			return;
		}

		if (liveSession.localSyncTimerId !== null) {
			window.clearTimeout(liveSession.localSyncTimerId);
		}

		liveSession.localSyncTimerId = window.setTimeout(() => {
			liveSession.localSyncTimerId = null;
			void this.syncLocalToLiveSession();
		}, this.plugin.settings.liveSyncPushDebounceMs);
	}

	private async syncLocalToLiveSession(): Promise<void> {
		const liveSession = this.liveSession;
		if (liveSession === null) {
			return;
		}

		const liveFile = this.plugin.app.vault.getAbstractFileByPath(liveSession.filePath);
		if (!isMarkdownFile(liveFile)) {
			this.stopLiveSync("Live sync stopped because the note is no longer available.");
			return;
		}

		try {
			const context = await this.buildSyncContext(liveFile);
			if (context.reference.url !== liveSession.reference.url) {
				this.stopLiveSync(`Live sync stopped for "${liveFile.basename}" because its linked hedgedoc note changed.`);
				return;
			}

			if (context.parts.body !== liveSession.client.getDocument()) {
				liveSession.client.updateContent(context.parts.body);
			}
		} catch (error) {
			this.handleSyncError(error, liveFile, "live");
		}
	}

	private async applyLiveDocumentToFile(): Promise<void> {
		const liveSession = this.liveSession;
		if (liveSession === null) {
			return;
		}

		const remoteBody = liveSession.client.getDocument();
		await this.enqueueLiveWrite(async () => {
			await this.applyLiveBodyToFile(remoteBody);
		});
	}

	private async applyLiveBodyToFile(remoteBody: string): Promise<void> {
		const liveSession = this.liveSession;
		if (liveSession === null) {
			return;
		}

		const liveFile = this.plugin.app.vault.getAbstractFileByPath(liveSession.filePath);
		if (!isMarkdownFile(liveFile)) {
			this.stopLiveSync("Live sync stopped because the note is no longer available.");
			return;
		}

		this.markAutoPushSuppressed(liveFile.path);
		await this.replaceFileBodyPreservingFrontmatter(liveFile, remoteBody);
	}

	private async enqueueLiveWrite(task: () => Promise<void>): Promise<void> {
		const liveSession = this.liveSession;
		if (liveSession === null) {
			return;
		}

		liveSession.writeQueue = liveSession.writeQueue
			.catch(() => undefined)
			.then(task);

		await liveSession.writeQueue;
	}

	private stopLiveSync(message: string | null): void {
		const liveSession = this.liveSession;
		if (liveSession === null) {
			return;
		}

		this.liveSession = null;

		if (liveSession.localSyncTimerId !== null) {
			window.clearTimeout(liveSession.localSyncTimerId);
		}

		liveSession.client.off("document", liveSession.onDocument);
		liveSession.client.off("error", liveSession.onError);
		liveSession.client.off("delete", liveSession.onDelete);
		liveSession.client.disconnect();

		if (message !== null) {
			new Notice(message);
		}
	}

	private async pullAllLinkedNotesFromVault(): Promise<void> {
		if (this.bulkPullInProgress) {
			new Notice("Vault pull is already running.");
			return;
		}

		this.bulkPullInProgress = true;
		const files = this.plugin.app.vault.getMarkdownFiles();
		let changedCount = 0;
		let unchangedCount = 0;
		let skippedCount = 0;
		let failedCount = 0;

		new Notice(`Starting hedgedoc pull for ${files.length} markdown files...`);

		try {
			for (const file of files) {
				let context: SyncContext;
				try {
					context = await this.buildSyncContext(file);
				} catch (error) {
					if (isMissingLinkError(error)) {
						skippedCount++;
						continue;
					}

					failedCount++;
					logSyncError(error, file, "bulk", toErrorMessage(error));
					continue;
				}

				const outcome = await this.pullFile(file, "bulk", {
					showResultNotice: false,
					showUpToDateNotice: false,
					confirmOverwrite: false,
					useDownloadEndpoint: true,
					stripRemoteFrontmatter: true,
				}, context);

				if (outcome === "changed") {
					changedCount++;
				} else if (outcome === "unchanged") {
					unchangedCount++;
				} else if (outcome === "failed") {
					failedCount++;
				}
			}
		} finally {
			this.bulkPullInProgress = false;
		}

		new Notice(
			`Vault pull complete: ${changedCount} updated, ${unchangedCount} unchanged, ${skippedCount} unlinked, ${failedCount} failed.`,
		);
	}

	private async createHedgeDocDocumentFromFile(file: TFile): Promise<void> {
		try {
			await this.buildSyncContext(file);
			new Notice(`"${file.basename}" already has a linked hedgedoc document.`);
			return;
		} catch (error) {
			if (!isMissingLinkError(error)) {
				this.handleSyncError(error, file, "manual");
				return;
			}
		}

		const defaultServerUrl = this.plugin.settings.defaultServerUrl.trim();
		if (defaultServerUrl.length === 0) {
			new Notice("Set a default hedgedoc server URL before creating linked documents.");
			return;
		}

			try {
				const markdown = await this.plugin.app.vault.cachedRead(file);
				const parts = splitMarkdownContent(markdown);
				const reference = await this.syncService.createNote(defaultServerUrl, parts.body);

				await this.plugin.app.fileManager.processFrontMatter(file, (frontmatter) => {
					const frontmatterRecord = frontmatter as Record<string, unknown>;
					frontmatterRecord[this.plugin.settings.frontmatterLinkProperty] = reference.url;
				});

			new Notice(`Created and linked hedgedoc document for "${file.basename}".`);
		} catch (error) {
			this.handleSyncError(error, file, "manual");
		}
	}

	private async createNoteFromHedgeDocDocument(): Promise<void> {
		const input = await requestHedgeDocImport(this.plugin.app, {
			defaultFilePath: "HedgeDoc import.md",
		});
		if (input === null) {
			return;
		}

		let reference: HedgeDocReference;
		try {
			reference = this.resolveReferenceInput(input.referenceInput);
		} catch (error) {
			new Notice(toErrorMessage(error));
			return;
		}

		try {
			const remoteBody = await this.syncService.download(reference);
			const targetPath = this.resolveAvailableMarkdownPath(
				input.targetPath.length > 0 ? input.targetPath : `${reference.noteId}.md`,
			);
			const frontmatterKey = this.plugin.settings.frontmatterLinkProperty;
			const frontmatterValue = reference.url.replace(/"/g, '\\"');
			const content = `---\n${frontmatterKey}: "${frontmatterValue}"\n---\n\n${remoteBody}`;

			const file = await this.plugin.app.vault.create(targetPath, content);
			await this.plugin.app.workspace.getLeaf(true).openFile(file);
			new Notice(`Created "${file.basename}" from hedgedoc document.`);
		} catch (error) {
			new Notice(`Failed to create note from hedgedoc: ${toErrorMessage(error)}`);
		}
	}

	private resolveReferenceInput(input: string): HedgeDocReference {
		const trimmedInput = input.trim();
		if (trimmedInput.length === 0) {
			throw new Error("Enter a hedgedoc URL or note ID.");
		}

		if (/^https?:\/\//i.test(trimmedInput)) {
			const parsed = parseNoteUrl(trimmedInput);
			return {
				serverUrl: parsed.serverUrl,
				noteId: parsed.noteId,
				url: buildNoteUrl(parsed.serverUrl, parsed.noteId),
			};
		}

		const defaultServerUrl = this.plugin.settings.defaultServerUrl.trim();
		if (defaultServerUrl.length === 0) {
			throw new Error("Set a default hedgedoc server URL to import by note ID.");
		}

		const noteId = trimmedInput.replace(/^\/+/, "").replace(/\/+$/, "");
		if (noteId.length === 0) {
			throw new Error("Note ID is empty.");
		}

		return {
			serverUrl: defaultServerUrl.replace(/\/$/, ""),
			noteId,
			url: buildNoteUrl(defaultServerUrl, noteId),
		};
	}

	private resolveAvailableMarkdownPath(inputPath: string): string {
		const trimmed = inputPath.trim();
		const baseName = trimmed.length > 0 ? trimmed : "Untitled";
		const withExtension = baseName.toLowerCase().endsWith(".md")
			? baseName
			: `${baseName}.md`;
		const basePath = normalizePath(withExtension);
		if (basePath.length === 0 || basePath === "." || basePath.startsWith("../")) {
			throw new Error("Target note path must be inside the vault.");
		}

		let candidate = basePath;
		let suffix = 1;
		while (this.plugin.app.vault.getAbstractFileByPath(candidate) !== null) {
			candidate = normalizePath(basePath.replace(/\.md$/i, ` ${suffix}.md`));
			suffix++;
		}

		return candidate;
	}

	private hasLinkInFrontmatterCache(file: TFile): boolean {
		const cache = this.plugin.app.metadataCache.getFileCache(file);
		const frontmatter = cache?.frontmatter;
		if (frontmatter === undefined) {
			return false;
		}

		const frontmatterRecord = frontmatter as Record<string, unknown>;
		const value = frontmatterRecord[this.plugin.settings.frontmatterLinkProperty];
		return value !== undefined && value !== null;
	}

	private async buildSyncContext(file: TFile): Promise<SyncContext> {
		const markdown = await this.plugin.app.vault.cachedRead(file);
		const parts = splitMarkdownContent(markdown);
		const reference = resolveHedgeDocReference(markdown, {
			linkProperty: this.plugin.settings.frontmatterLinkProperty,
			defaultServerUrl: this.plugin.settings.defaultServerUrl,
		});

		return {parts, reference};
	}

	private async replaceFileBodyPreservingFrontmatter(file: TFile, body: string): Promise<boolean> {
		let changed = false;
		await this.plugin.app.vault.process(file, (currentMarkdown) => {
			const currentParts = splitMarkdownContent(currentMarkdown);
			if (currentParts.body === body) {
				return currentMarkdown;
			}

			changed = true;
			return mergeMarkdownContent(currentParts, body);
		});

		return changed;
	}

	private getActiveMarkdownFile(): TFile | null {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		if (activeFile === null || activeFile.extension !== "md") {
			return null;
		}

		return activeFile;
	}

	private markAutoPushSuppressed(path: string): void {
		this.suppressAutoPushUntil.set(path, Date.now() + this.plugin.settings.loopProtectionWindowMs);
	}

	private isAutoPushSuppressed(path: string): boolean {
		const suppressUntil = this.suppressAutoPushUntil.get(path);
		if (suppressUntil === undefined) {
			return false;
		}

		if (Date.now() >= suppressUntil) {
			this.suppressAutoPushUntil.delete(path);
			return false;
		}

		return true;
	}

	private handleSyncError(error: unknown, file: TFile, source: SyncSource): void {
		if (source === "auto" && isMissingLinkError(error)) {
			return;
		}

		if (source === "live" && isMissingLinkError(error)) {
			this.stopLiveSync(`Live sync stopped for "${file.basename}" because it is no longer linked.`);
			return;
		}

		const message = toErrorMessage(error);
		logSyncError(error, file, source, message);

		if (source === "auto") {
			new Notice(`Auto sync failed for "${file.basename}": ${message}`);
			return;
		}

		if (source === "live") {
			this.stopLiveSync(`Live sync stopped for "${file.basename}": ${message}`);
			return;
		}

		if (source === "bulk") {
			return;
		}

		new Notice(`HedgeSync failed for "${file.basename}": ${message}`);
	}
}

function resolvePushOptions(
	source: SyncSource,
	warnBeforeOverwrite: boolean,
	overrides: Partial<PushOptions>,
): PushOptions {
	return {
		showResultNotice: source === "manual",
		confirmOverwrite: source === "manual" && warnBeforeOverwrite,
		...overrides,
	};
}

function resolvePullOptions(
	source: SyncSource,
	warnBeforeOverwrite: boolean,
	overrides: Partial<PullOptions>,
): PullOptions {
	return {
		showResultNotice: source === "manual",
		showUpToDateNotice: source === "manual",
		confirmOverwrite: source === "manual" && warnBeforeOverwrite,
		useDownloadEndpoint: false,
		stripRemoteFrontmatter: false,
		...overrides,
	};
}

function isMarkdownFile(file: TAbstractFile | null): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

function isMissingLinkError(error: unknown): boolean {
	return error instanceof HedgeDocReferenceError
		&& (error.code === "missing-frontmatter" || error.code === "missing-link-property");
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	return String(error);
}

function logSyncError(
	error: unknown,
	file: TFile,
	source: SyncSource,
	message: string,
): void {
	const scope = `[hedgesync] ${source} sync failed for "${file.path}"`;
	console.error(`${scope}: ${message}`);

	if (error instanceof Error && error.stack !== undefined) {
		console.error(error.stack);
		return;
	}

	console.error(error);
}
