/** The "Browse hedgedoc notes" command: connects the browse modal to the vault and the server. */

import {normalizePath, Notice, TFile, TFolder, type Plugin} from "obsidian";
import {buildNoteUrl} from "hedgesync/obsidian";
import type {AccountManager} from "../accounts";
import type {HedgeDocService} from "../hedgedoc-service";
import type {SyncManager} from "../sync-manager";
import {BrowseModal, type BrowseHost} from "../ui/browse-modal";
import {fileNameFor, type RemoteNote} from "./catalog";

export function registerBrowseCommand(plugin: Plugin, service: HedgeDocService, accounts: AccountManager, sync: SyncManager): void {
	plugin.addCommand({
		id: "browse-hedgedoc-notes",
		name: "Browse hedgedoc notes",
		callback: () => {
			const host = browseHost(plugin, service, accounts, sync);
			if (host.servers().length === 0) {
				new Notice("Add a hedgedoc account first: the server only lists notes for logged-in users. Use the command \"Log in to hedgedoc\".");
				return;
			}
			new BrowseModal(host).open();
		},
	});
}

function browseHost(plugin: Plugin, service: HedgeDocService, accounts: AccountManager, sync: SyncManager): BrowseHost {
	const {app} = plugin;
	return {
		app,
		servers: () => accounts.list().map((account) => account.key),
		history: (serverUrl) => service.history(serverUrl),
		linkedNotes: () => sync.linkedNotes(),
		openPath: async (path) => {
			const file = app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) await app.workspace.getLeaf(true).openFile(file);
		},
		openInBrowser: (serverUrl, note) => window.open(buildNoteUrl(serverUrl, note.id), "_blank"),
		importNote: async (serverUrl: string, note: RemoteNote, folder: string, bulk: boolean) => {
			const reference = {serverUrl, noteId: note.id, url: buildNoteUrl(serverUrl, note.id)};
			// Like "Pull all": many notes are read over plain HTTP, one over a live connection.
			const body = bulk ? await service.download(reference) : await service.pull(reference);
			const folderPath = folder.length > 0 ? normalizePath(folder) : "";
			if (folderPath.length > 0 && !(app.vault.getAbstractFileByPath(folderPath) instanceof TFolder)) {
				await app.vault.createFolder(folderPath);
			}
			const name = `${fileNameFor(note)}.md`;
			const file = await sync.createLinkedNote(reference, folderPath.length > 0 ? `${folderPath}/${name}` : name, body);
			return file.path;
		},
		setPinned: (serverUrl, noteId, pinned) => service.setPinned(serverUrl, noteId, pinned),
		visit: (serverUrl, link) => service.visit({serverUrl, noteId: link.noteId, url: buildNoteUrl(serverUrl, link.noteId)}),
		defaultFolder: () => {
			const parent = app.fileManager.getNewFileParent(app.workspace.getActiveFile()?.path ?? "");
			return parent.isRoot() ? "" : parent.path;
		},
	};
}
