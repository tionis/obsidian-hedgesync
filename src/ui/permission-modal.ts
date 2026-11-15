import {App, SuggestModal} from "obsidian";

export const PERMISSIONS = [
	{value: "freely", meaning: "Anyone can view and edit"},
	{value: "editable", meaning: "Anyone can view, signed-in users can edit"},
	{value: "limited", meaning: "Signed-in users can view and edit"},
	{value: "locked", meaning: "Anyone can view, only the owner can edit"},
	{value: "protected", meaning: "Signed-in users can view, only the owner can edit"},
	{value: "private", meaning: "Only the owner can view and edit"},
] as const;

type Permission = typeof PERMISSIONS[number];

/** Pick a note permission; resolves null when dismissed. */
export function choosePermission(app: App, current: string): Promise<string | null> {
	return new Promise((resolve) => new PermissionModal(app, current, resolve).open());
}

class PermissionModal extends SuggestModal<Permission> {
	private chosen = false;

	constructor(app: App, private readonly current: string, private readonly resolve: (value: string | null) => void) {
		super(app);
		this.setPlaceholder(`Choose who can view and edit this note (now: ${current || "unknown"})`);
	}

	getSuggestions(query: string): Permission[] {
		const q = query.toLowerCase();
		return PERMISSIONS.filter((p) => p.value.includes(q) || p.meaning.toLowerCase().includes(q));
	}

	renderSuggestion(permission: Permission, el: HTMLElement): void {
		el.createDiv({text: permission.value + (permission.value === this.current ? " (current)" : "")});
		el.createEl("small", {text: permission.meaning, cls: "hedgesync-suggestion-note"});
	}

	onChooseSuggestion(permission: Permission): void {
		this.chosen = true;
		this.resolve(permission.value);
	}

	onClose(): void {
		super.onClose();
		// onChooseSuggestion runs after onClose; wait a tick before reporting a dismissal.
		window.setTimeout(() => {
			if (!this.chosen) this.resolve(null);
		}, 0);
	}
}
