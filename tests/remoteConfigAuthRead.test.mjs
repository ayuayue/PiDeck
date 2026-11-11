import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as path from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * The remote auth view is derived, not returned: `readAuth` compares credential values to decide configured /
 * missing and never puts one in its answer. That invariant is proved here against the **frozen** config artifact
 * itself (not a reimplementation), on every platform — the child-process suite (remoteHelperConfig) only runs on
 * POSIX, so on a Windows dev machine this is the only direct proof.
 *
 * The artifact only touches the fs object it is handed, so a small in-memory fs is enough to run the real body:
 * the fixture home is the POSIX path the scope requires, and nothing outside it is ever reachable.
 *
 * It also pins the second half of the boundary: auth.json is not in the patchable FILES map, so config.patch can
 * never address it no matter what the renderer asks for.
 */

const config = loadTsCommonJs("src/main/remote/RemoteConfigSource.ts");
const contract = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");

/** Evaluate the packed ES module body as a plain function returning its factory (no imports, no exports). */
function loadFrozenScope() {
	const body = config.REMOTE_CONFIG_SOURCE.replace("export function createConfigScope", "function createConfigScope");
	// 冻结产物本身就是被测试对象：这里按它声明的形状求出工厂，而不是另写一份实现。
	return new Function(body + "\nreturn createConfigScope;")();
}

const createConfigScope = loadFrozenScope();
const HOME = "/home/pideck-test";
const AGENT = HOME + "/.pi/agent";

function enoent(target) {
	const error = new Error("ENOENT: " + target);
	error.code = "ENOENT";
	return error;
}

/**
 * Minimal read-only fs: the two agent directories exist, and only the files handed in exist as regular files.
 * Every other path fails like a missing entry, so a read of an unlisted file cannot silently succeed.
 */
function memoryFs(files) {
	const directories = new Set([HOME + "/.pi", AGENT]);
	const contents = new Map(Object.entries(files).map(([name, body]) => [AGENT + "/" + name, Buffer.from(body, "utf8")]));
	const handles = [];
	const stat = (bytes) => ({ dev: 1, ino: 1, size: bytes.length, isFile: () => true, isSymbolicLink: () => false, isDirectory: () => false });
	return {
		constants: { O_RDONLY: 0, O_NOFOLLOW: 0 },
		lstatSync(target) {
			if (directories.has(target)) return { dev: 1, ino: 2, size: 0, isFile: () => false, isSymbolicLink: () => false, isDirectory: () => true };
			const bytes = contents.get(target);
			if (bytes === undefined) throw enoent(target);
			return stat(bytes);
		},
		openSync(target) {
			const bytes = contents.get(target);
			if (bytes === undefined) throw enoent(target);
			handles.push({ bytes, position: 0 });
			return handles.length - 1;
		},
		fstatSync(descriptor) {
			return stat(handles[descriptor].bytes);
		},
		readSync(descriptor, buffer, offset, length, position) {
			const handle = handles[descriptor];
			const start = position ?? handle.position;
			const count = Math.max(0, Math.min(length, handle.bytes.length - start));
			handle.bytes.copy(buffer, offset, start, start + count);
			handle.position = start + count;
			return count;
		},
		closeSync() {
			/* handles are garbage-collected with the fixture */
		},
	};
}

function readAuthWith(files) {
	const scope = createConfigScope(HOME, memoryFs(files), path, { createHash });
	return scope.readAuth();
}

test("the frozen artifact is the pinned bytes and exposes the derived read", () => {
	assert.equal(createHash("sha256").update(config.REMOTE_CONFIG_SOURCE, "utf8").digest("hex"), config.REMOTE_HELPER_CONFIG_SHA256);
	assert.ok(config.REMOTE_CONFIG_SOURCE.includes("readAuth: readAuth"), "the scope exports readAuth");
	assert.ok(config.REMOTE_CONFIG_SOURCE.includes('const READ_AUTH = "auth.json"'));
	// auth.json stays out of the patchable map: the only literal occurrence is the read-only view.
	assert.ok(!config.REMOTE_CONFIG_SOURCE.includes('auth: "auth.json"'));
});

test("readAuth answers provider / type / configured and never a credential value", () => {
	const result = readAuthWith({
		"auth.json": JSON.stringify({
			openai: { type: "api_key", key: "sk-live-value" },
			anthropic: { type: "oauth", access: "access-token-live", refresh: "refresh-token-live", expires: 4_102_444_800_000 },
			broken: { type: "api_key" },
			weird: { type: "session" },
		}),
	});
	assert.deepEqual(
		result.providers.map((entry) => [entry.provider, entry.type, entry.configured]),
		[
			["anthropic", "oauth", true],
			["broken", "api_key", false],
			["openai", "api_key", true],
			["weird", "unsupported", false],
		],
	);
	assert.match(result.version, /^[0-9a-f]{64}$/);
	assert.equal(result.version, result.sha256);
	const serialized = JSON.stringify(result);
	for (const secret of ["sk-live-value", "access-token-live", "refresh-token-live"]) {
		assert.equal(serialized.includes(secret), false, "no credential value may reach the answer: " + secret);
	}
	// The view has exactly the documented fields — nothing that could carry a value later.
	assert.deepEqual(Object.keys(result).sort(), ["providers", "sha256", "version"]);
	for (const provider of result.providers) assert.deepEqual(Object.keys(provider).sort(), ["configured", "provider", "type"]);
});

test("a missing auth.json is an empty list, not an error", () => {
	assert.deepEqual(readAuthWith({}).providers, []);
});

test("auth.json cannot be patched, and a malformed document is refused", () => {
	const files = { "auth.json": JSON.stringify({ openai: { type: "api_key", key: "sk-live" } }) };
	const scope = createConfigScope(HOME, memoryFs(files), path, { createHash });
	// A patch naming auth is refused before any read of the file: the key is not in the patchable map.
	assert.throws(() => scope.patch({ file: "auth", expectedVersion: scope.readAuth().version, patch: { openai: { key: "sk-new" } } }), /CONFIG_PATH_UNSUPPORTED/);
	assert.deepEqual(JSON.parse(files["auth.json"]), { openai: { type: "api_key", key: "sk-live" } }, "the file is untouched");

	assert.throws(() => readAuthWith({ "auth.json": "{ not json" }), /CONFIG_FILE_INVALID/);
	assert.throws(() => readAuthWith({ "auth.json": '{"openai":"sk-live"}' }), /CONFIG_FILE_INVALID/, "a non-record credential is refused, not described");
	assert.throws(() => readAuthWith({ "auth.json": '{"__proto__":{"type":"api_key","key":"sk"}}' }), /CONFIG_FILE_INVALID/, "reserved provider names are refused");
});

test("the provider bound is enforced instead of truncating", () => {
	const fat = {};
	for (let index = 0; index <= contract.REMOTE_CONFIG_MAX_AUTH_PROVIDERS; index += 1) fat["p" + index] = { type: "api_key", key: "k" };
	assert.throws(() => readAuthWith({ "auth.json": JSON.stringify(fat) }), /CONFIG_FILE_TOO_LARGE/);
});

test("the contract pattern is the one the frozen artifact enforces", () => {
	assert.ok(config.REMOTE_CONFIG_SOURCE.includes(contract.REMOTE_CONFIG_AUTH_PROVIDER_PATTERN.source), "frozen config.mjs repeats the provider pattern");
	for (const name of ["openai", "anthropic", "openai-codex", "google.gemini", "my_provider", "p:1"]) assert.ok(contract.REMOTE_CONFIG_AUTH_PROVIDER_PATTERN.test(name), name + " must be a legal provider id");
	for (const name of ["", "-leading", "a".repeat(129), "bad name", "bad/name"]) assert.equal(contract.REMOTE_CONFIG_AUTH_PROVIDER_PATTERN.test(name), false, name + " must not be a provider id");
});
