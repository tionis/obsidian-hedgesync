import {strict as assert} from "node:assert";
import {test} from "node:test";
import {buildCatalog, fileNameFor, filterCatalog, filterLinked, linkedNotInHistory, mergeLinked, type RemoteNote} from "../src/browse/catalog";

const note = (id: string, text: string, time: number, extra: Partial<RemoteNote> = {}): RemoteNote => ({id, text, time, tags: [], pinned: false, ...extra});

test("matches server notes to vault notes on the same server only", () => {
	const catalog = buildCatalog("https://md.example.com/", [note("a", "A", 1), note("b", "B", 2)], [
		{path: "A.md", serverUrl: "https://MD.example.com", noteId: "a"},
		{path: "Copy of A.md", serverUrl: "https://md.example.com", noteId: "a"},
		{path: "Other.md", serverUrl: "https://other.example.com", noteId: "b"},
	]);
	assert.deepEqual(catalog.map((entry) => [entry.note.id, entry.paths]), [["b", []], ["a", ["A.md", "Copy of A.md"]]]);
});

test("sorts pinned notes first, then the most recently opened", () => {
	const catalog = buildCatalog("https://md.example.com", [note("old", "", 1), note("new", "", 3), note("pin", "", 0, {pinned: true})], []);
	assert.deepEqual(catalog.map((entry) => entry.note.id), ["pin", "new", "old"]);
});

test("filters by words in title, tags and path, and by presence in the vault", () => {
	const catalog = buildCatalog("https://md.example.com", [note("a", "Meeting notes", 2, {tags: ["work"]}), note("b", "Shopping", 1)], [
		{path: "Work/Meeting.md", serverUrl: "https://md.example.com", noteId: "a"},
	]);
	assert.deepEqual(filterCatalog(catalog, {query: "WORK meet", onlyMissing: false}).map((e) => e.note.id), ["a"]);
	assert.deepEqual(filterCatalog(catalog, {query: "", onlyMissing: true}).map((e) => e.note.id), ["b"]);
	assert.deepEqual(filterCatalog(catalog, {query: "meeting", onlyMissing: true}), []);
});

test("file names drop unsafe characters and fall back to the note ID", () => {
	assert.equal(fileNameFor(note("x", "a/b: c? [d]#e", 0)), "a b c d e");
	assert.equal(fileNameFor(note("x", "...hidden", 0)), "hidden");
	assert.equal(fileNameFor(note("x1", "Untitled", 0)), "x1");
	assert.equal(fileNameFor(note("x2", " / ", 0)), "x2");
});

test("finds vault notes on the server that are missing from the history", () => {
	const linked = [
		{path: "b.md", serverUrl: "https://md.example.com", noteId: "gone"},
		{path: "a.md", serverUrl: "https://md.example.com/", noteId: "never-opened"},
		{path: "c.md", serverUrl: "https://md.example.com", noteId: "known"},
		{path: "d.md", serverUrl: "https://other.example.com", noteId: "elsewhere"},
	];
	const missing = linkedNotInHistory("https://md.example.com", [note("known", "Known", 1)], linked);
	assert.deepEqual(missing.map((link) => link.path), ["a.md", "b.md"]);
	assert.deepEqual(filterLinked(missing, "GONE").map((link) => link.path), ["b.md"]);
});

test("a note just imported counts as in the vault before the metadata cache knows it", () => {
	const imported = [{path: "Title.md", serverUrl: "https://md.example.com", noteId: "a"}];
	const before = buildCatalog("https://md.example.com", [note("a", "Title", 1)], mergeLinked([], imported));
	assert.deepEqual(before[0]?.paths, ["Title.md"]);
	// Once indexed, the same file is not listed twice.
	const after = buildCatalog("https://md.example.com", [note("a", "Title", 1)], mergeLinked(imported, imported));
	assert.deepEqual(after[0]?.paths, ["Title.md"]);
});
