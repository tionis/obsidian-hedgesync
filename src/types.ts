export interface HedgeDocReference {
	serverUrl: string;
	noteId: string;
	url: string;
}

export interface MarkdownParts {
	frontmatterBlock: string | null;
	body: string;
}
