import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { materializeRemoteHelperArtifacts } from "./helpers/remoteHelperArtifacts.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Phase 5 remote config scope, proved through a real helper child process on POSIX (WSL in this repo's CI).
 *
 * The helper is the deployed bundle (entry + config.mjs), HOME points at a real temp directory, and every
 * request goes through the production RemoteControlClient. What is asserted is behavior on disk: redaction,
 * merge-patch semantics, unknown-field preservation, expectedVersion, atomic 0600 writes, and refusal of
 * auth.json / symlinks / oversized or malformed files.
 */

const POSIX = process.platform !== "win32";
const HOST_ID = "01234567-89ab-4def-8123-456789abcdef";
const { createRemoteControlClient } = loadTsCommonJs("src/main/remote/RemoteControlClient.ts");
const contract = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const entry = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");

const BUNDLE_DIRECTORY = mkdtempSync(join(tmpdir(), "pideck-config-bundle-"));
const ENTRY_PATH = materializeRemoteHelperArtifacts(BUNDLE_DIRECTORY).entryPath;
test.after(() => rmSync(BUNDLE_DIRECTORY, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));

function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

function guard(promise, label, timeoutMs = 10_000) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timed out: " + label)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the promise to reject");
}

async function expectRefusal(session, method, params, code) {
	const error = await rejection(guard(session.client.request(method, params), method));
	assert.equal(error.code, code, method + " answered " + error.code);
	assert.equal(error.retryable, false);
	return error;
}

/** A real helper process with HOME set to a temp directory; requests go through the production client. */
function startHelper(t, home) {
	const child = spawn(process.execPath, [ENTRY_PATH], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "pipe"] });
	let buffered = "";
	const client = createRemoteControlClient({
		hostId: HOST_ID,
		send: (line) => child.stdin.write(line + "\n"),
		onDiagnostic: () => undefined,
	});
	client.openConnection();
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	let stderr = "";
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdin.on("error", () => undefined);
	child.stdout.on("data", (chunk) => {
		buffered += chunk;
		let index;
		while ((index = buffered.indexOf("\n")) >= 0) {
			const line = buffered.slice(0, index);
			buffered = buffered.slice(index + 1);
			client.handleLine(line);
		}
	});
	t.after(() => {
		client.closeConnection();
		child.stdin.destroy();
		child.kill();
	});
	return { client, stderr: () => stderr };
}

function readText(path) {
	return readFileSync(path, "utf8");
}

const configTest = (name, fn) => test(name, { skip: !POSIX, timeout: 60_000 }, fn);

function homeWith(files = {}) {
	const home = mkdtempSync(join(tmpdir(), "pideck-config-home-"));
	const agent = join(home, ".pi", "agent");
	mkdirSync(agent, { recursive: true });
	for (const [name, content] of Object.entries(files)) writeFileSync(join(agent, name), content);
	return { home, agent };
}

configTest("hello advertises the config scope and the frozen helper reports the current build", async (t) => {
	const { home } = homeWith();
	const session = startHelper(t, home);
	const hello = plain(await guard(session.client.request("hello"), "hello"));
	assert.ok(hello.capabilities.includes("config.read"));
	assert.ok(hello.capabilities.includes("config.patch"));
	assert.ok(hello.capabilities.includes("config.readAuth"));
	assert.equal(hello.helperVersion, entry.REMOTE_HELPER_ENTRY_VERSION);
});

configTest("the derived auth read answers provider facts only and stays out of the patch path", async (t) => {
	const { home } = homeWith({
		"auth.json": JSON.stringify({
			openai: { type: "api_key", key: "sk-live-value" },
			anthropic: { type: "oauth", access: "access-token-live", refresh: "refresh-token-live", expires: 4102444800000 },
			broken: { type: "api_key" },
		}),
	});
	const session = startHelper(t, home);
	const view = plain(await guard(session.client.request("config.readAuth"), "readAuth"));
	assert.deepEqual(
		view.providers.map((entry) => [entry.provider, entry.type, entry.configured]),
		[
			["anthropic", "oauth", true],
			["broken", "api_key", false],
			["openai", "api_key", true],
		],
	);
	const serialized = JSON.stringify(view);
	for (const secret of ["sk-live-value", "access-token-live", "refresh-token-live"]) assert.equal(serialized.includes(secret), false, "credential value must not cross the boundary: " + secret);
	// Neither a raw read nor a patch can address the credential file.
	await expectRefusal(session, "config.read", { file: "auth" }, "CONFIG_PATH_UNSUPPORTED");
	await expectRefusal(session, "config.patch", { file: "auth", expectedVersion: view.version, patch: { openai: { key: "sk-new" } } }, "CONFIG_PATH_UNSUPPORTED");
	assert.equal(JSON.parse(readText(join(home, ".pi", "agent", "auth.json"))).openai.key, "sk-live-value", "a refused patch must not touch the file");

	// A missing auth.json is an empty list; a malformed one is a definite refusal.
	const missing = startHelper(t, homeWith().home);
	assert.deepEqual(plain(await guard(missing.client.request("config.readAuth"), "readAuth missing")).providers, []);
	const corrupt = startHelper(t, homeWith({ "auth.json": "{ not json" }).home);
	await expectRefusal(corrupt, "config.readAuth", {}, "CONFIG_FILE_INVALID");
});

configTest("read answers canonical defaults for a missing file and sanitizes secrets recursively", async (t) => {
	const { home, agent } = homeWith({
		"settings.json": JSON.stringify({ theme: "dark", apiKey: "sk-live", nested: { password: "pw", visible: 1 }, list: [{ token: "t" }] }),
	});
	const session = startHelper(t, home);
	const settings = plain(await guard(session.client.request("config.read", { file: "settings" }), "settings read"));
	assert.equal(settings.data.theme, "dark");
	assert.equal(settings.data.apiKey, "configured");
	assert.equal(settings.data.nested.password, "configured");
	assert.equal(settings.data.nested.visible, 1);
	assert.equal(settings.data.list[0].token, "configured");
	const secrets = settings.secrets.map((entry) => entry.path + ":" + entry.status).sort();
	assert.deepEqual(secrets, ["apiKey:configured", "list.0.token:configured", "nested.password:configured"]);
	const serialized = JSON.stringify(settings);
	for (const secret of ["sk-live", "pw", '"t"']) assert.equal(serialized.includes(secret), false, "secret must not cross the boundary: " + secret);
	assert.match(settings.version, /^[0-9a-f]{64}$/);
	assert.equal(settings.version, settings.sha256);

	// Missing models.json answers the canonical empty document and creates the private agent directory.
	const emptyHome = mkdtempSync(join(tmpdir(), "pideck-config-empty-"));
	const emptySession = startHelper(t, emptyHome);
	const models = plain(await guard(emptySession.client.request("config.read", { file: "models" }), "models default"));
	assert.deepEqual(models.data, { providers: {} });
	assert.deepEqual(models.secrets, []);
	const agentMode = lstatSync(join(emptyHome, ".pi", "agent")).mode & 0o777;
	assert.equal(agentMode, 0o700);
	void agent;
});

configTest("merge patch preserves unknown fields, replaces secrets only when given, and keeps arrays replace", async (t) => {
	const { home, agent } = homeWith({
		"models.json": JSON.stringify({ providers: { openai: { apiKey: "old-secret", baseUrl: "https://old", unknownProviderField: { keep: true }, models: [{ id: "a" }, { id: "b" }] } }, unknownTop: "keep", removeMe: { deep: 1 } }),
	});
	const session = startHelper(t, home);
	const before = plain(await guard(session.client.request("config.read", { file: "models" }), "read before"));
	const patched = plain(
		await guard(
			session.client.request("config.patch", {
				file: "models",
				expectedVersion: before.version,
				patch: {
					providers: { openai: { apiKey: "new-secret", baseUrl: "https://new", models: [{ id: "c" }] } },
					added: { ok: true },
					removeMe: null,
				},
			}),
			"patch models",
		),
	);
	assert.equal(patched.data.providers.openai.apiKey, "configured");
	assert.equal(patched.data.providers.openai.baseUrl, "https://new");
	assert.equal(patched.data.providers.openai.unknownProviderField.keep, true, "unknown provider field survives the merge");
	assert.equal(patched.data.unknownTop, "keep", "unknown top-level field survives the merge");
	assert.equal(patched.data.removeMe, undefined, "null removes a non-secret key");
	assert.deepEqual(plain(patched.data.providers.openai.models), [{ id: "c" }], "arrays replace, they do not merge");
	assert.deepEqual(plain(patched.data.added), { ok: true });
	assert.notEqual(patched.version, before.version);

	// Disk keeps the real secret, old unknown fields and the new value; the temp file is gone and mode is 0600.
	const disk = JSON.parse(readText(join(agent, "models.json")));
	assert.equal(disk.providers.openai.apiKey, "new-secret");
	assert.equal(disk.providers.openai.unknownProviderField.keep, true);
	assert.equal(
		readdirSync(agent).some((name) => name.includes(".tmp-")),
		false,
	);
	assert.equal(lstatSync(join(agent, "models.json")).mode & 0o777, 0o600);

	// A sentinel in the patch is not a replacement: it keeps the secret as-is (and a sentinel-only patch is a no-op).
	const second = plain(await guard(session.client.request("config.patch", { file: "models", expectedVersion: patched.version, patch: { providers: { openai: { apiKey: "configured" } } } }), "sentinel patch"));
	assert.equal(second.version, patched.version);
	assert.equal(JSON.parse(readText(join(agent, "models.json"))).providers.openai.apiKey, "new-secret");

	// expectedVersion conflict is a definite refusal and cannot modify the file.
	const stale = await expectRefusal(session, "config.patch", { file: "models", expectedVersion: before.version, patch: { x: 1 } }, "CONFIG_VERSION_CONFLICT");
	assert.ok(stale.code);
	const bytes = readText(join(agent, "models.json"));
	assert.equal(bytes.includes("x"), false);
});

configTest("malformed, oversized, symlinked and unaddressable files are refused without overwriting", async (t) => {
	// Malformed JSON: a definite refusal, file bytes untouched.
	const bad = homeWith({ "settings.json": "{ not json" });
	const badSession = startHelper(t, bad.home);
	await expectRefusal(badSession, "config.read", { file: "settings" }, "CONFIG_FILE_INVALID");
	await expectRefusal(badSession, "config.patch", { file: "settings", expectedVersion: "0".repeat(64), patch: {} }, "CONFIG_VERSION_CONFLICT");
	assert.equal(readText(join(bad.agent, "settings.json")), "{ not json");

	// Oversized file: refused before parsing, untouched.
	const big = homeWith();
	writeFileSync(join(big.agent, "settings.json"), "x".repeat(contract.REMOTE_CONFIG_MAX_FILE_BYTES + 1));
	const bigSession = startHelper(t, big.home);
	await expectRefusal(bigSession, "config.read", { file: "settings" }, "CONFIG_FILE_TOO_LARGE");

	// auth.json is not addressable at all (file enum only), and no path parameter exists.
	const normal = homeWith({ "auth.json": JSON.stringify({ openai: { key: "sk" } }) });
	const normalSession = startHelper(t, normal.home);
	await expectRefusal(normalSession, "config.read", { file: "auth" }, "CONFIG_PATH_UNSUPPORTED");
	await expectRefusal(normalSession, "config.read", { file: "settings", path: "/etc/passwd" }, "CONFIG_PATH_UNSUPPORTED");
	await expectRefusal(normalSession, "config.patch", { file: "settings", patch: {}, path: "/etc/passwd" }, "CONFIG_PATH_UNSUPPORTED");

	// A symlinked config file is refused and its target is untouched.
	const link = homeWith();
	writeFileSync(join(link.home, "outside-settings.json"), JSON.stringify({ safe: true }));
	symlinkSync(join(link.home, "outside-settings.json"), join(link.agent, "settings.json"));
	const linkSession = startHelper(t, link.home);
	await expectRefusal(linkSession, "config.read", { file: "settings" }, "CONFIG_PATH_UNSUPPORTED");
	await expectRefusal(linkSession, "config.patch", { file: "settings", expectedVersion: "0".repeat(64), patch: {} }, "CONFIG_PATH_UNSUPPORTED");
	assert.deepEqual(JSON.parse(readText(join(link.home, "outside-settings.json"))), { safe: true });

	// A symlinked agent directory is refused before anything is read or written.
	const fakeHome = mkdtempSync(join(tmpdir(), "pideck-config-symlink-"));
	const realAgent = join(fakeHome, "real-agent");
	mkdirSync(realAgent);
	mkdirSync(join(fakeHome, ".pi"));
	symlinkSync(realAgent, join(fakeHome, ".pi", "agent"));
	const symlinkSession = startHelper(t, fakeHome);
	await expectRefusal(symlinkSession, "config.read", { file: "models" }, "CONFIG_PATH_UNSUPPORTED");

	// A HOME that is not an absolute POSIX path is refused by the config scope itself.
	const broken = startHelper(t, "relative-home");
	await expectRefusal(broken, "config.read", { file: "models" }, "CONFIG_UNAVAILABLE");
});

configTest("read is repeatable and patch is idempotent only through its returned version", async (t) => {
	const { home, agent } = homeWith({ "settings.json": JSON.stringify({ a: 1 }) });
	const session = startHelper(t, home);
	const first = plain(await guard(session.client.request("config.read", { file: "settings" }), "first read"));
	const again = plain(await guard(session.client.request("config.read", { file: "settings" }), "second read"));
	assert.equal(first.version, again.version);
	const patched = plain(await guard(session.client.request("config.patch", { file: "settings", expectedVersion: first.version, patch: { b: 2 } }), "patch"));
	const replay = await expectRefusal(session, "config.patch", { file: "settings", expectedVersion: first.version, patch: { c: 3 } }, "CONFIG_VERSION_CONFLICT");
	assert.ok(replay.code);
	assert.equal(patched.data.b, 2);
	assert.deepEqual(JSON.parse(readText(join(agent, "settings.json"))), { a: 1, b: 2 });
});

configTest("reserved keys in a patch are refused before any merge", async (t) => {
	const { home } = homeWith({ "settings.json": JSON.stringify({ theme: "dark" }) });
	const session = startHelper(t, home);
	const before = plain(await guard(session.client.request("config.read", { file: "settings" }), "before"));
	const ownProto = JSON.parse('{"__proto__":{"polluted":"yes"}}');
	await expectRefusal(session, "config.patch", { file: "settings", expectedVersion: before.version, patch: ownProto }, "CONFIG_FILE_INVALID");
	const nested = JSON.parse('{"list":[{"constructor":{"prototype":{"polluted":"yes"}}}]}');
	await expectRefusal(session, "config.patch", { file: "settings", expectedVersion: before.version, patch: nested }, "CONFIG_FILE_INVALID");
	const after = plain(await guard(session.client.request("config.read", { file: "settings" }), "after"));
	assert.equal(after.version, before.version, "a refused patch must not touch the file");
	assert.equal(after.data.theme, "dark");
	assert.equal(JSON.stringify(after).includes("polluted"), false);
	const hello = plain(await guard(session.client.request("hello"), "hello after refusals"));
	assert.equal(hello.helperVersion, entry.REMOTE_HELPER_ENTRY_VERSION, "the helper stays healthy after refused patches");
});

configTest("real model fields are not secrets and numeric patches apply", async (t) => {
	const { home, agent } = homeWith({ "models.json": JSON.stringify({ providers: { p: { maxTokens: 32000, max_tokens: 10, tokenizer: "x", provider_token: "t", clientSecret: "cs-live", openaiApiKey: "sk-live2" } } }) });
	const session = startHelper(t, home);
	const read = plain(await guard(session.client.request("config.read", { file: "models" }), "read models"));
	assert.equal(read.data.providers.p.maxTokens, 32000);
	assert.equal(read.data.providers.p.max_tokens, 10);
	assert.equal(read.data.providers.p.tokenizer, "x");
	assert.equal(read.data.providers.p.provider_token, "configured");
	assert.equal(read.data.providers.p.clientSecret, "configured", "camelCase compound secret names are redacted");
	assert.equal(read.data.providers.p.openaiApiKey, "configured", "camelCase compound apiKey names are redacted");
	assert.deepEqual(
		read.secrets.map((entry) => entry.path),
		["providers.p.clientSecret", "providers.p.openaiApiKey", "providers.p.provider_token"],
		"only the real secret names are redacted",
	);
	const patched = plain(await guard(session.client.request("config.patch", { file: "models", expectedVersion: read.version, patch: { providers: { p: { maxTokens: 8192 } } } }), "patch maxTokens"));
	assert.equal(patched.data.providers.p.maxTokens, 8192);
	assert.notEqual(patched.version, read.version);
	assert.equal(JSON.parse(readText(join(agent, "models.json"))).providers.p.maxTokens, 8192);
	await expectRefusal(session, "config.patch", { file: "models", expectedVersion: patched.version, patch: { providers: { p: { provider_token: 123 } } } }, "CONFIG_FILE_INVALID");
});

configTest("invalid UTF-8 is refused and the file is never overwritten", async (t) => {
	const { home, agent } = homeWith();
	const target = join(agent, "settings.json");
	const corrupt = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
	writeFileSync(target, corrupt);
	const session = startHelper(t, home);
	await expectRefusal(session, "config.read", { file: "settings" }, "CONFIG_FILE_INVALID");
	assert.deepEqual(readFileSync(target), corrupt, "a corrupt file is reported, never rewritten");
});
