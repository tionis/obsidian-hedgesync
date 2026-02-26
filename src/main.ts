import {Plugin} from "obsidian";
import {HedgeDocSyncService} from "./hedgedoc-sync-service";
import {
	DEFAULT_SETTINGS,
	HedgeSyncPluginSettings,
	HedgeSyncSettingTab,
	normalizeSettings,
} from "./settings";
import {SyncManager} from "./sync-manager";

export default class ObsidianHedgeSyncPlugin extends Plugin {
	settings: HedgeSyncPluginSettings = {...DEFAULT_SETTINGS};
	private syncManager: SyncManager | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		const syncService = new HedgeDocSyncService(() => this.settings);
		this.syncManager = new SyncManager(this, syncService);
		this.syncManager.register();

		this.addSettingTab(new HedgeSyncSettingTab(this.app, this));
	}

	onunload(): void {
		this.syncManager?.dispose();
		this.syncManager = null;
	}

	async loadSettings(): Promise<void> {
		const persistedSettings = await this.loadData() as Partial<HedgeSyncPluginSettings> | null;
		this.settings = normalizeSettings({
			...DEFAULT_SETTINGS,
			...(persistedSettings ?? {}),
		});
	}

	async saveSettings(): Promise<void> {
		this.settings = normalizeSettings(this.settings);
		await this.saveData(this.settings);
	}
}
