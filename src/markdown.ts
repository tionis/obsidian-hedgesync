/**
 * Splitting a note into its front matter block and body. The body is what
 * gets synchronized; the front matter stays local. No Obsidian imports, so
 * it can be tested directly.
 */

import type {MarkdownParts} from "./types";

/** `---` line, optional YAML lines, closing `---` line (which may end the file). */
const FRONTMATTER_BLOCK_PATTERN = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

export function splitMarkdownContent(markdown: string): MarkdownParts {
	const match = FRONTMATTER_BLOCK_PATTERN.exec(markdown);
	if (match === null) {
		return {frontmatterBlock: null, body: markdown};
	}
	return {frontmatterBlock: match[0], body: markdown.slice(match[0].length)};
}

/** Length of the front matter block (0 without one): the editor offset of the body. */
export function bodyOffset(markdown: string): number {
	return splitMarkdownContent(markdown).frontmatterBlock?.length ?? 0;
}

export function mergeMarkdownContent(parts: MarkdownParts, body: string): string {
	if (parts.frontmatterBlock === null) {
		return body;
	}
	if (body.length === 0) {
		return parts.frontmatterBlock;
	}
	const separator = parts.frontmatterBlock.endsWith("\n") ? "" : "\n";
	return `${parts.frontmatterBlock}${separator}${body}`;
}
