import {App, Modal, Setting} from "obsidian";

export interface ConfirmationOptions {
	title: string;
	message: string;
	confirmText: string;
	cancelText: string;
}

export function requestConfirmation(app: App, options: ConfirmationOptions): Promise<boolean> {
	return new Promise((resolve) => {
		const modal = new ConfirmationModal(app, options, resolve);
		modal.open();
	});
}

class ConfirmationModal extends Modal {
	private readonly options: ConfirmationOptions;
	private readonly resolveResult: (value: boolean) => void;
	private resolved = false;

	constructor(app: App, options: ConfirmationOptions, resolveResult: (value: boolean) => void) {
		super(app);
		this.options = options;
		this.resolveResult = resolveResult;
	}

	onOpen(): void {
		this.setTitle(this.options.title);
		this.contentEl.createEl("p", {text: this.options.message});

		new Setting(this.contentEl)
			.addButton((button) => {
				button
					.setButtonText(this.options.cancelText)
					.onClick(() => {
						this.finish(false);
						this.close();
					});
			})
			.addButton((button) => {
				button
					.setCta()
					.setButtonText(this.options.confirmText)
					.onClick(() => {
						this.finish(true);
						this.close();
					});
			});
	}

	onClose(): void {
		if (!this.resolved) {
			this.finish(false);
		}
	}

	private finish(value: boolean): void {
		if (this.resolved) {
			return;
		}

		this.resolved = true;
		this.resolveResult(value);
	}
}
