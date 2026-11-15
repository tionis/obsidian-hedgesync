import {Notice, Plugin, type TFile} from "obsidian";
import {HedgeDocService} from "./hedgedoc-service";
import {LiveSyncManager} from "./live/manager";
import {AccountManager} from "./accounts";
import {CookieStore} from "./cookie-store";
import {
	DEFAULT_SETTINGS,
	type HedgeSyncPluginSettings,
	normalizeSettings,
} from "./settings";
import {HedgeSyncSettingTab, type SettingsHost} from "./ui/settings-tab";
import {SyncManager} from "./sync-manager";
import {LiveStatusBar} from "./ui/status-bar";

export default class ObsidianHedgeSyncPlugin extends Plugin implements SettingsHost {
	settings: HedgeSyncPluginSettings = {...DEFAULT_SETTINGS};
	private service!: HedgeDocService;
	accounts!: AccountManager;
	private live: LiveSyncManager | null = null;
	private sync: SyncManager | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.accounts = new AccountManager(this, new CookieStore(this.app));
		this.service = new HedgeDocService(() => this.settings, (serverUrl) => this.accounts.cookieFor(serverUrl));
		this.accounts.useService(this.service);
		await this.accounts.migrateCookies();
		this.accounts.startBackgroundChecks(this);
		const live = new LiveSyncManager(this, this.service);
		const sync = new SyncManager(this, this.service, live);
		this.live = live;
		this.sync = sync;
		live.register();
		sync.register();

		const statusBar = new LiveStatusBar(
			this.addStatusBarItem(),
			live,
			() => this.app.workspace.getActiveFile(),
			(file) => file.extension === "md" && sync.isLinked(file),
			(file) => void sync.toggleLive(file),
		);
		const render = () => statusBar.render();
		this.register(live.onStatusChange(render));
		this.registerEvent(this.app.workspace.on("file-open", render));
		this.registerEvent(this.app.metadataCache.on("changed", (file) => {
			// Unlinking a note (or pointing it elsewhere) ends its live sync.
			const reference = live.reference(file.path);
			if (reference !== null && !sync.isLinked(file)) {
				live.stop(file.path, `Live sync stopped for "${file.basename}" because it is no longer linked.`);
			}
			if (file === this.app.workspace.getActiveFile()) render();
		}));

		this.addSettingTab(new HedgeSyncSettingTab(this.app, this));
	}

	onunload(): void {
		this.live?.dispose();
		this.sync?.dispose();
		this.live = null;
		this.sync = null;
	}

	async loadSettings(): Promise<void> {
		const saved = await this.loadData() as Partial<HedgeSyncPluginSettings> | null;
		this.settings = normalizeSettings({...DEFAULT_SETTINGS, ...(saved ?? {})});
	}

	async saveSettings(): Promise<void> {
		// Normalize in place: the settings tab and services hold this object.
		Object.assign(this.settings, normalizeSettings(this.settings));
		await this.saveData(this.settings);
	}

	notify(message: string): void {
		new Notice(message);
	}

	async autoStartLiveSync(file: TFile): Promise<void> {
		if (this.sync === null || this.live === null || this.live.isLive(file.path) || !this.sync.isLinked(file)) return;
		await this.sync.startLive(file, true);
	}
}

