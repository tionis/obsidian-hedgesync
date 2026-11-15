/**
 * Other people's cursors in a CodeMirror 6 editor: a colored caret with the
 * person's name. Positions move with edits until the next update arrives.
 *
 * Free of Obsidian imports.
 */

import {type EditorState, type Extension, RangeSet, StateEffect, StateField} from "@codemirror/state";
import {Decoration, type DecorationSet, EditorView, WidgetType} from "@codemirror/view";

export interface CursorMark {
	id: string;
	name: string;
	color: string | null;
	/** Offset in the editor document. */
	pos: number;
}

/** Replace all remote cursors of an editor. */
export const setRemoteCursors = StateEffect.define<CursorMark[]>();

class CaretWidget extends WidgetType {
	constructor(readonly mark: CursorMark, readonly stamp: number) {
		super();
	}

	eq(other: CaretWidget): boolean {
		return other.mark.id === this.mark.id
			&& other.mark.name === this.mark.name
			&& other.mark.color === this.mark.color
			&& other.stamp === this.stamp;
	}

	toDOM(view: EditorView): HTMLElement {
		// The editor's own document: popout windows have their own.
		const doc = view.dom.ownerDocument;
		const caret = doc.createDocumentFragment().createSpan({cls: "hedgesync-cursor", attr: {"aria-hidden": "true"}});
		// Only real colors from the server; anything else keeps the accent color.
		const color = this.mark.color;
		if (color !== null && doc.defaultView?.CSS.supports("color", color) === true) {
			caret.style.setProperty("--hedgesync-cursor-color", color);
		}
		caret.createSpan({cls: "hedgesync-cursor-label", text: this.mark.name});
		return caret;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

interface CursorState {
	marks: CursorMark[];
	/** Previous marks by id, to tell moved cursors (label shown again) from unchanged ones. */
	stamps: Map<string, {pos: number; stamp: number}>;
	decorations: DecorationSet;
}

let nextStamp = 0;

function build(marks: CursorMark[], previous: Map<string, {pos: number; stamp: number}>, docLength: number): CursorState {
	const stamps = new Map<string, {pos: number; stamp: number}>();
	const clamped = marks.map((mark) => ({...mark, pos: Math.max(0, Math.min(mark.pos, docLength))}));
	const ranges = clamped.map((mark) => {
		const before = previous.get(mark.id);
		const stamp = before !== undefined && before.pos === mark.pos ? before.stamp : ++nextStamp;
		stamps.set(mark.id, {pos: mark.pos, stamp});
		return Decoration.widget({widget: new CaretWidget(mark, stamp), side: 1}).range(mark.pos);
	});
	return {marks: clamped, stamps, decorations: RangeSet.of(ranges, true)};
}

export const remoteCursorField = StateField.define<CursorState>({
	create: () => ({marks: [], stamps: new Map(), decorations: Decoration.none}),
	update(value, tr) {
		let next = value;
		if (tr.docChanged) {
			// Keep cursors where they were in the text; stamps follow, so no label flash.
			const stamps = new Map<string, {pos: number; stamp: number}>();
			const marks = value.marks.map((mark) => {
				const pos = tr.changes.mapPos(mark.pos, 1);
				const before = value.stamps.get(mark.id);
				if (before !== undefined) stamps.set(mark.id, {pos, stamp: before.stamp});
				return {...mark, pos};
			});
			next = {marks, stamps, decorations: value.decorations.map(tr.changes)};
		}
		for (const effect of tr.effects) {
			if (effect.is(setRemoteCursors)) next = build(effect.value, next.stamps, tr.state.doc.length);
		}
		return next;
	},
	provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
});

export function remoteCursors(state: EditorState): CursorMark[] {
	return state.field(remoteCursorField, false)?.marks ?? [];
}

export const remoteCursorExtension: Extension = remoteCursorField;
