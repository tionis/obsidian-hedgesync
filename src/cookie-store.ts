/**
 * Where session cookies live: Obsidian's secret storage (Obsidian 1.11.4+),
 * which keeps them out of the plugin's data.json, or data.json on older
 * versions. Settings only record the secret's ID.
 */

import type {App} from "obsidian";
import type {StoredSession} from "./settings";

interface SecretStorageLike {
	setSecret(id: string, secret: string): void;
	getSecret(id: string): string | null;
}

/** Secret ID for a server key: "hedgesync-" plus host and path, lower-case, dashes only. */
export function secretIdFor(key: string): string {
	const slug = key.replace(/^[a-z]+:\/\//i, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return `hedgesync-${slug || "server"}`;
}

export class CookieStore {
	constructor(private readonly app: App) {}

	private storage(): SecretStorageLike | null {
		const storage = (this.app as unknown as {secretStorage?: Partial<SecretStorageLike>}).secretStorage;
		return typeof storage?.setSecret === "function" && typeof storage.getSecret === "function"
			? storage as SecretStorageLike
			: null;
	}

	/** Whether cookies go to Obsidian's secret storage. */
	usesSecretStorage(): boolean {
		return this.storage() !== null;
	}

	/** The cookie of a stored session, wherever it is kept. */
	read(session: StoredSession): string | undefined {
		if (session.secretId !== undefined) {
			const secret = this.storage()?.getSecret(session.secretId);
			if (secret) return secret;
		}
		return session.cookie || undefined;
	}

	/** Put `cookie` into the session record (or into secret storage, recording its ID). */
	write(key: string, session: StoredSession, cookie: string): void {
		const storage = this.storage();
		if (storage === null) {
			session.cookie = cookie;
			delete session.secretId;
			return;
		}
		const id = session.secretId ?? secretIdFor(key);
		storage.setSecret(id, cookie);
		session.secretId = id;
		delete session.cookie;
	}

	/** Erase a session's cookie (secret storage has no delete; the secret is emptied). */
	erase(session: StoredSession): void {
		if (session.secretId !== undefined) {
			try {
				this.storage()?.setSecret(session.secretId, "");
			} catch (error) {
				console.warn("[hedgesync] could not clear a stored secret", error);
			}
		}
		delete session.cookie;
	}

	/**
	 * Move cookies still kept in data.json into secret storage. Returns
	 * whether anything changed (the caller then saves the settings).
	 */
	migrate(sessions: Record<string, StoredSession>): boolean {
		if (this.storage() === null) return false;
		let changed = false;
		for (const [key, session] of Object.entries(sessions)) {
			if (session.cookie) {
				this.write(key, session, session.cookie);
				changed = true;
			}
		}
		return changed;
	}
}
