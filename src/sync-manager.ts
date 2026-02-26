import {Notice, TAbstractFile, TFile} from "obsidian";
import {HedgeDocReferenceError, mergeMarkdownContent, resolveHedgeDocReference, splitMarkdownContent} from "./frontmatter";
import {HedgeDocSyncService} from "./hedgedoc-sync-service";
import type ObsidianHedgeSyncPlugin from "./main";
import type {HedgeDocReference} from "./types";

type SyncSource = "manual" | "auto";

export class SyncManager {
	private readonly plugin: ObsidianHedgeSyncPlugin;
	private readonly syncService: HedgeDocSyncService;
	private readonly autoPushTimers = new Map<string, number>();
	private readonly activePushes = new Set<string>();
	private readonly suppressAutoPushUntil = new Map<string, number>();

	constructor(plugin: ObsidianHedgeSyncPlugin, syncService: HedgeDocSyncService) {
		this.plugin = plugin;
		this.syncService = syncService;
	}

	register(): void {
		this.registerCommands();

		this.plugin.registerEvent(this.plugin.app.vault.on("modify", (file) => {
			void this.handleVaultModify(file);
		}));

		this.plugin.register(() => this.dispose());
	}

	dispose(): void {
		for (const timerId of this.autoPushTimers.values()) {
			window.clearTimeout(timerId);
		}
		this.autoPushTimers.clear();
		this.activePushes.clear();
		this.suppressAutoPushUntil.clear();
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
					void this.pullFile(file);
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
	}

	private async handleVaultModify(file: TAbstractFile): Promise<void> {
		if (!this.plugin.settings.autoPushOnSave) {
			return;
		}

		if (!isMarkdownFile(file)) {
			return;
		}

		if (this.isAutoPushSuppressed(file.path)) {
			return;
		}

		const existingTimer = this.autoPushTimers.get(file.path);
		if (existingTimer !== undefined) {
			window.clearTimeout(existingTimer);
		}

		const timerId = window.setTimeout(() => {
			this.autoPushTimers.delete(file.path);
			void this.pushFile(file, "auto");
		}, this.plugin.settings.autoPushDebounceMs);

		this.autoPushTimers.set(file.path, timerId);
	}

	private async pushFile(file: TFile, source: SyncSource): Promise<void> {
		if (this.activePushes.has(file.path)) {
			if (source === "manual") {
				new Notice(`Sync already running for "${file.basename}".`);
			}
			return;
		}

		this.activePushes.add(file.path);

		try {
			const context = await this.buildSyncContext(file);
			const result = await this.syncService.push(context.reference, context.parts.body);

			if (source === "manual") {
				const message = result.changed
					? `Synced "${file.basename}" to HedgeDoc.`
					: `"${file.basename}" is already in sync with HedgeDoc.`;
				new Notice(message);
			}
		} catch (error) {
			this.handleSyncError(error, file, source);
		} finally {
			this.activePushes.delete(file.path);
		}
	}

	private async pullFile(file: TFile): Promise<void> {
		try {
			const context = await this.buildSyncContext(file);
			const remoteBody = await this.syncService.pull(context.reference);

			if (remoteBody === context.parts.body) {
				new Notice(`"${file.basename}" is already up to date.`);
				return;
			}

			const mergedContent = mergeMarkdownContent(context.parts, remoteBody);
			this.markAutoPushSuppressed(file.path);
			await this.plugin.app.vault.modify(file, mergedContent);

			new Notice(`Pulled changes from HedgeDoc into "${file.basename}".`);
		} catch (error) {
			this.handleSyncError(error, file, "manual");
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

	private async buildSyncContext(file: TFile): Promise<{
		parts: ReturnType<typeof splitMarkdownContent>;
		reference: HedgeDocReference;
	}> {
		const markdown = await this.plugin.app.vault.cachedRead(file);
		const parts = splitMarkdownContent(markdown);
		const reference = resolveHedgeDocReference(markdown, {
			linkProperty: this.plugin.settings.frontmatterLinkProperty,
			defaultServerUrl: this.plugin.settings.defaultServerUrl,
		});

		return {
			parts,
			reference,
		};
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
		if (
			source === "auto"
			&& error instanceof HedgeDocReferenceError
			&& (error.code === "missing-frontmatter" || error.code === "missing-link-property")
		) {
			return;
		}

		const message = toErrorMessage(error);
		logSyncError(error, file, source, message);
		if (source === "auto") {
			new Notice(`Auto sync failed for "${file.basename}": ${message}`);
			return;
		}

		new Notice(`HedgeSync failed for "${file.basename}": ${message}`);
	}
}

function isMarkdownFile(file: TAbstractFile): file is TFile {
	return file instanceof TFile && file.extension === "md";
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
