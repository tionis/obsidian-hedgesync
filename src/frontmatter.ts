import {parseYaml} from "obsidian";
import type {MarkdownParts, HedgeDocReference} from "./types";

const FRONTMATTER_BLOCK_PATTERN = /^(---\r?\n[\s\S]*?\r?\n---\r?\n?)/;

type HedgeDocReferenceErrorCode =
	| "missing-frontmatter"
	| "missing-link-property"
	| "invalid-link-value";

export class HedgeDocReferenceError extends Error {
	readonly code: HedgeDocReferenceErrorCode;

	constructor(code: HedgeDocReferenceErrorCode, message: string) {
		super(message);
		this.name = "HedgeDocReferenceError";
		this.code = code;
	}
}

export interface ResolveReferenceOptions {
	linkProperty: string;
	defaultServerUrl: string;
}

export function splitMarkdownContent(markdown: string): MarkdownParts {
	const match = FRONTMATTER_BLOCK_PATTERN.exec(markdown);
	const frontmatterBlock = match?.[1];

	if (frontmatterBlock === undefined) {
		return {
			frontmatterBlock: null,
			body: markdown,
		};
	}

	return {
		frontmatterBlock,
		body: markdown.slice(frontmatterBlock.length),
	};
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

export function resolveHedgeDocReference(
	markdown: string,
	options: ResolveReferenceOptions,
): HedgeDocReference {
	const propertyName = options.linkProperty.trim();
	if (propertyName.length === 0) {
		throw new HedgeDocReferenceError("invalid-link-value", "Frontmatter link property is not configured.");
	}

	const parts = splitMarkdownContent(markdown);
	const frontmatter = parseFrontmatter(parts.frontmatterBlock);
	const value = frontmatter[propertyName];

	if (value === undefined || value === null || (typeof value === "string" && value.trim().length === 0)) {
		throw new HedgeDocReferenceError(
			"missing-link-property",
			`Frontmatter property "${propertyName}" is missing or empty.`,
		);
	}

	return resolveReferenceValue(value, options.defaultServerUrl);
}

function parseFrontmatter(frontmatterBlock: string | null): Record<string, unknown> {
	if (frontmatterBlock === null) {
		throw new HedgeDocReferenceError(
			"missing-frontmatter",
			"Note does not have frontmatter. Add a frontmatter block with a HedgeDoc link.",
		);
	}

	const frontmatterYaml = frontmatterBlock
		.replace(/^---\r?\n/, "")
		.replace(/\r?\n---\r?\n?$/, "");

	let parsedYaml: unknown;
	try {
		parsedYaml = parseYaml(frontmatterYaml);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new HedgeDocReferenceError(
			"invalid-link-value",
			`Could not parse YAML frontmatter: ${message}`,
		);
	}

	if (!isObject(parsedYaml)) {
		throw new HedgeDocReferenceError(
			"invalid-link-value",
			"Frontmatter must be a YAML object.",
		);
	}

	return parsedYaml;
}

function resolveReferenceValue(value: unknown, defaultServerUrl: string): HedgeDocReference {
	if (typeof value === "string") {
		const trimmedValue = value.trim();
		if (isHttpUrl(trimmedValue)) {
			return parseReferenceUrl(trimmedValue);
		}

		return buildReference(defaultServerUrl, trimmedValue);
	}

	if (isObject(value)) {
		const url = getOptionalString(value, "url")
			?? getOptionalString(value, "href")
			?? getOptionalString(value, "link");
		if (url !== null) {
			return parseReferenceUrl(url);
		}

		const noteId = getOptionalString(value, "noteId")
			?? getOptionalString(value, "id");
		if (noteId === null) {
			throw new HedgeDocReferenceError(
				"invalid-link-value",
				"Frontmatter link object must contain either a url or noteId/id field.",
			);
		}

		const serverUrl = getOptionalString(value, "serverUrl")
			?? getOptionalString(value, "server")
			?? defaultServerUrl;
		return buildReference(serverUrl, noteId);
	}

	throw new HedgeDocReferenceError(
		"invalid-link-value",
		"Frontmatter link value must be a string URL, note ID, or object with url/noteId.",
	);
}

function parseReferenceUrl(rawUrl: string): HedgeDocReference {
	let parsedUrl: URL;

	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		throw new HedgeDocReferenceError("invalid-link-value", `Invalid HedgeDoc URL: ${rawUrl}`);
	}

	const pathWithoutTrailingSlash = parsedUrl.pathname.replace(/\/+$/, "");
	const pathSegments = pathWithoutTrailingSlash.split("/").filter((segment) => segment.length > 0);
	const rawNoteId = pathSegments[pathSegments.length - 1];

	if (rawNoteId === undefined) {
		throw new HedgeDocReferenceError(
			"invalid-link-value",
			`Could not determine note ID from URL: ${rawUrl}`,
		);
	}

	const noteId = decodeURIComponent(rawNoteId);
	const serverPath = pathSegments.slice(0, -1).join("/");
	const serverUrl = normalizeServerUrl(`${parsedUrl.origin}${serverPath.length > 0 ? `/${serverPath}` : ""}`);

	return {
		serverUrl,
		noteId,
		url: `${serverUrl}/${encodeURIComponent(noteId)}`,
	};
}

function buildReference(serverUrl: string, noteId: string): HedgeDocReference {
	const normalizedNoteId = noteId.trim().replace(/^\/+/, "").replace(/\/+$/, "");
	if (normalizedNoteId.length === 0) {
		throw new HedgeDocReferenceError("invalid-link-value", "HedgeDoc note ID is empty.");
	}

	const normalizedServerUrl = normalizeServerUrl(serverUrl);

	return {
		serverUrl: normalizedServerUrl,
		noteId: normalizedNoteId,
		url: `${normalizedServerUrl}/${encodeURIComponent(normalizedNoteId)}`,
	};
}

function normalizeServerUrl(serverUrl: string): string {
	const trimmedValue = serverUrl.trim();
	if (trimmedValue.length === 0) {
		throw new HedgeDocReferenceError(
			"invalid-link-value",
			"Missing HedgeDoc server URL. Set a default server URL in plugin settings or use a full document URL in frontmatter.",
		);
	}

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(trimmedValue);
	} catch {
		throw new HedgeDocReferenceError(
			"invalid-link-value",
			`Invalid HedgeDoc server URL: ${trimmedValue}`,
		);
	}

	const normalizedPath = parsedUrl.pathname.replace(/\/+$/, "");
	return `${parsedUrl.origin}${normalizedPath === "/" ? "" : normalizedPath}`;
}

function getOptionalString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	if (typeof value !== "string") {
		return null;
	}

	const trimmedValue = value.trim();
	return trimmedValue.length > 0 ? trimmedValue : null;
}

function isHttpUrl(value: string): boolean {
	return /^https?:\/\//i.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
