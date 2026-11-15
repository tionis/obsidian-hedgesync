import {strict as assert} from "node:assert";
import {test} from "node:test";
import {diffToOperation, TextOperation} from "hedgesync/obsidian";
import {changesFromOperation, type EditorChange, mergeDivergent, operationFromChanges} from "../src/live/operations";

/** Apply changes given in pre-change coordinates, as CodeMirror does. */
export function applyChanges(text: string, changes: EditorChange[]): string {
	return [...changes].sort((a, b) => b.from - a.from).reduce((t, c) => t.slice(0, c.from) + c.insert + t.slice(c.to), text);
}

const FM = "---\nhedgedoc: x\n---\n";

test("an operation becomes editor changes after the front matter", () => {
	const body = "hello world\nsecond line\n";
	const target = "hello brave world\nline two\n";
	const op = diffToOperation(body, target);
	assert.equal(applyChanges(FM + body, changesFromOperation(op, FM.length)), FM + target);
});

test("random edits round-trip through editor changes", () => {
	const alphabet = "ab\n ";
	for (let i = 0; i < 300; i++) {
		const random = (n: number) => Array.from({length: n}, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
		const a = random(Math.floor(Math.random() * 30));
		const b = random(Math.floor(Math.random() * 30));
		const op = diffToOperation(a, b);
		const changes = changesFromOperation(op, FM.length);
		assert.equal(applyChanges(FM + a, changes), FM + b);
		const back = operationFromChanges(changes, FM.length, a.length);
		assert.ok(back !== null);
		assert.equal(back.apply(a), b);
	}
});

test("changes touching the front matter yield no operation", () => {
	assert.equal(operationFromChanges([{from: 3, to: 5, insert: "x"}], FM.length, 10), null);
	const op = operationFromChanges([{from: FM.length, to: FM.length, insert: "# "}], FM.length, 5);
	assert.deepEqual(op?.toJSON(), ["# ", 5]);
});

test("three-way merge keeps edits from both sides", () => {
	const base = "one\ntwo\nthree\n";
	const local = "one\ntwo (local)\nthree\n";
	const remote = "zero\none\ntwo\nthree\n";
	const result = mergeDivergent(base, local, remote);
	assert.equal(result.merged, "zero\none\ntwo (local)\nthree\n");
	assert.ok(result.toServer instanceof TextOperation);
	assert.equal(result.toServer.apply(remote), result.merged);
	assert.deepEqual(mergeDivergent(base, base, remote), {toServer: null, merged: remote});
	assert.equal(mergeDivergent(base, local, base).merged, local);
});
