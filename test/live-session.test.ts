import {strict as assert} from "node:assert";
import {test} from "node:test";
import {diffToOperation, type HedgeDocClient, TextOperation} from "hedgesync/obsidian";
import type {EditorChange} from "../src/live/operations";
import {type EditorPort, type LiveHost, LiveSession} from "../src/live/session";
import {applyChanges} from "./operations.test";

(globalThis as {window?: unknown}).window ??= globalThis;

const FM = "---\nhedgedoc: https://md.example.com/n\n---\n";
const reference = {serverUrl: "https://md.example.com", noteId: "n", url: "https://md.example.com/n"};

/** The parts of HedgeDocClient that LiveSession uses, with a scriptable server. */
class FakeClient {
	document = "";
	ready = false;
	editable = true;
	socket = {id: "me"};
	users: Array<{id: string; name: string; color?: string; cursor?: {line: number; ch: number} | null}> = [{id: "me", name: "Me"}, {id: "other", name: "Ada"}];
	sent: string[] = [];
	private handlers = new Map<string, Set<(...args: unknown[]) => void>>();

	constructor(private serverDocument: string) {}

	on(event: string, handler: (...args: unknown[]) => void) {
		if (!this.handlers.has(event)) this.handlers.set(event, new Set());
		this.handlers.get(event)!.add(handler);
	}
	off(event: string, handler: (...args: unknown[]) => void) {
		this.handlers.get(event)?.delete(handler);
	}
	emit(event: string, ...args: unknown[]) {
		for (const handler of [...(this.handlers.get(event) ?? [])]) handler(...args);
	}
	connect() {
		this.document = this.serverDocument;
		this.ready = true;
		this.emit("document", this.document);
		this.emit("ready");
		return Promise.resolve();
	}
	disconnect() {
		this.ready = false;
	}
	getDocument() {
		return this.document;
	}
	canEdit() {
		return this.editable;
	}
	getOnlineUsers() {
		return this.users;
	}
	applyOperation(operation: TextOperation) {
		if (!this.ready) throw new Error("not ready");
		assert.equal(operation.baseLength, this.document.length);
		this.sent.push(`op:${JSON.stringify(operation.toJSON())}`);
		this.document = operation.apply(this.document);
		this.emit("document", this.document);
		this.emit("change", {type: "local", operation});
	}
	updateContent(text: string) {
		if (!this.ready) throw new Error("not ready");
		if (text === this.document) return 0;
		this.sent.push(`diff:${text}`);
		this.document = text;
		this.emit("document", this.document);
		return 1;
	}
	setCursor(cursor: {line: number; ch: number} | null) {
		this.sent.push(cursor === null ? "cursor:blur" : `cursor:${cursor.line}:${cursor.ch}`);
	}
	/** Another user moves their cursor (null: blur). */
	remoteCursor(id: string, cursor: {line: number; ch: number} | null) {
		const user = this.users.find((u) => u.id === id)!;
		user.cursor = cursor;
		this.emit(cursor === null ? "cursor:blur" : "cursor:activity", cursor === null ? {id} : user);
	}
	/** Another user edits. */
	remote(text: string) {
		const operation = diffToOperation(this.document, text);
		this.document = text;
		this.emit("document", this.document);
		this.emit("change", {type: "remote", operation});
	}
	drop() {
		this.ready = false;
		this.emit("disconnect", "transport close");
	}
	/** Reconnect to a server that now has `serverDocument`. */
	reconnect(serverDocument: string) {
		this.document = serverDocument;
		this.ready = true;
		this.emit("document", this.document);
		this.emit("resync", {kind: "reset"});
		this.emit("ready");
	}
}

class FakeEditor implements EditorPort {
	remoteApplied = 0;
	constructor(public text: string, private session: () => LiveSession) {}
	getText() {
		return this.text;
	}
	applyRemote(changes: EditorChange[]) {
		this.remoteApplied++;
		this.text = applyChanges(this.text, changes);
	}
	/** The user types: replace [from, to) of the editor text. */
	type(from: number, to: number, insert: string) {
		const before = this.text;
		this.text = before.slice(0, from) + insert + before.slice(to);
		this.session().onEditorChange(before, this.text, [{from, to, insert}]);
	}
}

function setup(options: {local: string; remote: string; editor?: boolean}) {
	const client = new FakeClient(options.remote);
	let file = FM + options.local;
	const notices: string[] = [];
	let session!: LiveSession;
	const editor = options.editor === false ? null : new FakeEditor(FM + options.local, () => session);
	const host: LiveHost = {
		editors: () => (editor !== null ? [editor] : []),
		readFile: () => Promise.resolve(file),
		writeFile: (_path, transform) => {
			file = transform(file);
			return Promise.resolve();
		},
		notify: (message) => notices.push(message),
	};
	session = new LiveSession("note.md", reference, client as unknown as HedgeDocClient, host);
	return {client, editor, session, notices, file: () => file, setFile: (text: string) => (file = text)};
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("starting with local text sends it; remote text replaces the editor body", async () => {
	const a = setup({local: "local\n", remote: "remote\n"});
	await a.session.start(() => Promise.resolve("local"));
	assert.equal(a.client.document, "local\n");
	assert.equal(a.editor!.text, FM + "local\n");

	const b = setup({local: "local\n", remote: "remote\n"});
	await b.session.start(() => Promise.resolve("remote"));
	assert.equal(b.editor!.text, FM + "remote\n");
	assert.equal(b.client.sent.length, 0);
	assert.equal(b.session.state, "live");
});

test("typing is sent as operations; remote edits land after the front matter", async () => {
	const {client, editor, session} = setup({local: "hello\n", remote: "hello\n"});
	await session.start(() => Promise.resolve("remote"));
	editor!.type(FM.length + 5, FM.length + 5, " world");
	assert.equal(client.document, "hello world\n");
	assert.deepEqual(client.sent, ['op:[5," world",1]']);

	client.remote("# Title\nhello world\n");
	assert.equal(editor!.text, FM + "# Title\nhello world\n");
	editor!.type(FM.length, FM.length, "#");
	assert.equal(client.document, "## Title\nhello world\n");
});

test("editing the front matter is not sent", async () => {
	const {client, editor, session} = setup({local: "body", remote: "body"});
	await session.start(() => Promise.resolve("remote"));
	editor!.type(4, 4, "x");
	assert.equal(client.sent.length, 0);
	assert.equal(client.document, "body");
});

test("an editor that drifted is repaired by the next remote edit", async () => {
	const {client, editor, session} = setup({local: "a\nb\n", remote: "a\nb\n"});
	await session.start(() => Promise.resolve("remote"));
	editor!.text = FM + "a\nSTALE\n";
	client.remote("a\nb\nc\n");
	assert.equal(editor!.text, FM + "a\nb\nc\n");
});

test("edits made while offline are merged with remote edits on reconnect", async () => {
	const {client, editor, session} = setup({local: "one\ntwo\nthree\n", remote: "one\ntwo\nthree\n"});
	await session.start(() => Promise.resolve("remote"));
	client.drop();
	assert.equal(session.state, "offline");
	editor!.type(FM.length + 4, FM.length + 7, "TWO");
	assert.equal(client.sent.length, 0);
	client.reconnect("zero\none\ntwo\nthree\n");
	await tick();
	assert.equal(session.state, "live");
	assert.equal(client.document, "zero\none\nTWO\nthree\n");
	assert.equal(editor!.text, FM + "zero\none\nTWO\nthree\n");
});

test("without an editor, remote edits are written to the file and file edits are sent", async () => {
	const {client, session, file, setFile} = setup({local: "x\n", remote: "x\n", editor: false});
	await session.start(() => Promise.resolve("remote"));
	client.remote("x\ny\n");
	await tick(400);
	assert.equal(file(), FM + "x\ny\n");
	setFile(FM + "x\ny\nz\n");
	session.onFileChanged(file());
	assert.equal(client.document, "x\ny\nz\n");
});

test("read-only notes receive but do not send, with one notice", async () => {
	const {client, editor, session, notices} = setup({local: "r\n", remote: "r\n"});
	client.editable = false;
	await session.start(() => Promise.resolve("local"));
	assert.equal(session.state, "read-only");
	editor!.type(FM.length, FM.length, "a");
	editor!.type(FM.length, FM.length, "b");
	assert.equal(client.sent.length, 0);
	assert.equal(notices.length, 1);
	client.remote("r\ns\n");
	assert.equal(editor!.text, FM + "r\ns\n");
});

test("status lists the other users, not this connection", async () => {
	const {session} = setup({local: "", remote: ""});
	await session.start(() => Promise.resolve("remote"));
	assert.deepEqual(session.status().others.map((u) => u.name), ["Ada"]);
	session.stop();
	assert.equal(session.status().state, "stopped");
});

test("local cursor is sent debounced, relative to the body, without repeats", async () => {
	const {client, session} = setup({local: "ab\ncd", remote: "ab\ncd"});
	await session.start(() => Promise.resolve("remote"));
	const text = FM + "ab\ncd";
	session.setLocalCursor(text, FM.length + 1);
	session.setLocalCursor(text, FM.length + 4);
	assert.deepEqual(client.sent, []);
	await tick(150);
	assert.deepEqual(client.sent, ["cursor:1:1"]);
	session.setLocalCursor(text, FM.length + 4);
	await tick(150);
	assert.deepEqual(client.sent, ["cursor:1:1"]);
	session.setLocalCursor(text, 3); // in the front matter: hidden from others
	await tick(150);
	session.setLocalCursor(text, null);
	await tick(150);
	assert.deepEqual(client.sent, ["cursor:1:1", "cursor:blur"]);
	session.stop();
});

test("cursor is sent again after a reconnect, and not while offline", async () => {
	const {client, session} = setup({local: "abc", remote: "abc"});
	await session.start(() => Promise.resolve("remote"));
	session.setLocalCursor(FM + "abc", FM.length + 2);
	await tick(150);
	client.drop();
	session.setLocalCursor(FM + "abc", FM.length + 3);
	await tick(150);
	assert.deepEqual(client.sent, ["cursor:0:2"]);
	client.reconnect("abc");
	assert.deepEqual(client.sent, ["cursor:0:2", "cursor:0:3"]);
	session.stop();
});

test("remote cursors exclude this connection and blurred users, and vanish offline", async () => {
	const {client, session} = setup({local: "x", remote: "x"});
	let changes = 0;
	session.onCursors(() => changes++);
	await session.start(() => Promise.resolve("remote"));
	client.users[0]!.cursor = {line: 0, ch: 0}; // our own, as echoed in the users list
	client.users[1]!.color = "#f00";
	client.remoteCursor("other", {line: 0, ch: 1});
	assert.deepEqual(session.remoteCursors(), [{id: "other", name: "Ada", color: "#f00", cursor: {line: 0, ch: 1}}]);
	client.drop();
	assert.deepEqual(session.remoteCursors(), []);
	client.reconnect("x");
	assert.equal(session.remoteCursors().length, 1);
	client.remoteCursor("other", null);
	assert.deepEqual(session.remoteCursors(), []);
	assert.ok(changes >= 4);
	session.stop();
});
