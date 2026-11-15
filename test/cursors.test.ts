import {strict as assert} from "node:assert";
import {test} from "node:test";
import {EditorState} from "@codemirror/state";
import {remoteCursorField, remoteCursors, setRemoteCursors} from "../src/live/cursors";

const ada = {id: "a", name: "Ada", color: "#f00"};

test("remote cursors are set, follow edits and are clamped", () => {
	let state = EditorState.create({doc: "hello world", extensions: [remoteCursorField]});
	state = state.update({effects: setRemoteCursors.of([{...ada, pos: 6}, {id: "b", name: "Bo", color: null, pos: 99}])}).state;
	assert.deepEqual(remoteCursors(state).map((m) => m.pos), [6, 11]);
	assert.equal(state.field(remoteCursorField).decorations.size, 2);
	// Text inserted before a cursor moves it; text typed at the cursor stays before it.
	state = state.update({changes: {from: 0, insert: ">> "}}).state;
	state = state.update({changes: {from: 9, insert: "big "}}).state;
	assert.equal(remoteCursors(state)[0]!.pos, 13);
	assert.equal(state.doc.sliceString(13), "world");
	state = state.update({effects: setRemoteCursors.of([])}).state;
	assert.equal(state.field(remoteCursorField).decorations.size, 0);
});
