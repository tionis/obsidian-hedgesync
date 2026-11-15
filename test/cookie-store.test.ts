import {strict as assert} from "node:assert";
import {test} from "node:test";
import type {App} from "obsidian";
import {CookieStore, secretIdFor} from "../src/cookie-store";
import {isAccessError} from "../src/errors";
import type {StoredSession} from "../src/settings";

function appWithSecrets(): {app: App; secrets: Map<string, string>} {
	const secrets = new Map<string, string>();
	const secretStorage = {
		setSecret: (id: string, value: string) => {
			assert.match(id, /^[a-z0-9-]+$/);
			secrets.set(id, value);
		},
		getSecret: (id: string) => secrets.get(id) ?? null,
	};
	return {app: {secretStorage} as unknown as App, secrets};
}

const session = (extra: Partial<StoredSession> = {}): StoredSession => ({source: "login", savedAt: "", ...extra});

test("secret ids are valid and stable per server", () => {
	assert.equal(secretIdFor("https://md.tionis.dev"), "hedgesync-md-tionis-dev");
	assert.equal(secretIdFor("http://localhost:3000/hd"), "hedgesync-localhost-3000-hd");
});

test("cookies go to secret storage and out of the session record", () => {
	const {app, secrets} = appWithSecrets();
	const store = new CookieStore(app);
	const s = session();
	store.write("https://md.example.com", s, "connect.sid=abc");
	assert.equal(s.cookie, undefined);
	assert.equal(s.secretId, "hedgesync-md-example-com");
	assert.equal(secrets.get("hedgesync-md-example-com"), "connect.sid=abc");
	assert.equal(store.read(s), "connect.sid=abc");
	store.erase(s);
	assert.equal(store.read(s), undefined);
});

test("existing cookies are migrated; without secret storage they stay in the record", () => {
	const {app, secrets} = appWithSecrets();
	const sessions = {"https://a.example": session({cookie: "connect.sid=a"}), "https://b.example": session({secretId: "hedgesync-b-example"})};
	assert.equal(new CookieStore(app).migrate(sessions), true);
	assert.equal(sessions["https://a.example"].cookie, undefined);
	assert.equal(secrets.get("hedgesync-a-example"), "connect.sid=a");

	const plain = new CookieStore({} as App);
	const s = session();
	plain.write("https://c.example", s, "connect.sid=c");
	assert.equal(s.cookie, "connect.sid=c");
	assert.equal(plain.read(s), "connect.sid=c");
	assert.equal(plain.migrate({x: s}), false);
});

test("access errors are told apart from other failures", () => {
	assert.equal(isAccessError(Object.assign(new Error("Access forbidden"), {code: 403})), true);
	assert.equal(isAccessError(new Error("This note requires login to edit (permission: limited).")), true);
	assert.equal(isAccessError(Object.assign(new Error("HTTP 403"), {statusCode: 403})), true);
	assert.equal(isAccessError(new Error("Cannot resolve md.example.com.")), false);
});
