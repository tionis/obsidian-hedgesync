/**
 * Log in through a HedgeDoc login page in a separate Electron window, so any
 * login method the server offers works (OIDC, GitHub, LDAP, email, ...).
 *
 * The window uses its own in-memory session partition: nothing is shared
 * with Obsidian's web views and nothing remains on disk afterwards. Once the
 * server says the window's session cookie belongs to an account, the cookie
 * is handed back and the window closes.
 */

interface RemoteCookie {
	name: string;
	value: string;
}

interface RemoteBrowserWindow {
	loadURL(url: string): Promise<void>;
	on(event: "closed", listener: () => void): void;
	close(): void;
	isDestroyed(): boolean;
	webContents: {
		session: {cookies: {get(filter: {url: string}): Promise<RemoteCookie[]>}};
		getUserAgent(): string;
		setUserAgent(userAgent: string): void;
		getURL(): string;
		isLoading(): boolean;
		listenerCount(event: string): number;
		removeAllListeners(event: string): void;
		on(event: string, listener: (...args: unknown[]) => void): void;
	};
}

interface ElectronRemote {
	BrowserWindow: new (options: Record<string, unknown>) => RemoteBrowserWindow;
}

const CHECK_INTERVAL_MS = 1500;
const NAVIGATION_EVENTS = ["will-navigate", "will-frame-navigate", "will-redirect"];

let remoteModule: ElectronRemote | null | undefined;

function electronRemote(): ElectronRemote | null {
	if (remoteModule === undefined) {
		remoteModule = null;
		const load = (window as unknown as {require?: (id: string) => unknown}).require;
		if (typeof load === "function") {
			try {
				remoteModule = load("@electron/remote") as ElectronRemote;
			} catch {
				try {
					remoteModule = (load("electron") as {remote?: ElectronRemote}).remote ?? null;
				} catch {
					remoteModule = null;
				}
			}
		}
	}
	return remoteModule;
}

export function loginWindowAvailable(): boolean {
	return electronRemote()?.BrowserWindow !== undefined;
}

export interface LoginResult {
	cookie: string;
	user: {id: string; name: string};
}

/**
 * Open the server in a login window and wait until `verify` accepts the
 * window's cookies. Resolves null if the user closes the window first.
 */
export function logInWithWindow(
	serverUrl: string,
	verify: (cookie: string) => Promise<{id: string; name: string} | null>,
): Promise<LoginResult | null> {
	const remote = electronRemote();
	if (remote === null) {
		return Promise.reject(new Error("This version of Obsidian cannot open a login window. Paste a session cookie in the plugin settings instead."));
	}

	const base = serverUrl.replace(/\/+$/, "");
	const win = new remote.BrowserWindow({
		width: 960,
		height: 760,
		title: "Log in to hedgedoc",
		autoHideMenuBar: true,
		webPreferences: {
			// No "persist:" prefix: an in-memory session that disappears with the window.
			partition: `hedgesync-login-${Date.now()}`,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	const contents = win.webContents;
	// Obsidian guards every new web contents against navigating away from the
	// app. Those guards cancel the login page's navigations and redirects (the
	// window stays white), and this window is not an Obsidian window.
	for (const event of NAVIGATION_EVENTS) {
		if (contents.listenerCount(event) > 0) contents.removeAllListeners(event);
	}
	// Some identity providers refuse embedded browsers that announce themselves.
	contents.setUserAgent(contents.getUserAgent().replace(/\s(?:obsidian|Electron)\/\S+/gi, ""));
	// Diagnostics for the developer console: a login window that stays blank says nothing on its own.
	contents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
		// -3 (ERR_ABORTED) accompanies every redirect; subframe failures are not the page failing.
		if (code === -3 || isMainFrame === false) return;
		console.warn(`[hedgesync] login window failed to load ${String(url)}: ${String(description)} (${String(code)})`);
	});
	contents.on("did-finish-load", () => console.debug(`[hedgesync] login window loaded ${contents.getURL()}`));

	return new Promise((resolve) => {
		let finished = false;
		let checking = false;

		const finish = (result: LoginResult | null) => {
			if (finished) return;
			finished = true;
			window.clearInterval(timer);
			if (!win.isDestroyed()) win.close();
			resolve(result);
		};

		const check = async () => {
			if (finished || checking || win.isDestroyed()) return;
			checking = true;
			try {
				const cookies = await win.webContents.session.cookies.get({url: `${base}/`});
				if (cookies.length === 0) return;
				const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
				const user = await verify(cookie).catch(() => null);
				if (user !== null) finish({cookie, user});
			} finally {
				checking = false;
			}
		};

		const timer = window.setInterval(() => void check(), CHECK_INTERVAL_MS);
		win.on("closed", () => finish(null));
		const start = `${base}/`;
		win.loadURL(start).catch((error: unknown) => {
			console.error("[hedgesync] login window failed to load", error);
		});
		// If something still swallowed the first load, try once more.
		window.setTimeout(() => {
			if (finished || win.isDestroyed()) return;
			const current = contents.getURL();
			if ((current === "" || current === "about:blank") && !contents.isLoading()) {
				console.warn("[hedgesync] login window stalled; loading again");
				win.loadURL(start).catch((error: unknown) => console.error("[hedgesync] login window failed to load", error));
			}
		}, 3000);
	});
}
