/**
 * Translation between editor changes and hedgesync text operations.
 *
 * The HedgeDoc document is the note body; the editor holds front matter plus
 * body. `offset` is the length of the front matter block, so body position p
 * is editor position offset + p. Kept free of Obsidian imports for testing.
 */

import {diffToOperation, TextOperation} from "hedgesync/obsidian";

/** An editor change in the coordinates of the document before the change. */
export interface EditorChange {
	from: number;
	to: number;
	insert: string;
}

/** Editor changes (all relative to the pre-change document) for an operation on the body. */
export function changesFromOperation(operation: TextOperation, offset: number): EditorChange[] {
	const changes: EditorChange[] = [];
	let position = offset;
	for (const op of operation.ops) {
		if (TextOperation.isRetain(op)) {
			position += op;
		} else if (TextOperation.isInsert(op)) {
			changes.push({from: position, to: position, insert: op});
		} else {
			const length = -op;
			changes.push({from: position, to: position + length, insert: ""});
			position += length;
		}
	}
	return mergeAdjacent(changes);
}

/**
 * Merge touching changes ([a, b) then [b, c)) into one replacement of [a, c),
 * so an insertion followed by a deletion at the same position is unambiguous.
 */
function mergeAdjacent(changes: EditorChange[]): EditorChange[] {
	const merged: EditorChange[] = [];
	for (const change of changes) {
		const last = merged[merged.length - 1];
		if (last !== undefined && last.to === change.from) {
			last.to = change.to;
			last.insert += change.insert;
		} else {
			merged.push({...change});
		}
	}
	return merged;
}

/**
 * The body operation for editor changes, or null when a change touches the
 * front matter (the caller then falls back to a diff of the bodies).
 *
 * `changes` are sorted, non-overlapping and relative to the old document, as
 * CodeMirror's ChangeSet.iterChanges reports them.
 */
export function operationFromChanges(changes: EditorChange[], offset: number, bodyLength: number): TextOperation | null {
	const operation = new TextOperation();
	let position = 0;
	for (const change of changes) {
		const from = change.from - offset;
		const to = change.to - offset;
		if (from < 0 || to < from || to > bodyLength || from < position) {
			return null;
		}
		operation.retain(from - position);
		if (to > from) operation.delete(to - from);
		if (change.insert.length > 0) operation.insert(change.insert);
		position = to;
	}
	operation.retain(bodyLength - position);
	return operation;
}

export interface MergeResult {
	/** Operation to send, based on the server document (null: nothing to send). */
	toServer: TextOperation | null;
	/** The merged text; the editor should end up with this. */
	merged: string;
}

/**
 * Three-way merge after a period without a connection: `base` is the last
 * document both sides agreed on, `local` what the editor has now, `remote`
 * what the server has now. Non-overlapping edits from both sides survive.
 */
export function mergeDivergent(base: string, local: string, remote: string): MergeResult {
	if (local === remote) return {toServer: null, merged: remote};
	if (local === base) return {toServer: null, merged: remote};
	if (remote === base) return {toServer: diffToOperation(remote, local), merged: local};
	const localOp = diffToOperation(base, local);
	const remoteOp = diffToOperation(base, remote);
	const [localPrime] = TextOperation.transform(localOp, remoteOp);
	return {toServer: localPrime, merged: localPrime.apply(remote)};
}
