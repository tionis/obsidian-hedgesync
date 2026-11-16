import {setIcon} from "obsidian";
import type {LinkedNote} from "../browse/catalog";

export interface UntrackedActions {
	open(link: LinkedNote): void;
	addToHistory(link: LinkedNote, button: HTMLButtonElement): void;
	addAllToHistory(links: LinkedNote[]): void;
}

/**
 * Vault notes linked to the server that are not in the history: never opened
 * while logged in, removed from the history, deleted on the server, or linked
 * by a form of the note ID that the history does not use.
 */
export function renderUntracked(container: HTMLElement, links: LinkedNote[], total: number, actions: UntrackedActions, busy: boolean): void {
	// Re-rendering keeps the section open if it was.
	const wasOpen = container.querySelector("details")?.open ?? false;
	container.empty();
	if (total === 0) return;

	const details = container.createEl("details", {cls: "hedgesync-browse-untracked"});
	details.open = wasOpen;
	const summary = details.createEl("summary");
	summary.setText(`${total} linked vault ${total === 1 ? "note is" : "notes are"} not in your history`);
	details.createDiv({
		cls: "hedgesync-browse-hint",
		text: "Adding a note opens it on the server as you, which puts it in your history. If it still does not appear, the note was deleted, you have no access, or the link uses a different form of its ID.",
	});

	const list = details.createDiv({cls: "hedgesync-browse-list"});
	for (const link of links) {
		const row = list.createDiv({cls: "hedgesync-browse-row"});
		const info = row.createDiv({cls: "hedgesync-browse-info"});
		info.createDiv({cls: "hedgesync-browse-title", text: link.path});
		info.createDiv({cls: "hedgesync-browse-meta", text: link.noteId});

		const buttons = row.createDiv({cls: "hedgesync-browse-actions"});
		const open = buttons.createEl("button", {cls: "clickable-icon", attr: {"aria-label": "Open vault note"}});
		setIcon(open, "file-text");
		open.addEventListener("click", () => actions.open(link));
		const add = buttons.createEl("button", {text: "Add to history"});
		add.disabled = busy;
		add.addEventListener("click", () => actions.addToHistory(link, add));
	}
	if (links.length === 0) {
		list.createDiv({cls: "hedgesync-browse-empty", text: "No matching notes."});
		return;
	}
	if (links.length > 1) {
		const all = details.createEl("button", {text: `Add ${links.length} to history`, cls: "hedgesync-browse-add-all"});
		all.disabled = busy;
		all.addEventListener("click", () => actions.addAllToHistory(links));
	}
}
