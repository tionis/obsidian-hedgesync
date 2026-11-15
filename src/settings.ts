import {App, Notice, Plugin, PluginSettingTab, Setting} from "obsidian";
import type {AccountManager} from "./accounts";
import {displayServer, serverKey, serverUrlProblem} from "./server-key";

export {serverKey};

/** A HedgeDoc login, stored per server. */
export interface StoredSession {
	/**
	 * Cookie header value, e.g. "connect.sid=s%3A...". Only kept here when
	 * Obsidian's secret storage is unavailable; otherwise see secretId.
	 */
	cookie?: string;
	/** ID of the cookie in Obsidian's secret storage. */
	secretId?: string;
	/** Account the cookie belonged to when last checked. */
	user?: {id: string; name: string};
	/** "login": from the login window; "manual": pasted in settings. */
	source: "login" | "manual";
	savedAt: string;
	/** Last time the server was asked about this session. */
	checkedAt?: string;
	/** Result of that check. */
	status?: "ok" | "expired" | "unreachable";
	/** Error detail for status "unreachable". */
	error?: string;
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
		const cookie = typeof session?.cookie === "string" ? session.cookie.trim() : "";
		if (cookie.length > 0) {
			sessions[key] = {...session, cookie};
		} else if (typeof session?.secretId === "string" && session.secretId.length > 0) {
			const rest = {...session};
			delete rest.cookie;
			sessions[key] = rest;
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

function defaultServerProblem(value: string): string | null {
	return value.length === 0 ? null : serverUrlProblem(value);
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
	accounts: AccountManager;
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

		const serverSetting = new Setting(containerEl)
			.setName("Default hedgedoc server URL")
			.setDesc(defaultServerProblem(settings.defaultServerUrl)
				?? "Used for new documents and for links that store only a note ID. Requires hedgedoc 1.10.4 or newer.")
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
		if (defaultServerProblem(settings.defaultServerUrl) !== null) serverSetting.descEl.addClass("mod-warning");

		this.displayAccounts(containerEl);

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

	private displayAccounts(containerEl: HTMLElement): void {
		const accounts = this.plugin.accounts;
		new Setting(containerEl)
			.setName("Accounts")
			.setDesc("Public notes work without an account. Private notes and changing permissions need one. Each account is only used for its own server.")
			.setHeading();
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: accounts.usesSecretStorage()
				? "Session cookies are kept in Obsidian's secret storage, not in the plugin's data file. Sessions are checked, and thereby kept alive, in the background every few hours."
				: `Session cookies are kept in this vault's plugin data file (${this.app.vault.configDir}/plugins/hedgesync/data.json); Obsidian 1.11.4 or newer keeps them in its secret storage instead. Sessions are checked, and thereby kept alive, in the background every few hours.`,
		});

		for (const account of accounts.list()) {
			const {key, session} = account;
			const row = new Setting(containerEl).setName(displayServer(key) + (account.isDefault ? " (default)" : ""));
			const status = describeSession(session);
			row.setDesc(status.text);
			if (status.warning) row.descEl.addClass("mod-warning");

			row.addExtraButton((button) => button
				.setIcon("refresh-cw")
				.setTooltip("Check whether the session is still valid")
				.onClick(async () => {
					button.setDisabled(true);
					const checked = await accounts.check(key);
					if (checked !== undefined) new Notice(`${displayServer(key)}: ${describeSession(checked).text}`);
					this.display();
				}));
			if (accounts.canUseLoginWindow()) {
				row.addExtraButton((button) => button
					.setIcon("log-in")
					.setTooltip("Log in again")
					.onClick(async () => {
						if (await accounts.logIn(key)) this.display();
					}));
			}
			row.addExtraButton((button) => button
				.setIcon(session.source === "login" ? "log-out" : "trash-2")
				.setTooltip(session.source === "login" ? "Log out (ends the session on the server)" : "Forget this cookie (your browser stays logged in)")
				.onClick(async () => {
					await accounts.remove(key);
					new Notice(session.source === "login" ? `Logged out of ${displayServer(key)}.` : `Forgot the session for ${displayServer(key)}.`);
					this.display();
				}));
		}

		const defaultUrl = this.plugin.settings.defaultServerUrl;
		const suggested = defaultUrl.length > 0 && accounts.get(defaultUrl) === undefined ? defaultUrl : "";
		new Setting(containerEl)
			.setName(accounts.list().length === 0 ? "No accounts yet" : "Add another account")
			.addButton((button) => button
				.setButtonText("Add account")
				.setCta()
				.onClick(() => accounts.openAddAccount(suggested, () => this.display())));
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

function describeSession(session: StoredSession): {text: string; warning: boolean} {
	const who = session.user !== undefined ? session.user.name : "unknown account";
	const how = session.source === "login" ? "logged in" : "browser cookie";
	const checked = session.checkedAt !== undefined ? `, checked ${timeAgo(session.checkedAt)}` : "";
	switch (session.status) {
		case "expired":
			return {text: `Session expired (${who}). Log in again.`, warning: true};
		case "unreachable":
			return {text: `Could not reach the server${checked}: ${session.error ?? "unknown error"}`, warning: true};
		default:
			return {text: `${who} (${how}${checked})`, warning: false};
	}
}

function timeAgo(iso: string): string {
	const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
	if (!Number.isFinite(seconds) || seconds < 60) return "just now";
	for (const [size, unit] of [[86400, "day"], [3600, "hour"], [60, "minute"]] as const) {
		if (seconds >= size) {
			const n = Math.floor(seconds / size);
			return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
		}
	}
	return "just now";
}
