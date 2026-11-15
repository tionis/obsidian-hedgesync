import {serverKey} from "./server-key";

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

/** Allowed ranges for the numeric settings, in milliseconds. */
export const NUMBER_LIMITS = {
	autoPushDebounceMs: {min: 200, max: 120000},
	requestTimeoutMs: {min: 1000, max: 120000},
} as const;

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
		autoPushDebounceMs: coerceNumber(raw.autoPushDebounceMs, DEFAULT_SETTINGS.autoPushDebounceMs, NUMBER_LIMITS.autoPushDebounceMs),
		requestTimeoutMs: coerceNumber(raw.requestTimeoutMs, DEFAULT_SETTINGS.requestTimeoutMs, NUMBER_LIMITS.requestTimeoutMs),
		warnBeforeOverwrite: raw.warnBeforeOverwrite ?? DEFAULT_SETTINGS.warnBeforeOverwrite,
		liveSyncAutoStart: raw.liveSyncAutoStart ?? DEFAULT_SETTINGS.liveSyncAutoStart,
	};
}

function coerceNumber(value: unknown, fallback: number, {min, max}: {min: number; max: number}): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.floor(value)));
}
