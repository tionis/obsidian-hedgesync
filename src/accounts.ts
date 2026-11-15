/**
 * HedgeDoc accounts: one stored session per server, added through the login
 * window or by pasting a browser cookie, checked against the server, and
 * removed again. A session is only ever sent to its own server.
 */

import {App, Notice} from "obsidian";
import {normalizeCookie} from "hedgesync/obsidian";
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

export class AccountManager {
	constructor(private readonly host: AccountHost, private readonly service: HedgeDocService) {}

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
		try {
			const user = await this.service.whoAmI(key, session.cookie);
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
		delete this.host.settings.sessions[key];
		await this.host.saveSettings();
	}

	/** Ask for a server and log in or paste a cookie. */
	openAddAccount(initialUrl: string, onDone?: () => void): void {
		new AccountModal(this.host.app, this, initialUrl, onDone).open();
	}

	private async store(serverUrl: string, session: Pick<StoredSession, "cookie" | "user" | "source">): Promise<void> {
		const now = new Date().toISOString();
		this.host.settings.sessions[serverKey(serverUrl)] = {...session, savedAt: now, checkedAt: now, status: "ok"};
		await this.host.saveSettings();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
