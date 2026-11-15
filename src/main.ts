import {Notice, Plugin, type TFile} from "obsidian";
import {HedgeDocService} from "./hedgedoc-service";
import {LiveSyncManager} from "./live/manager";
import {loginWindowAvailable, logInWithWindow} from "./login";
import {
	DEFAULT_SETTINGS,
	type HedgeSyncPluginSettings,
	HedgeSyncSettingTab,
	normalizeSettings,
	serverKey,
	type SettingsHost,
} from "./settings";
import {errorMessage, SyncManager} from "./sync-manager";
import {LiveStatusBar} from "./ui/status-bar";

export default class ObsidianHedgeSyncPlugin extends Plugin implements SettingsHost {
	settings: HedgeSyncPluginSettings = {...DEFAULT_SETTINGS};
	private service!: HedgeDocService;
	private live: LiveSyncManager | null = null;
	private sync: SyncManager | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.service = new HedgeDocService(() => this.settings);
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
		this.settings = normalizeSettings(this.settings);
		await this.saveData(this.settings);
	}

	notify(message: string): void {
		new Notice(message);
	}

	async autoStartLiveSync(file: TFile): Promise<void> {
		if (this.sync === null || this.live === null || this.live.isLive(file.path) || !this.sync.isLinked(file)) return;
		await this.sync.startLive(file, true);
	}

	// ------------------------------------------------------------------
	// Accounts
	// ------------------------------------------------------------------

	loginWindowAvailable(): boolean {
		return loginWindowAvailable();
	}

	async logIn(serverUrl: string): Promise<void> {
		try {
			const result = await logInWithWindow(serverUrl, (cookie) => this.service.whoAmI(serverUrl, cookie));
			if (result === null) return;
			this.settings.sessions[serverKey(serverUrl)] = {
				cookie: result.cookie,
				user: result.user,
				source: "login",
				savedAt: new Date().toISOString(),
			};
			await this.saveSettings();
			new Notice(`Logged in to ${new URL(serverUrl).host} as ${result.user.name}.`);
		} catch (error) {
			new Notice(`Login failed: ${errorMessage(error)}`);
		}
	}

	async checkSession(serverUrl: string): Promise<{id: string; name: string} | null> {
		const key = serverKey(serverUrl);
		const session = this.settings.sessions[key];
		if (session === undefined) return null;
		const user = await this.service.whoAmI(serverUrl);
		if (user !== null) {
			session.user = user;
		} else {
			delete session.user;
		}
		await this.saveSettings();
		return user;
	}

	async logOut(serverUrl: string): Promise<void> {
		const key = serverKey(serverUrl);
		const session = this.settings.sessions[key];
		if (session === undefined) return;
		// A pasted cookie is the browser's own session: ending it would log the
		// browser out too, so only forget it. Sessions from the login window
		// belong to the plugin and are ended on the server.
		if (session.source === "login") {
			await this.service.endSession(serverUrl).catch((error: unknown) => {
				console.warn("[hedgesync] could not end the session on the server", error);
			});
		}
		delete this.settings.sessions[key];
		await this.saveSettings();
		new Notice(`Logged out of ${serverKey(serverUrl)}.`);
	}
}
