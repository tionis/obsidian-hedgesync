/**
 * HedgeDoc accounts: one stored session per server, added through the login
 * window or by pasting a browser cookie, checked against the server, and
 * removed again. A session is only ever sent to its own server.
 */

import {App, Notice, type Plugin} from "obsidian";
import {normalizeCookie} from "hedgesync/obsidian";
import type {CookieStore} from "./cookie-store";
import {isAccessError} from "./errors";
import type {HedgeDocService} from "./hedgedoc-service";
import {loginWindowAvailable, logInWithWindow} from "./login";
import {displayServer, serverKey, serverUrlProblem} from "./server-key";
import type {HedgeSyncPluginSettings, StoredSession} from "./settings";
import {AccountModal} from "./ui/account-modal";

interface AccountHost {
	app: App;
	settings: HedgeSyncPluginSettings;
	saveSettings(): Promise<void>;
}

export type Account = {key: string; session: StoredSession; isDefault: boolean};

/** First background check after startup, then every few hours. */
const STARTUP_CHECK_DELAY_MS = 30_000;
const BACKGROUND_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const ACCOUNTS_HINT = "Settings → Hedgesync → Accounts";

export class AccountManager {
	private service!: HedgeDocService;

	constructor(private readonly host: AccountHost, private readonly cookies: CookieStore) {}

	/** The service needs this manager for cookies, so it is connected after construction. */
	useService(service: HedgeDocService): void {
		this.service = service;
	}

	/** The saved session cookie for a server. Never another server's. */
	cookieFor(serverUrl: string): string | undefined {
		const session = this.get(serverUrl);
		return session !== undefined ? this.cookies.read(session) : undefined;
	}

	usesSecretStorage(): boolean {
		return this.cookies.usesSecretStorage();
	}

	/** Move cookies out of data.json into Obsidian's secret storage, where available. */
	async migrateCookies(): Promise<void> {
		if (this.cookies.migrate(this.host.settings.sessions)) await this.host.saveSettings();
	}

	/**
	 * Check every account shortly after startup and then periodically. Each
	 * check is an authenticated request, which also renews the session
	 * (HedgeDoc extends a session's lifetime whenever it is used).
	 */
	startBackgroundChecks(plugin: Plugin): void {
		plugin.app.workspace.onLayoutReady(() => {
			const timer = window.setTimeout(() => void this.checkAll(), STARTUP_CHECK_DELAY_MS);
			plugin.register(() => window.clearTimeout(timer));
		});
		plugin.registerInterval(window.setInterval(() => void this.checkAll(), BACKGROUND_CHECK_INTERVAL_MS));
	}

	/** Check all accounts; tell the user once when a session has expired. */
	async checkAll(): Promise<void> {
		for (const key of Object.keys(this.host.settings.sessions)) {
			const before = this.host.settings.sessions[key]?.status;
			const session = await this.check(key);
			if (session?.status === "expired" && before !== "expired") {
				new Notice(`Your hedgedoc session on ${displayServer(key)} has expired. Log in again in ${ACCOUNTS_HINT}.`, 15_000);
			}
		}
	}

	/**
	 * A hint for errors that look like missing access: whether to add an
	 * account, log in again, or whether the account simply lacks access.
	 * Null for other errors.
	 */
	async accessHint(error: unknown, serverUrl: string): Promise<string | null> {
		if (!isAccessError(error)) return null;
		const key = serverKey(serverUrl);
		const server = displayServer(key);
		if (this.host.settings.sessions[key] === undefined) {
			return `You have no account for ${server}. Add one in ${ACCOUNTS_HINT} or with the command "Log in to hedgedoc".`;
		}
		const session = await this.check(key);
		if (session?.status === "expired") return `Your session on ${server} has expired. Log in again in ${ACCOUNTS_HINT}.`;
		const who = session?.user?.name;
		return who !== undefined ? `You are logged in to ${server} as ${who}, but this account has no access.` : null;
	}

	/** Saved accounts, the default server's first. */
	list(): Account[] {
		const defaultKey = this.host.settings.defaultServerUrl ? serverKey(this.host.settings.defaultServerUrl) : null;
		return Object.entries(this.host.settings.sessions)
			.map(([key, session]) => ({key, session, isDefault: key === defaultKey}))
			.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.key.localeCompare(b.key));
	}

	get(serverUrl: string): StoredSession | undefined {
		return this.host.settings.sessions[serverKey(serverUrl)];
	}

	canUseLoginWindow(): boolean {
		return loginWindowAvailable();
	}

	/** Log in through the server's login page. Returns whether an account was saved. */
	async logIn(serverUrl: string): Promise<boolean> {
		const problem = serverUrlProblem(serverUrl);
		if (problem !== null) {
			new Notice(problem);
			return false;
		}
		try {
			const result = await logInWithWindow(serverUrl, (cookie) => this.service.whoAmI(serverUrl, cookie));
			if (result === null) return false;
			await this.store(serverUrl, {cookie: result.cookie, user: result.user, source: "login"});
			new Notice(`Logged in to ${displayServer(serverKey(serverUrl))} as ${result.user.name}.`);
			return true;
		} catch (error) {
			new Notice(`Login failed: ${errorText(error)}`);
			return false;
		}
	}

	/**
	 * Save a cookie copied from a browser, after checking that the server
	 * accepts it. Throws with a readable message otherwise.
	 */
	async saveCookie(serverUrl: string, rawCookie: string): Promise<{id: string; name: string}> {
		const problem = serverUrlProblem(serverUrl);
		if (problem !== null) throw new Error(problem);
		const cookie = normalizeCookie(rawCookie.trim());
		if (cookie.length === 0) throw new Error("Paste a session cookie first.");
		let user: {id: string; name: string} | null;
		try {
			user = await this.service.whoAmI(serverUrl, cookie);
		} catch (error) {
			throw new Error(`Could not reach the server: ${errorText(error)}`);
		}
		if (user === null) throw new Error("The server does not recognise this cookie as a logged-in session. Copy it again from a browser where you are logged in.");
		await this.store(serverUrl, {cookie, user, source: "manual"});
		return user;
	}

	/** Ask the server whether an account's session is still valid; records the result. */
	async check(key: string): Promise<StoredSession | undefined> {
		const session = this.host.settings.sessions[key];
		if (session === undefined) return undefined;
		const cookie = this.cookies.read(session);
		if (cookie === undefined) {
			session.status = "expired";
			session.checkedAt = new Date().toISOString();
			await this.host.saveSettings();
			return session;
		}
		try {
			const user = await this.service.whoAmI(key, cookie);
			session.status = user !== null ? "ok" : "expired";
			if (user !== null) session.user = user;
			delete session.error;
		} catch (error) {
			session.status = "unreachable";
			session.error = errorText(error);
		}
		session.checkedAt = new Date().toISOString();
		await this.host.saveSettings();
		return session;
	}

	async remove(key: string): Promise<void> {
		const session = this.host.settings.sessions[key];
		if (session === undefined) return;
		// A pasted cookie is the browser's own session: ending it would log the
		// browser out too, so only forget it. Sessions from the login window
		// belong to the plugin and are ended on the server.
		if (session.source === "login") {
			await this.service.endSession(key).catch((error: unknown) => {
				console.warn("[hedgesync] could not end the session on the server", error);
			});
		}
		this.cookies.erase(session);
		delete this.host.settings.sessions[key];
		await this.host.saveSettings();
	}

	/** Ask for a server and log in or paste a cookie. */
	openAddAccount(initialUrl: string, onDone?: () => void): void {
		new AccountModal(this.host.app, this, initialUrl, onDone).open();
	}

	private async store(serverUrl: string, login: {cookie: string; user: {id: string; name: string}; source: StoredSession["source"]}): Promise<void> {
		const key = serverKey(serverUrl);
		const now = new Date().toISOString();
		const session: StoredSession = {
			user: login.user,
			source: login.source,
			savedAt: now,
			checkedAt: now,
			status: "ok",
			secretId: this.host.settings.sessions[key]?.secretId,
		};
		this.cookies.write(key, session, login.cookie);
		this.host.settings.sessions[key] = session;
		await this.host.saveSettings();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
