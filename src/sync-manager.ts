import {Notice, TAbstractFile, TFile} from "obsidian";
import {requestConfirmation} from "./confirmation-modal";
import {HedgeDocReferenceError, mergeMarkdownContent, resolveHedgeDocReference, splitMarkdownContent} from "./frontmatter";
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

export class SyncManager {
	private readonly plugin: ObsidianHedgeSyncPlugin;
	private readonly syncService: HedgeDocSyncService;
	private readonly pushTimers = new Map<string, number>();
	private readonly activePushes = new Set<string>();
	private readonly suppressAutoPushUntil = new Map<string, number>();
	private liveSyncFilePath: string | null = null;
	private liveSyncPullTimerId: number | null = null;
	private bulkPullInProgress = false;
	private pushQuickActionEl: HTMLElement | null = null;
	private pullQuickActionEl: HTMLElement | null = null;
	private liveQuickActionEl: HTMLElement | null = null;
	private quickActionsRefreshSeq = 0;

	constructor(plugin: ObsidianHedgeSyncPlugin, syncService: HedgeDocSyncService) {
		this.plugin = plugin;
		this.syncService = syncService;
	}

	register(): void {
		this.registerCommands();
		this.registerQuickActions();

		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			void this.handleVaultModify(file);
		}));
		this.plugin.registerEvent(this.plugin.app.vault.on("rename", (file, oldPath) => {
			this.handleFileRename(file, oldPath);
		}));
		this.plugin.registerEvent(this.plugin.app.vault.on("delete", (file) => {
			this.handleFileDelete(file);
		}));
		this.plugin.registerEvent(this.plugin.app.workspace.on("file-open", () => {
			void this.updateQuickActions();
		}));
		this.plugin.registerEvent(this.plugin.app.metadataCache.on("changed", (file) => {
			const activeFile = this.getActiveMarkdownFile();
			if (activeFile !== null && activeFile.path === file.path) {
				void this.updateQuickActions();
			}
		}));

		this.plugin.register(() => this.dispose());
		void this.updateQuickActions();
	}

	dispose(): void {
		for (const timerId of this.pushTimers.values()) {
			window.clearTimeout(timerId);
		}
		this.pushTimers.clear();
		this.activePushes.clear();
		this.suppressAutoPushUntil.clear();
		this.clearLiveSyncPullTimer();
		this.liveSyncFilePath = null;
	}

	onSettingsChanged(): void {
		if (this.liveSyncFilePath !== null) {
			this.scheduleLiveSyncPull();
		}
		void this.updateQuickActions();
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
	}

	private registerQuickActions(): void {
		this.pushQuickActionEl = this.plugin.addRibbonIcon(
			"upload",
			"Push active note to hedgedoc",
			() => {
				const file = this.getActiveMarkdownFile();
				if (file !== null) {
					void this.pushFile(file, "manual");
				}
			},
		);

		this.pullQuickActionEl = this.plugin.addRibbonIcon(
			"download",
			"Pull active note from hedgedoc",
			() => {
				const file = this.getActiveMarkdownFile();
				if (file !== null) {
					void this.pullFile(file, "manual");
				}
			},
		);

		this.liveQuickActionEl = this.plugin.addRibbonIcon(
			"refresh-cw",
			"Toggle live sync for active note",
			() => {
				const file = this.getActiveMarkdownFile();
				if (file !== null) {
					void this.toggleLiveSyncForFile(file);
				}
			},
		);
	}

	private async handleVaultModify(file: TAbstractFile): Promise<void> {
		if (!isMarkdownFile(file)) {
			return;
		}

		if (this.isAutoPushSuppressed(file.path)) {
			return;
		}

		if (file.path === this.liveSyncFilePath) {
			this.schedulePush(file, "live", this.plugin.settings.liveSyncPushDebounceMs);
			return;
		}

		if (this.plugin.settings.autoPushOnSave) {
			this.schedulePush(file, "auto", this.plugin.settings.autoPushDebounceMs);
		}
	}

	private handleFileRename(file: TAbstractFile, oldPath: string): void {
		if (!isMarkdownFile(file)) {
			return;
		}

		if (this.liveSyncFilePath === oldPath) {
			this.liveSyncFilePath = file.path;
			this.scheduleLiveSyncPull();
			void this.updateQuickActions();
		}
	}

	private handleFileDelete(file: TAbstractFile): void {
		if (this.liveSyncFilePath === file.path) {
			this.stopLiveSync("Live sync stopped because the file was deleted.");
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
				const message = result.changed
					? `Synced "${file.basename}" to hedgedoc.`
					: `"${file.basename}" is already in sync with hedgedoc.`;
				new Notice(message);
			}

			return result.changed;
		} catch (error) {
			this.handleSyncError(error, file, source);
			return false;
		} finally {
			this.activePushes.delete(file.path);
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
			const remoteContent = resolvedOptions.useDownloadEndpoint
				? await this.syncService.download(syncContext.reference)
				: await this.syncService.pull(syncContext.reference);
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

			const mergedContent = mergeMarkdownContent(syncContext.parts, remoteBody);
			this.markAutoPushSuppressed(file.path);
			await this.plugin.app.vault.modify(file, mergedContent);

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
		if (this.liveSyncFilePath === file.path) {
			this.stopLiveSync(`Live sync disabled for "${file.basename}".`);
			return;
		}

		try {
			await this.buildSyncContext(file);
		} catch (error) {
			this.handleSyncError(error, file, "manual");
			return;
		}

		const previousFilePath = this.liveSyncFilePath;
		this.liveSyncFilePath = file.path;
		this.scheduleLiveSyncPull();
		void this.updateQuickActions();

		if (previousFilePath !== null && previousFilePath !== file.path) {
			const previousFile = this.plugin.app.vault.getAbstractFileByPath(previousFilePath);
			if (isMarkdownFile(previousFile)) {
				new Notice(`Live sync moved from "${previousFile.basename}" to "${file.basename}".`);
			} else {
				new Notice(`Live sync enabled for "${file.basename}".`);
			}
		} else {
			new Notice(`Live sync enabled for "${file.basename}".`);
		}
	}

	private scheduleLiveSyncPull(): void {
		this.clearLiveSyncPullTimer();

		if (this.liveSyncFilePath === null) {
			return;
		}

		this.liveSyncPullTimerId = window.setTimeout(() => {
			void this.runLiveSyncPull();
		}, this.plugin.settings.liveSyncPullIntervalMs);
	}

	private clearLiveSyncPullTimer(): void {
		if (this.liveSyncPullTimerId !== null) {
			window.clearTimeout(this.liveSyncPullTimerId);
			this.liveSyncPullTimerId = null;
		}
	}

	private async runLiveSyncPull(): Promise<void> {
		const liveFilePath = this.liveSyncFilePath;
		if (liveFilePath === null) {
			return;
		}

		const liveFile = this.plugin.app.vault.getAbstractFileByPath(liveFilePath);
		if (!isMarkdownFile(liveFile)) {
			this.stopLiveSync("Live sync stopped because the file is no longer available.");
			return;
		}

		await this.pullFile(liveFile, "live", {
			showResultNotice: false,
			showUpToDateNotice: false,
			confirmOverwrite: false,
		});

		if (this.liveSyncFilePath === liveFilePath) {
			this.scheduleLiveSyncPull();
		}
	}

	private stopLiveSync(message: string | null = null): void {
		this.clearLiveSyncPullTimer();

		const liveFilePath = this.liveSyncFilePath;
		this.liveSyncFilePath = null;

		if (liveFilePath !== null) {
			const pendingPushTimer = this.pushTimers.get(liveFilePath);
			if (pendingPushTimer !== undefined) {
				window.clearTimeout(pendingPushTimer);
				this.pushTimers.delete(liveFilePath);
			}
		}

		if (message !== null) {
			new Notice(message);
		}

		void this.updateQuickActions();
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

	private async updateQuickActions(): Promise<void> {
		const pushEl = this.pushQuickActionEl;
		const pullEl = this.pullQuickActionEl;
		const liveEl = this.liveQuickActionEl;
		if (pushEl === null || pullEl === null || liveEl === null) {
			return;
		}

		if (!this.plugin.settings.showQuickActionButtons) {
			setElementVisibility(pushEl, false);
			setElementVisibility(pullEl, false);
			setElementVisibility(liveEl, false);
			return;
		}

		const refreshSeq = ++this.quickActionsRefreshSeq;
		const activeFile = this.getActiveMarkdownFile();
		if (activeFile === null) {
			setElementVisibility(pushEl, false);
			setElementVisibility(pullEl, false);
			setElementVisibility(liveEl, false);
			return;
		}

		const hasReference = await this.activeFileHasReference(activeFile);
		if (refreshSeq !== this.quickActionsRefreshSeq) {
			return;
		}

		setElementVisibility(pushEl, hasReference);
		setElementVisibility(pullEl, hasReference);
		setElementVisibility(liveEl, hasReference);

		const liveEnabled = hasReference && this.liveSyncFilePath === activeFile.path;
		liveEl.classList.toggle("hedgesync-live-active", liveEnabled);
		liveEl.setAttribute("aria-label", liveEnabled
			? "Stop live sync for active note"
			: "Start live sync for active note");
	}

	private async activeFileHasReference(file: TFile): Promise<boolean> {
		try {
			await this.buildSyncContext(file);
			return true;
		} catch {
			return false;
		}
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

	private getActiveMarkdownFile(): TFile | null {
		const activeFile = this.plugin.app.workspace.getActiveFile();
		if (activeFile === null || activeFile.extension !== "md") {
			return null;
		}

		return activeFile;
	}

	private markAutoPushSuppressed(path: string): void {
		this.suppressAutoPushUntil.set(
			path,
			Date.now() + this.plugin.settings.loopProtectionWindowMs,
		);
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

function setElementVisibility(element: HTMLElement, visible: boolean): void {
	element.style.display = visible ? "" : "none";
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
