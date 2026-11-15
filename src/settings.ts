import {App, Notice, Plugin, PluginSettingTab, Setting} from "obsidian";
import {serverKey} from "./server-key";

export {serverKey};

/** A HedgeDoc login, stored per server. */
export interface StoredSession {
	/** Cookie header value, e.g. "connect.sid=s%3A...". */
	cookie: string;
	/** Account the cookie belonged to when last checked. */
	user?: {id: string; name: string};
	/** "login": from the login window; "manual": pasted in settings. */
	source: "login" | "manual";
	savedAt: string;
}

export interface HedgeSyncPluginSettings {
	defaultServerUrl: string;
	/** Logins keyed by serverKey(). A cookie is only ever sent to its own server. */
	sessions: Record<string, StoredSession>;
	frontmatterLinkProperty: string;
	autoPushOnSave: boolean;
	autoPushDebounceMs: number;
	requestTimeoutMs: number;
	warnBeforeOverwrite: boolean;
	/** Start live sync when a linked note is opened, stop when its last tab closes. */
	liveSyncAutoStart: boolean;
}

export const DEFAULT_SETTINGS: HedgeSyncPluginSettings = {
	defaultServerUrl: "",
	sessions: {},
	frontmatterLinkProperty: "hedgedoc",
	autoPushOnSave: false,
	autoPushDebounceMs: 1500,
	requestTimeoutMs: 15000,
	warnBeforeOverwrite: true,
	liveSyncAutoStart: false,
};

/** Settings as saved by 0.1.x, which had one cookie sent to every server. */
interface LegacySettings {
	sessionCookie?: string;
}

export function normalizeSettings(raw: Partial<HedgeSyncPluginSettings> & LegacySettings): HedgeSyncPluginSettings {
	const defaultServerUrl = (raw.defaultServerUrl ?? "").trim();
	const sessions: Record<string, StoredSession> = {};
	for (const [key, session] of Object.entries(raw.sessions ?? {})) {
		if (typeof session?.cookie === "string" && session.cookie.trim().length > 0) {
			sessions[key] = {...session, cookie: session.cookie.trim()};
		}
	}
	// 0.1.x: the single cookie belongs to the default server (the only server
	// it could sensibly be for). Without a default server it is dropped.
	const legacyCookie = (raw.sessionCookie ?? "").trim();
	if (legacyCookie.length > 0 && defaultServerUrl.length > 0 && sessions[serverKey(defaultServerUrl)] === undefined) {
		sessions[serverKey(defaultServerUrl)] = {cookie: legacyCookie, source: "manual", savedAt: new Date().toISOString()};
	}

	return {
		defaultServerUrl,
		sessions,
		frontmatterLinkProperty: (raw.frontmatterLinkProperty ?? "").trim() || DEFAULT_SETTINGS.frontmatterLinkProperty,
		autoPushOnSave: raw.autoPushOnSave ?? DEFAULT_SETTINGS.autoPushOnSave,
		autoPushDebounceMs: coerceNumber(raw.autoPushDebounceMs, DEFAULT_SETTINGS.autoPushDebounceMs, 200, 120000),
		requestTimeoutMs: coerceNumber(raw.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, 1000, 120000),
		warnBeforeOverwrite: raw.warnBeforeOverwrite ?? DEFAULT_SETTINGS.warnBeforeOverwrite,
		liveSyncAutoStart: raw.liveSyncAutoStart ?? DEFAULT_SETTINGS.liveSyncAutoStart,
	};
}

function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** What the settings tab needs from the plugin. */
export interface SettingsHost extends Plugin {
	settings: HedgeSyncPluginSettings;
	saveSettings(): Promise<void>;
	logIn(serverUrl: string): Promise<void>;
	/** Ask the server who the stored session belongs to; null if logged out. */
	checkSession(serverUrl: string): Promise<{id: string; name: string} | null>;
	logOut(serverUrl: string): Promise<void>;
	loginWindowAvailable(): boolean;
}

export class HedgeSyncSettingTab extends PluginSettingTab {
	private readonly plugin: SettingsHost;

	constructor(app: App, plugin: SettingsHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();
		const settings = this.plugin.settings;

		new Setting(containerEl)
			.setName("Default hedgedoc server URL")
			.setDesc("Used for new documents and for links that store only a note ID. Requires hedgedoc 1.10.4 or newer.")
			.addText((text) => {
				text
					.setPlaceholder("https://md.example.com")
					.setValue(settings.defaultServerUrl)
					.onChange(async (value) => {
						settings.defaultServerUrl = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.addEventListener("blur", () => this.display());
			});

		this.displayAccount(containerEl);

		new Setting(containerEl).setName("Sync").setHeading();

		new Setting(containerEl)
			.setName("Frontmatter link property")
			.setDesc("Frontmatter key that points to the hedgedoc note URL or note ID.")
			.addText((text) => text
				// eslint-disable-next-line obsidianmd/ui/sentence-case -- the default property name is lower-case.
				.setPlaceholder("hedgedoc")
				.setValue(settings.frontmatterLinkProperty)
				.onChange(async (value) => {
					settings.frontmatterLinkProperty = value.trim() || DEFAULT_SETTINGS.frontmatterLinkProperty;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Warn before overwrite")
			.setDesc("Ask before a manual push or pull replaces content that differs.")
			.addToggle((toggle) => toggle
				.setValue(settings.warnBeforeOverwrite)
				.onChange(async (value) => {
					settings.warnBeforeOverwrite = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName("Auto push on save")
			.setDesc("Push linked notes to hedgedoc when they change. Notes in live sync are always sent immediately.")
			.addToggle((toggle) => toggle
				.setValue(settings.autoPushOnSave)
				.onChange(async (value) => {
					settings.autoPushOnSave = value;
					await this.plugin.saveSettings();
					this.display();
				}));

		if (settings.autoPushOnSave) {
			this.numberSetting(containerEl, "Auto push delay (ms)", "Wait this long after the last change before pushing.", "autoPushDebounceMs", 200, 120000);
		}

		this.numberSetting(containerEl, "Request timeout (ms)", "How long to wait for the hedgedoc server.", "requestTimeoutMs", 1000, 120000);

		new Setting(containerEl).setName("Live sync").setHeading();

		new Setting(containerEl)
			.setName("Start automatically")
			.setDesc("Start live sync when a linked note is opened, and stop it when the note's last tab closes.")
			.addToggle((toggle) => toggle
				.setValue(settings.liveSyncAutoStart)
				.onChange(async (value) => {
					settings.liveSyncAutoStart = value;
					await this.plugin.saveSettings();
				}));
	}

	private displayAccount(containerEl: HTMLElement): void {
		const settings = this.plugin.settings;
		new Setting(containerEl).setName("Account").setHeading();

		const serverUrl = settings.defaultServerUrl;
		if (serverUrl.length === 0) {
			containerEl.createEl("p", {text: "Set a default server URL to log in.", cls: "setting-item-description"});
		} else {
			const key = serverKey(serverUrl);
			const session = settings.sessions[key];
			const status = new Setting(containerEl)
				.setName("Login")
				.setDesc(session === undefined
					? "Not logged in. Public notes work without a login; private notes and changing permissions need one."
					: session.user !== undefined ? `Logged in as ${session.user.name}.` : "A session cookie is saved.");

			if (this.plugin.loginWindowAvailable()) {
				status.addButton((button) => button
					.setButtonText(session === undefined ? "Log in" : "Log in again")
					.setCta()
					.onClick(async () => {
						await this.plugin.logIn(serverUrl);
						this.display();
					}));
			}
			if (session !== undefined) {
				status.addButton((button) => button
					.setButtonText("Check")
					.onClick(async () => {
						button.setDisabled(true);
						try {
							const user = await this.plugin.checkSession(serverUrl);
							new Notice(user !== null ? `Logged in as ${user.name}.` : "The session has expired. Log in again.");
						} catch (error) {
							new Notice(`Could not check the session: ${error instanceof Error ? error.message : String(error)}`);
						}
						this.display();
					}));
				status.addButton((button) => button
					.setButtonText("Log out")
					.setWarning()
					.onClick(async () => {
						await this.plugin.logOut(serverUrl);
						this.display();
					}));
			}

			new Setting(containerEl)
				.setName("Session cookie")
				.setDesc("Alternative to logging in: paste the session cookie (connect.sid) from a browser where you are logged in. Stored in this vault's plugin data and sent only to this server.")
				.addTextArea((text) => {
					text
						.setPlaceholder("Paste the session cookie")
						.setValue(session?.cookie ?? "")
						.onChange(async (value) => {
							const cookie = value.trim();
							if (cookie.length === 0) {
								delete settings.sessions[key];
							} else if (cookie !== settings.sessions[key]?.cookie) {
								settings.sessions[key] = {cookie, source: "manual", savedAt: new Date().toISOString()};
							}
							await this.plugin.saveSettings();
						});
					text.inputEl.rows = 2;
				});
		}

		const others = Object.keys(settings.sessions).filter((key) => key !== serverKey(serverUrl));
		for (const key of others) {
			const session = settings.sessions[key];
			new Setting(containerEl)
				.setName(key)
				.setDesc(session?.user !== undefined ? `Logged in as ${session.user.name}.` : "Session cookie saved.")
				.addButton((button) => button
					.setButtonText("Forget")
					.onClick(async () => {
						delete settings.sessions[key];
						await this.plugin.saveSettings();
						this.display();
					}));
		}
	}

	private numberSetting(
		containerEl: HTMLElement,
		name: string,
		description: string,
		key: "autoPushDebounceMs" | "requestTimeoutMs",
		min: number,
		max: number,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(description)
			.addText((text) => text
				.setPlaceholder(String(DEFAULT_SETTINGS[key]))
				.setValue(String(this.plugin.settings[key]))
				.onChange(async (value) => {
					this.plugin.settings[key] = coerceNumber(Number.parseInt(value, 10), this.plugin.settings[key], min, max);
					await this.plugin.saveSettings();
				}));
	}
}
