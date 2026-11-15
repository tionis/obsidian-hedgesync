import {App, Modal, Notice, Setting} from "obsidian";
import type {AccountManager} from "../accounts";
import {serverUrlProblem} from "../server-key";

/** Add an account: a server URL, then the login window or a pasted cookie. */
export class AccountModal extends Modal {
	private serverUrl: string;
	private cookie = "";

	constructor(
		app: App,
		private readonly accounts: AccountManager,
		initialUrl: string,
		private readonly onDone?: () => void,
	) {
		super(app);
		this.serverUrl = initialUrl;
	}

	onOpen(): void {
		this.setTitle("Add hedgedoc account");
		const {contentEl} = this;

		new Setting(contentEl)
			.setName("Server URL")
			.addText((text) => {
				text
					.setPlaceholder("https://md.example.com")
					.setValue(this.serverUrl)
					.onChange((value) => {
						this.serverUrl = value.trim();
					});
				text.inputEl.addClass("hedgesync-wide-input");
				window.setTimeout(() => text.inputEl.focus(), 0);
			});

		if (this.accounts.canUseLoginWindow()) {
			new Setting(contentEl)
				.setName("Log in")
				.setDesc("Sign in on the server's own login page, with any method it offers.")
				.addButton((button) => button
					.setButtonText("Log in")
					.setCta()
					.onClick(async () => {
						const problem = serverUrlProblem(this.serverUrl);
						if (problem !== null) {
							this.showError(problem);
							return;
						}
						this.close();
						if (await this.accounts.logIn(this.serverUrl)) this.onDone?.();
					}));
		}

		new Setting(contentEl)
			.setName("Or paste a session cookie")
			.setDesc("The value of the connect.sid cookie from a browser where you are logged in to this server.")
			.addTextArea((text) => {
				text
					.setPlaceholder("Paste the cookie value")
					.onChange((value) => {
						this.cookie = value;
					});
				text.inputEl.rows = 2;
				text.inputEl.addClass("hedgesync-wide-input");
			})
			.addButton((button) => button
				.setButtonText("Save cookie")
				.onClick(async () => {
					button.setDisabled(true);
					try {
						const user = await this.accounts.saveCookie(this.serverUrl, this.cookie);
						new Notice(`Saved the session of ${user.name}.`);
						this.close();
						this.onDone?.();
					} catch (error) {
						this.showError(error instanceof Error ? error.message : String(error));
					} finally {
						button.setDisabled(false);
					}
				}));

		contentEl.createDiv({cls: "hedgesync-account-error mod-warning"});
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private showError(message: string): void {
		const el = this.contentEl.querySelector(".hedgesync-account-error");
		if (el instanceof HTMLElement) el.setText(message);
	}
}
