import {App, type ButtonComponent, Modal, moment, Notice, Setting, setIcon} from "obsidian";
import {buildCatalog, type CatalogEntry, filterCatalog, filterLinked, type LinkedNote, linkedNotInHistory, mergeLinked, type RemoteNote} from "../browse/catalog";
import {displayServer} from "../server-key";
import {renderUntracked} from "./browse-untracked";
import {requestConfirmation} from "./confirmation-modal";

export interface BrowseHost {
	app: App;
	/** Servers with an account, the default server's first. */
	servers(): string[];
	history(serverUrl: string): Promise<RemoteNote[]>;
	linkedNotes(): LinkedNote[];
	openPath(path: string): Promise<void>;
	openInBrowser(serverUrl: string, note: RemoteNote): void;
	/** Create a linked vault note in `folder`; returns its path. */
	importNote(serverUrl: string, note: RemoteNote, folder: string, bulk: boolean): Promise<string>;
	defaultFolder(): string;
	setPinned(serverUrl: string, noteId: string, pinned: boolean): Promise<void>;
	/** Open the note on the server as the logged-in user, so it enters the history. */
	visit(serverUrl: string, link: LinkedNote): Promise<void>;
}

/** HedgeDoc writes the history entry shortly after the connection; wait this long between checks. */
const HISTORY_RETRY_MS = 700;
const HISTORY_RETRIES = 3;

/** Lists the notes on a server and shows which are in the vault. */
export class BrowseModal extends Modal {
	private serverUrl: string;
	private notes: RemoteNote[] | null = null;
	private entries: CatalogEntry[] = [];
	private untracked: LinkedNote[] = [];
	/**
	 * Notes imported while the modal is open. The metadata cache indexes a new
	 * file's frontmatter only after a moment, so until then these would look
	 * missing and could be imported twice.
	 */
	private readonly imported: LinkedNote[] = [];
	private query = "";
	private onlyMissing = false;
	private folder: string;
	private busy = false;
	private loadToken = 0;

	private summaryEl!: HTMLElement;
	private listEl!: HTMLElement;
	private untrackedEl!: HTMLElement;
	private importAllSetting!: Setting;
	private importAllButton!: ButtonComponent;

	constructor(private readonly host: BrowseHost) {
		super(host.app);
		this.serverUrl = host.servers()[0] ?? "";
		this.folder = host.defaultFolder();
	}

	onOpen(): void {
		this.setTitle("Hedgedoc notes");
		this.modalEl.addClass("hedgesync-browse");
		const {contentEl} = this;
		const servers = this.host.servers();

		if (servers.length > 1) {
			new Setting(contentEl)
				.setName("Server")
				.addDropdown((dropdown) => {
					for (const server of servers) dropdown.addOption(server, displayServer(server));
					dropdown.setValue(this.serverUrl).onChange((value) => {
						this.serverUrl = value;
						void this.load();
					});
				});
		}

		new Setting(contentEl)
			.setName("Search")
			.addSearch((search) => {
				search.setPlaceholder("Title, tag or path").onChange((value) => {
					this.query = value;
					this.renderList();
				});
				window.setTimeout(() => search.inputEl.focus(), 0);
			});

		new Setting(contentEl)
			.setName("Only notes not in the vault")
			.addToggle((toggle) => toggle.setValue(this.onlyMissing).onChange((value) => {
				this.onlyMissing = value;
				this.renderList();
			}));

		const summary = contentEl.createDiv({cls: "hedgesync-browse-summary"});
		this.summaryEl = summary.createSpan();
		const refresh = summary.createEl("button", {cls: "clickable-icon", attr: {"aria-label": "Refresh"}});
		setIcon(refresh, "refresh-cw");
		refresh.addEventListener("click", () => void this.load());

		this.listEl = contentEl.createDiv({cls: "hedgesync-browse-list"});
		this.untrackedEl = contentEl.createDiv();

		new Setting(contentEl)
			.setName("Folder for new notes")
			.addText((text) => text.setPlaceholder("Vault root").setValue(this.folder).onChange((value) => {
				this.folder = value.trim();
			}));

		this.importAllSetting = new Setting(contentEl)
			.addButton((button) => {
				this.importAllButton = button;
				button.setButtonText("Import all").setCta().onClick(() => void this.importAll());
			});

		void this.load();
	}

	onClose(): void {
		this.loadToken++;
		this.contentEl.empty();
	}

	private async load(): Promise<void> {
		const token = ++this.loadToken;
		this.notes = null;
		this.summaryEl.setText(`Loading notes from ${displayServer(this.serverUrl)}...`);
		this.listEl.empty();
		this.untrackedEl.empty();
		this.updateImportAll([]);
		try {
			const notes = await this.host.history(this.serverUrl);
			if (token !== this.loadToken) return;
			this.notes = notes;
			this.refreshEntries();
		} catch (error) {
			if (token !== this.loadToken) return;
			console.error("[hedgesync] could not load the note list", error);
			this.summaryEl.setText(`Could not load notes from ${displayServer(this.serverUrl)}: ${errorText(error)}`);
		}
	}

	/** Recompute which notes are in the vault, e.g. after an import. */
	private refreshEntries(): void {
		if (this.notes === null) return;
		const linked = mergeLinked(this.host.linkedNotes(), this.imported);
		this.entries = buildCatalog(this.serverUrl, this.notes, linked);
		this.untracked = linkedNotInHistory(this.serverUrl, this.notes, linked);
		this.renderList();
	}

	private renderList(): void {
		if (this.notes === null) return;
		const missing = this.entries.filter((entry) => entry.paths.length === 0).length;
		this.summaryEl.setText(this.entries.length === 0
			? "No notes in your history on this server. Hedgedoc lists the notes you have opened while logged in."
			: `${this.entries.length} notes, ${this.entries.length - missing} in the vault, ${missing} not.`);

		const shown = filterCatalog(this.entries, {query: this.query, onlyMissing: this.onlyMissing});
		this.listEl.empty();
		for (const entry of shown) this.renderEntry(entry);
		if (shown.length === 0 && this.entries.length > 0) {
			this.listEl.createDiv({cls: "hedgesync-browse-empty", text: "No matching notes."});
		}
		this.updateImportAll(shown.filter((entry) => entry.paths.length === 0));
		this.renderUntracked();
	}

	private renderUntracked(): void {
		renderUntracked(this.untrackedEl, filterLinked(this.untracked, this.query), this.untracked.length, {
			open: (link) => {
				this.close();
				void this.host.openPath(link.path);
			},
			addToHistory: (link, button) => void this.addToHistory([link], button),
			addAllToHistory: (links) => void this.addToHistory(links),
		}, this.busy);
	}

	private renderEntry(entry: CatalogEntry): void {
		const {note, paths} = entry;
		const row = this.listEl.createDiv({cls: "hedgesync-browse-row"});
		const info = row.createDiv({cls: "hedgesync-browse-info"});
		const title = info.createDiv({cls: "hedgesync-browse-title", text: note.text || note.id});
		if (note.pinned) {
			const pin = title.createSpan({cls: "hedgesync-browse-pin", attr: {"aria-label": "Pinned"}});
			setIcon(pin, "pin");
		}
		const meta = [`opened ${moment(note.time).fromNow()}`, ...note.tags.map((tag) => `#${tag}`)];
		info.createDiv({cls: "hedgesync-browse-meta", text: meta.join(" · ")});
		info.createDiv({
			cls: paths.length > 0 ? "hedgesync-browse-path" : "hedgesync-browse-path is-missing",
			text: paths.length > 0 ? paths.join(", ") : "Not in the vault",
		});

		const actions = row.createDiv({cls: "hedgesync-browse-actions"});
		const pin = actions.createEl("button", {cls: "clickable-icon", attr: {"aria-label": note.pinned ? "Unpin" : "Pin"}});
		setIcon(pin, note.pinned ? "pin-off" : "pin");
		pin.addEventListener("click", () => void this.togglePin(note, pin));
		const web = actions.createEl("button", {cls: "clickable-icon", attr: {"aria-label": "Open in hedgedoc"}});
		setIcon(web, "external-link");
		web.addEventListener("click", () => this.host.openInBrowser(this.serverUrl, note));

		const path = paths[0];
		if (path !== undefined) {
			actions.createEl("button", {text: "Open"}).addEventListener("click", () => {
				this.close();
				void this.host.openPath(path);
			});
		} else {
			const button = actions.createEl("button", {text: "Import", cls: "mod-cta"});
			button.addEventListener("click", () => void this.importOne(note, button));
		}
	}

	private async importOne(note: RemoteNote, button: HTMLButtonElement): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		button.disabled = true;
		try {
			const path = await this.host.importNote(this.serverUrl, note, this.folder, false);
			this.imported.push({path, serverUrl: this.serverUrl, noteId: note.id});
			new Notice(`Imported "${note.text || note.id}" to ${path}.`);
		} catch (error) {
			console.error("[hedgesync] import failed", error);
			new Notice(`Could not import "${note.text || note.id}": ${errorText(error)}`);
			button.disabled = false;
		} finally {
			this.busy = false;
		}
		this.refreshEntries();
	}

	private async togglePin(note: RemoteNote, button: HTMLButtonElement): Promise<void> {
		button.disabled = true;
		try {
			await this.host.setPinned(this.serverUrl, note.id, !note.pinned);
			note.pinned = !note.pinned;
			this.refreshEntries();
		} catch (error) {
			console.error("[hedgesync] could not change the pin", error);
			new Notice(`Could not ${note.pinned ? "unpin" : "pin"} "${note.text || note.id}": ${errorText(error)}`);
			button.disabled = false;
		}
	}

	/** Open each note on the server so it enters the history, then reload the history. */
	private async addToHistory(links: LinkedNote[], button?: HTMLButtonElement): Promise<void> {
		if (this.busy || links.length === 0) return;
		this.busy = true;
		if (button !== undefined) button.disabled = true;
		this.renderUntracked();
		const progress = links.length > 1 ? new Notice(`Adding ${links.length} notes to your history...`, 0) : null;
		const failed: string[] = [];
		const serverUrl = this.serverUrl;
		try {
			for (const link of links) {
				try {
					await this.host.visit(serverUrl, link);
				} catch (error) {
					failed.push(link.path);
					console.error(`[hedgesync] could not open ${link.noteId}`, error);
					if (links.length === 1) new Notice(`Could not open "${link.path}" on the server: ${errorText(error)}`);
				}
			}
			const opened = links.filter((link) => !failed.includes(link.path));
			let notes: RemoteNote[] = [];
			for (let attempt = 0; attempt < HISTORY_RETRIES; attempt++) {
				if (opened.length > 0) await sleep(HISTORY_RETRY_MS);
				notes = await this.host.history(serverUrl);
				const ids = new Set(notes.map((note) => note.id));
				if (opened.every((link) => ids.has(link.noteId))) break;
			}
			if (serverUrl !== this.serverUrl) return;
			this.notes = notes;
			const ids = new Set(notes.map((note) => note.id));
			const added = links.filter((link) => ids.has(link.noteId)).length;
			const stillMissing = links.length - added - failed.length;
			if (links.length === 1 && added === 1) {
				new Notice(`Added "${links[0]?.path ?? ""}" to your history.`);
			} else if (links.length > 1) {
				new Notice(`Added ${added} of ${links.length} notes to your history.`
					+ (failed.length > 0 ? ` ${failed.length} could not be opened (see the developer console).` : "")
					+ (stillMissing > 0 ? ` ${stillMissing} were opened but are listed under a different ID.` : ""));
			} else if (stillMissing === 1) {
				new Notice(`"${links[0]?.path ?? ""}" was opened, but your history lists it under a different ID. Link it with the ID from its address in hedgedoc.`, 10_000);
			}
		} catch (error) {
			console.error("[hedgesync] could not reload the history", error);
			new Notice(`Could not reload your history: ${errorText(error)}`);
		} finally {
			this.busy = false;
			progress?.hide();
		}
		this.refreshEntries();
	}

	private updateImportAll(missing: CatalogEntry[]): void {
		this.importAllSetting.setDesc(missing.length > 0
			? `Import the ${missing.length} listed notes that are not in the vault.`
			: "Every listed note is in the vault.");
		this.importAllButton.setButtonText(missing.length > 0 ? `Import ${missing.length}` : "Import all");
		this.importAllButton.setDisabled(missing.length === 0 || this.busy);
	}

	private async importAll(): Promise<void> {
		if (this.busy) return;
		const missing = filterCatalog(this.entries, {query: this.query, onlyMissing: true}).map((entry) => entry.note);
		if (missing.length === 0) return;
		const folder = this.folder.length > 0 ? this.folder : "the vault root";
		const confirmed = await requestConfirmation(this.app, {
			title: `Import ${missing.length} notes?`,
			message: `Creates ${missing.length} linked notes in ${folder}.`,
			confirmText: "Import",
			cancelText: "Cancel",
		});
		if (!confirmed) return;

		this.busy = true;
		this.updateImportAll([]);
		const progress = new Notice(`Importing ${missing.length} notes from hedgedoc...`, 0);
		let imported = 0;
		let failed = 0;
		try {
			for (const note of missing) {
				try {
					const path = await this.host.importNote(this.serverUrl, note, this.folder, true);
					this.imported.push({path, serverUrl: this.serverUrl, noteId: note.id});
					imported++;
				} catch (error) {
					failed++;
					console.error(`[hedgesync] import of ${note.id} failed`, error);
				}
				progress.setMessage(`Importing notes from hedgedoc: ${imported + failed} of ${missing.length}...`);
			}
		} finally {
			this.busy = false;
			progress.hide();
		}
		new Notice(`Imported ${imported} notes${failed > 0 ? `, ${failed} failed (see the developer console)` : ""}.`);
		this.refreshEntries();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}
