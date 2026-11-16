/**
 * Which of the notes on a HedgeDoc server are already in the vault. Pure
 * logic, no Obsidian APIs, so it can be tested on its own.
 */

import {serverKey} from "../server-key";

/** A HedgeDoc history entry, as returned by GET /history. */
export interface RemoteNote {
	id: string;
	text: string;
	time: number;
	tags: string[];
	pinned: boolean;
}

/** A vault note and the HedgeDoc note it links to. */
export interface LinkedNote {
	path: string;
	serverUrl: string;
	noteId: string;
}

export interface CatalogEntry {
	note: RemoteNote;
	/** Vault notes linked to this note; empty when it is not in the vault. */
	paths: string[];
}

/** The server's notes with their vault notes: pinned first, then most recently opened. */
export function buildCatalog(serverUrl: string, notes: RemoteNote[], linked: LinkedNote[]): CatalogEntry[] {
	const key = serverKey(serverUrl);
	const pathsById = new Map<string, string[]>();
	for (const link of linked) {
		if (serverKey(link.serverUrl) !== key) continue;
		const paths = pathsById.get(link.noteId) ?? [];
		paths.push(link.path);
		pathsById.set(link.noteId, paths);
	}
	return notes
		.map((note) => ({note, paths: pathsById.get(note.id) ?? []}))
		.sort((a, b) => Number(b.note.pinned) - Number(a.note.pinned) || b.note.time - a.note.time);
}

/** Vault notes linked to a note on this server that is not in the history, sorted by path. */
export function linkedNotInHistory(serverUrl: string, notes: RemoteNote[], linked: LinkedNote[]): LinkedNote[] {
	const key = serverKey(serverUrl);
	const ids = new Set(notes.map((note) => note.id));
	return linked
		.filter((link) => serverKey(link.serverUrl) === key && !ids.has(link.noteId))
		.sort((a, b) => a.path.localeCompare(b.path));
}

/** Linked vault notes whose path or note ID contains every word of the search. */
export function filterLinked(linked: LinkedNote[], query: string): LinkedNote[] {
	const words = query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
	return linked.filter((link) => {
		const haystack = `${link.path}\n${link.noteId}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

export interface CatalogFilter {
	query: string;
	onlyMissing: boolean;
}

/** Entries matching a search (title, ID, tags or vault path) and, optionally, not yet in the vault. */
export function filterCatalog(entries: CatalogEntry[], filter: CatalogFilter): CatalogEntry[] {
	const words = filter.query.toLowerCase().split(/\s+/).filter((word) => word.length > 0);
	return entries.filter((entry) => {
		if (filter.onlyMissing && entry.paths.length > 0) return false;
		const haystack = [entry.note.text, entry.note.id, ...entry.note.tags, ...entry.paths].join("\n").toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}

/** A file name for a note title: without characters that file systems or Obsidian links reject. */
export function fileNameFor(note: RemoteNote): string {
	const cleaned = note.text
		.replace(/[\\/:*?"<>|#^[\]]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+/, "")
		.slice(0, 120)
		.trim();
	return cleaned.length > 0 && cleaned.toLowerCase() !== "untitled" ? cleaned : note.id;
}
