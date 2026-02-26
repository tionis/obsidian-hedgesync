import {App, Plugin, PluginSettingTab, Setting} from "obsidian";

export interface HedgeSyncPluginSettings {
	defaultServerUrl: string;
	sessionCookie: string;
	frontmatterLinkProperty: string;
	autoPushOnSave: boolean;
	autoPushDebounceMs: number;
	requestTimeoutMs: number;
	loopProtectionWindowMs: number;
	liveSyncPullIntervalMs: number;
	liveSyncPushDebounceMs: number;
	warnBeforeOverwrite: boolean;
	showQuickActionButtons: boolean;
}

export const DEFAULT_SETTINGS: HedgeSyncPluginSettings = {
	defaultServerUrl: "",
	sessionCookie: "",
	frontmatterLinkProperty: "hedgedoc",
	autoPushOnSave: false,
	autoPushDebounceMs: 1500,
	requestTimeoutMs: 15000,
	loopProtectionWindowMs: 4000,
	liveSyncPullIntervalMs: 5000,
	liveSyncPushDebounceMs: 800,
	warnBeforeOverwrite: true,
	showQuickActionButtons: true,
};

export function normalizeSettings(settings: Partial<HedgeSyncPluginSettings>): HedgeSyncPluginSettings {
	return {
		defaultServerUrl: (settings.defaultServerUrl ?? "").trim(),
		sessionCookie: (settings.sessionCookie ?? "").trim(),
		frontmatterLinkProperty: (settings.frontmatterLinkProperty ?? DEFAULT_SETTINGS.frontmatterLinkProperty).trim() || DEFAULT_SETTINGS.frontmatterLinkProperty,
		autoPushOnSave: settings.autoPushOnSave ?? DEFAULT_SETTINGS.autoPushOnSave,
		autoPushDebounceMs: coerceNumber(
			settings.autoPushDebounceMs,
			DEFAULT_SETTINGS.autoPushDebounceMs,
			200,
			120000,
		),
		requestTimeoutMs: coerceNumber(
			settings.requestTimeoutMs,
			DEFAULT_SETTINGS.requestTimeoutMs,
			1000,
			120000,
		),
		loopProtectionWindowMs: coerceNumber(
			settings.loopProtectionWindowMs,
			DEFAULT_SETTINGS.loopProtectionWindowMs,
			500,
			30000,
		),
		liveSyncPullIntervalMs: coerceNumber(
			settings.liveSyncPullIntervalMs,
			DEFAULT_SETTINGS.liveSyncPullIntervalMs,
			1000,
			120000,
		),
		liveSyncPushDebounceMs: coerceNumber(
			settings.liveSyncPushDebounceMs,
			DEFAULT_SETTINGS.liveSyncPushDebounceMs,
			200,
			120000,
		),
		warnBeforeOverwrite: settings.warnBeforeOverwrite ?? DEFAULT_SETTINGS.warnBeforeOverwrite,
		showQuickActionButtons: settings.showQuickActionButtons ?? DEFAULT_SETTINGS.showQuickActionButtons,
	};
}

function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}

	return Math.min(max, Math.max(min, Math.floor(value)));
}

interface SettingsPlugin extends Plugin {
	settings: HedgeSyncPluginSettings;
	saveSettings(): Promise<void>;
}

export class HedgeSyncSettingTab extends PluginSettingTab {
	private readonly plugin: SettingsPlugin;

	constructor(app: App, plugin: SettingsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Default hedgedoc server URL")
			.setDesc("Used when the note frontmatter stores only a hedgedoc note ID.")
			.addText((text) => {
				text
					.setPlaceholder("https://md.example.com")
					.setValue(this.plugin.settings.defaultServerUrl)
					.onChange(async (value) => {
						this.plugin.settings.defaultServerUrl = value.trim();
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Session cookie")
			.setDesc("Optional hedgedoc session cookie (connect.sid=...) for private notes.")
			.addTextArea((text) => {
				text
					.setPlaceholder("Enter session cookie")
					.setValue(this.plugin.settings.sessionCookie)
					.onChange(async (value) => {
						this.plugin.settings.sessionCookie = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.rows = 2;
			});

		new Setting(containerEl)
			.setName("Frontmatter link property")
			.setDesc("Frontmatter key that points to the hedgedoc note URL or note ID.")
			.addText((text) => {
				text
					.setPlaceholder("Enter frontmatter key")
					.setValue(this.plugin.settings.frontmatterLinkProperty)
					.onChange(async (value) => {
						const trimmed = value.trim();
						this.plugin.settings.frontmatterLinkProperty = trimmed || DEFAULT_SETTINGS.frontmatterLinkProperty;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Auto push on save")
			.setDesc("Automatically push linked notes to hedgedoc when files are modified.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.autoPushOnSave)
					.onChange(async (value) => {
						this.plugin.settings.autoPushOnSave = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		new Setting(containerEl)
			.setName("Auto push debounce (ms)")
			.setDesc("Delay before an automatic push starts after file changes.")
			.addText((text) => {
				text
					.setPlaceholder("1500")
					.setValue(String(this.plugin.settings.autoPushDebounceMs))
					.onChange(async (value) => {
						const parsedValue = Number.parseInt(value, 10);
						this.plugin.settings.autoPushDebounceMs = coerceNumber(
							parsedValue,
							this.plugin.settings.autoPushDebounceMs,
							200,
							120000,
						);
						await this.plugin.saveSettings();
					});
				text.setDisabled(!this.plugin.settings.autoPushOnSave);
			});

		new Setting(containerEl)
			.setName("Request timeout (ms)")
			.setDesc("Timeout used for hedgedoc connect and sync operations.")
			.addText((text) => {
				text
					.setPlaceholder("15000")
					.setValue(String(this.plugin.settings.requestTimeoutMs))
					.onChange(async (value) => {
						const parsedValue = Number.parseInt(value, 10);
						this.plugin.settings.requestTimeoutMs = coerceNumber(
							parsedValue,
							this.plugin.settings.requestTimeoutMs,
							1000,
							120000,
						);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Warn before overwrite")
			.setDesc("Ask for confirmation before manual pull or push overwrites different content.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.warnBeforeOverwrite)
					.onChange(async (value) => {
						this.plugin.settings.warnBeforeOverwrite = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Live sync pull interval (ms)")
			.setDesc("How often live sync pulls updates from hedgedoc for the active note.")
			.addText((text) => {
				text
					.setPlaceholder("5000")
					.setValue(String(this.plugin.settings.liveSyncPullIntervalMs))
					.onChange(async (value) => {
						const parsedValue = Number.parseInt(value, 10);
						this.plugin.settings.liveSyncPullIntervalMs = coerceNumber(
							parsedValue,
							this.plugin.settings.liveSyncPullIntervalMs,
							1000,
							120000,
						);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Live sync push debounce (ms)")
			.setDesc("Delay before live sync pushes local changes after edits.")
			.addText((text) => {
				text
					.setPlaceholder("800")
					.setValue(String(this.plugin.settings.liveSyncPushDebounceMs))
					.onChange(async (value) => {
						const parsedValue = Number.parseInt(value, 10);
						this.plugin.settings.liveSyncPushDebounceMs = coerceNumber(
							parsedValue,
							this.plugin.settings.liveSyncPushDebounceMs,
							200,
							120000,
						);
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Show quick action buttons")
			.setDesc("Show push, pull, and live sync buttons in the left ribbon for linked notes.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showQuickActionButtons)
					.onChange(async (value) => {
						this.plugin.settings.showQuickActionButtons = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
