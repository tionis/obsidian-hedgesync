import {strict as assert} from "node:assert";
import {test} from "node:test";
import {bodyOffset, mergeMarkdownContent, splitMarkdownContent} from "../src/markdown";

test("splits front matter from the body", () => {
	assert.deepEqual(splitMarkdownContent("---\nhedgedoc: x\n---\n# Hi\n"), {frontmatterBlock: "---\nhedgedoc: x\n---\n", body: "# Hi\n"});
	assert.deepEqual(splitMarkdownContent("# No front matter"), {frontmatterBlock: null, body: "# No front matter"});
	assert.equal(bodyOffset("---\na: 1\n---\nbody"), "---\na: 1\n---\n".length);
});

test("handles empty front matter and a closing line at the end of the file", () => {
	assert.deepEqual(splitMarkdownContent("---\n---\ntext"), {frontmatterBlock: "---\n---\n", body: "text"});
	assert.deepEqual(splitMarkdownContent("---\na: 1\n---"), {frontmatterBlock: "---\na: 1\n---", body: ""});
	assert.deepEqual(splitMarkdownContent("---\r\na: 1\r\n---\r\nx"), {frontmatterBlock: "---\r\na: 1\r\n---\r\n", body: "x"});
});

test("merge puts the body back under the front matter", () => {
	const parts = splitMarkdownContent("---\na: 1\n---");
	assert.equal(mergeMarkdownContent(parts, "new"), "---\na: 1\n---\nnew");
	assert.equal(mergeMarkdownContent(splitMarkdownContent("old"), "new"), "new");
});
