/**
 * The plugin's settings tab, built with Obsidian's declarative settings API
 * (1.13+), so every setting shows up in the settings search.
 */

import {type App, Notice, type Plugin, PluginSettingTab, type Setting, type SettingDefinitionItem, type SettingDefinitionPage} from "obsidian";
import type {Account, AccountManager} from "../accounts";
import {displayServer, serverKey, serverUrlProblem} from "../server-key";
import {DEFAULT_SETTINGS, type HedgeSyncPluginSettings, NUMBER_LIMITS, type StoredSession} from "../settings";

/** What the settings tab needs from the plugin. */
export interface SettingsHost extends Plugin {
	settings: HedgeSyncPluginSettings;
	saveSettings(): Promise<void>;
	accounts: AccountManager;
}

/** Settings edited through a control; accounts have their own page. */
type ControlKey = Exclude<keyof HedgeSyncPluginSettings, "sessions">;

const CONTROL_KEYS: readonly ControlKey[] = [
	"defaultServerUrl",
	"frontmatterLinkProperty",
	"autoPushOnSave",
	"autoPushDebounceMs",
	"requestTimeoutMs",
	"warnBeforeOverwrite",
	"liveSyncAutoStart",
];

function isControlKey(key: string): key is ControlKey {
	return (CONTROL_KEYS as readonly string[]).includes(key);
}

const EXAMPLE_SERVER_URL = "https://md.example.com";

export class HedgeSyncSettingTab extends PluginSettingTab {
	private readonly plugin: SettingsHost;

	constructor(app: App, plugin: SettingsHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getControlValue(key: string): unknown {
		return isControlKey(key) ? this.plugin.settings[key] : undefined;
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (!isControlKey(key)) return;
		// saveSettings normalizes (trims, clamps, fills in defaults).
		Object.assign(this.plugin.settings, {[key]: value});
		await this.plugin.saveSettings();
	}

	getSettingDefinitions(): SettingDefinitionItem<ControlKey>[] {
		const settings = this.plugin.settings;
		return [
			{
				name: "Default hedgedoc server URL",
				desc: "Used for new documents and for links that store only a note ID. Requires hedgedoc 1.10.4 or newer.",
				control: {
					type: "text",
					key: "defaultServerUrl",
					placeholder: EXAMPLE_SERVER_URL,
					validate: (value) => {
						const url = value.trim();
						return url.length === 0 ? undefined : serverUrlProblem(url) ?? undefined;
					},
				},
			},
			this.accountsPage(),
			{
				type: "group",
				heading: "Sync",
				items: [
					{
						name: "Frontmatter link property",
						desc: "Frontmatter key that points to the hedgedoc note URL or note ID.",
						control: {
							type: "text",
							key: "frontmatterLinkProperty",
							placeholder: DEFAULT_SETTINGS.frontmatterLinkProperty,
							defaultValue: DEFAULT_SETTINGS.frontmatterLinkProperty,
						},
					},
					{
						name: "Warn before overwrite",
						desc: "Ask before a manual push or pull replaces content that differs.",
						control: {type: "toggle", key: "warnBeforeOverwrite"},
					},
					{
						name: "Auto push on save",
						desc: "Push linked notes to hedgedoc when they change. Notes in live sync are always sent immediately.",
						control: {type: "toggle", key: "autoPushOnSave"},
					},
					{
						name: "Auto push delay (ms)",
						desc: "Wait this long after the last change before pushing.",
						visible: () => settings.autoPushOnSave,
						control: {
							type: "number",
							key: "autoPushDebounceMs",
							placeholder: String(DEFAULT_SETTINGS.autoPushDebounceMs),
							defaultValue: DEFAULT_SETTINGS.autoPushDebounceMs,
							...NUMBER_LIMITS.autoPushDebounceMs,
						},
					},
					{
						name: "Request timeout (ms)",
						desc: "How long to wait for the hedgedoc server.",
						control: {
							type: "number",
							key: "requestTimeoutMs",
							placeholder: String(DEFAULT_SETTINGS.requestTimeoutMs),
							defaultValue: DEFAULT_SETTINGS.requestTimeoutMs,
							...NUMBER_LIMITS.requestTimeoutMs,
						},
					},
				],
			},
			{
				type: "group",
				heading: "Live sync",
				items: [
					{
						name: "Start automatically",
						desc: "Start live sync when a linked note is opened, and stop it when the note's last tab closes.",
						control: {type: "toggle", key: "liveSyncAutoStart"},
					},
				],
			},
		];
	}

	private accountsPage(): SettingDefinitionPage<ControlKey> {
		const accounts = this.plugin.accounts;
		const list = accounts.list();
		return {
			type: "page",
			name: "Accounts",
			desc: "Public notes work without an account. Private notes and changing permissions need one. Each account is only used for its own server.",
			displayValue: () => {
				const count = accounts.list().length;
				return count === 0 ? "None" : `${count} ${count === 1 ? "account" : "accounts"}`;
			},
			status: () => accounts.list().some(({session}) => describeSession(session).warning) ? "warning" : null,
			items: [
				{
					name: "Session storage",
					desc: accounts.usesSecretStorage()
						? "Session cookies are kept in Obsidian's secret storage, not in the plugin's data file. Sessions are checked, and thereby kept alive, in the background every few hours."
						: `Session cookies are kept in this vault's plugin data file (${this.app.vault.configDir}/plugins/hedgesync/data.json). Sessions are checked, and thereby kept alive, in the background every few hours.`,
				},
				{
					type: "list",
					heading: "Saved accounts",
					emptyState: "No accounts yet.",
					addItem: {
						name: "Add account",
						action: () => accounts.openAddAccount(this.suggestedServer(), () => this.update()),
					},
					items: list.map((account) => ({
						name: displayServer(account.key),
						desc: describeSession(account.session).text,
						render: (setting: Setting) => this.renderAccount(setting, account),
					})),
				},
			],
		};
	}

	private renderAccount(setting: Setting, {key, session}: Account): void {
		const accounts = this.plugin.accounts;
		const defaultUrl = this.plugin.settings.defaultServerUrl;
		const isDefault = defaultUrl.length > 0 && serverKey(defaultUrl) === key;
		setting.setName(displayServer(key) + (isDefault ? " (default)" : ""));
		const status = describeSession(session);
		setting.setDesc(status.text);
		setting.descEl.toggleClass("mod-warning", status.warning);

		setting.addExtraButton((button) => button
			.setIcon("refresh-cw")
			.setTooltip("Check whether the session is still valid")
			.onClick(async () => {
				button.setDisabled(true);
				const checked = await accounts.check(key);
				if (checked !== undefined) new Notice(`${displayServer(key)}: ${describeSession(checked).text}`);
				this.update();
			}));
		if (accounts.canUseLoginWindow()) {
			setting.addExtraButton((button) => button
				.setIcon("log-in")
				.setTooltip("Log in again")
				.onClick(async () => {
					if (await accounts.logIn(key)) this.update();
				}));
		}
		setting.addExtraButton((button) => button
			.setIcon(session.source === "login" ? "log-out" : "trash-2")
			.setTooltip(session.source === "login" ? "Log out (ends the session on the server)" : "Forget this cookie (your browser stays logged in)")
			.onClick(async () => {
				await accounts.remove(key);
				new Notice(session.source === "login" ? `Logged out of ${displayServer(key)}.` : `Forgot the session for ${displayServer(key)}.`);
				this.update();
			}));
	}

	/** The default server, when it has no account yet. */
	private suggestedServer(): string {
		const defaultUrl = this.plugin.settings.defaultServerUrl;
		return defaultUrl.length > 0 && this.plugin.accounts.get(defaultUrl) === undefined ? defaultUrl : "";
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
