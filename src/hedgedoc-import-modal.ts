import {App, Modal, Setting} from "obsidian";

export interface HedgeDocImportInput {
	referenceInput: string;
	targetPath: string;
}

interface HedgeDocImportDefaults {
	defaultFilePath: string;
}

export function requestHedgeDocImport(
	app: App,
	defaults: HedgeDocImportDefaults,
): Promise<HedgeDocImportInput | null> {
	return new Promise((resolve) => {
		const modal = new HedgeDocImportModal(app, defaults, resolve);
		modal.open();
	});
}

class HedgeDocImportModal extends Modal {
	private readonly defaults: HedgeDocImportDefaults;
	private readonly resolveResult: (value: HedgeDocImportInput | null) => void;
	private resolved = false;
	private referenceInput = "";
	private targetPath = "";

	constructor(
		app: App,
		defaults: HedgeDocImportDefaults,
		resolveResult: (value: HedgeDocImportInput | null) => void,
	) {
		super(app);
		this.defaults = defaults;
		this.resolveResult = resolveResult;
	}

	onOpen(): void {
		this.setTitle("Create note from hedgedoc");

		new Setting(this.contentEl)
			.setName("Hedgedoc URL or note ID")
			.setDesc("Use a full URL, or a note ID with default server configured.")
			.addText((text) => {
				text
					.setPlaceholder("https://md.example.com/abc123")
					.onChange((value) => {
						this.referenceInput = value.trim();
					});

				text.inputEl.focus();
			});

		new Setting(this.contentEl)
			.setName("Target note path")
			.setDesc("Path of the new Markdown note.")
			.addText((text) => {
				text
					.setPlaceholder(this.defaults.defaultFilePath)
					.setValue(this.defaults.defaultFilePath)
					.onChange((value) => {
						this.targetPath = value.trim();
					});
				this.targetPath = this.defaults.defaultFilePath;
			});

		new Setting(this.contentEl)
			.addButton((button) => {
				button
					.setButtonText("Cancel")
					.onClick(() => {
						this.finish(null);
						this.close();
					});
			})
			.addButton((button) => {
				button
					.setCta()
					.setButtonText("Create note")
					.onClick(() => {
						this.finish({
							referenceInput: this.referenceInput,
							targetPath: this.targetPath,
						});
						this.close();
					});
			});
	}

	onClose(): void {
		if (!this.resolved) {
			this.finish(null);
		}
	}

	private finish(value: HedgeDocImportInput | null): void {
		if (this.resolved) {
			return;
		}

		this.resolved = true;
		this.resolveResult(value);
	}
}
