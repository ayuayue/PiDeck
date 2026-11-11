import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Phase 5 remote config scope: contract <-> frozen artifact parity, independent of any process.
 *
 * The helper cannot import the TypeScript contract, so every shared literal is repeated in the frozen body and
 * pinned here: method names, capability list, the secret-key pattern, the closed helper error codes, the config
 * artifact digest and the helper build identity. A drift is a protocol change, not a formatting nit.
 */

const contract = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");
const entry = loadTsCommonJs("src/main/remote/RemoteHelperEntry.ts");
const config = loadTsCommonJs("src/main/remote/RemoteConfigSource.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");

test("config methods, capabilities and error codes are the same vocabulary on both sides", () => {
	assert.equal(contract.REMOTE_HELPER_METHOD_CONFIG_READ, "config.read");
	assert.equal(contract.REMOTE_HELPER_METHOD_CONFIG_PATCH, "config.patch");
	assert.equal(contract.REMOTE_HELPER_METHOD_CONFIG_READ_AUTH, "config.readAuth");
	assert.ok(contract.REMOTE_HELPER_CAPABILITIES.includes("config.read"));
	assert.ok(contract.REMOTE_HELPER_CAPABILITIES.includes("config.patch"));
	assert.ok(contract.REMOTE_HELPER_CAPABILITIES.includes("config.readAuth"));
	for (const code of ["CONFIG_FILE_INVALID", "CONFIG_FILE_TOO_LARGE", "CONFIG_VERSION_CONFLICT", "CONFIG_PATH_UNSUPPORTED", "CONFIG_RESULT_UNCONFIRMED", "CONFIG_UNAVAILABLE"]) {
		assert.ok(contract.REMOTE_HELPER_ERROR_CODES.includes(code), code + " must be a declared helper error code");
		assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('"' + code + '"'), code + " must be a literal of the frozen entry");
	}
	// The frozen entry dispatches the methods and advertises all capabilities.
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('"config.read"'));
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('"config.patch"'));
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('"config.readAuth"'));
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('from"./config.mjs"'), "the entry imports the config artifact");
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes('"config.read", "config.patch", "config.readAuth"]'), "capabilities literal carries all three methods");
});

test("the secret-key pattern and the public bounds are one source of truth", () => {
	const source = config.REMOTE_CONFIG_SOURCE;
	// The frozen artifact repeats the pattern source text; both sides must redact exactly the same key names.
	assert.ok(source.includes(contract.REMOTE_CONFIG_SECRET_KEY_PATTERN.source), "frozen config.mjs repeats the contract secret pattern");
	assert.ok(source.includes(String(contract.REMOTE_CONFIG_MAX_FILE_BYTES)), "frozen config.mjs repeats the file byte bound");
	assert.ok(source.includes(String(contract.REMOTE_CONFIG_MAX_NODES)), "frozen config.mjs repeats the node bound");
	assert.ok(source.includes(String(contract.REMOTE_CONFIG_MAX_DEPTH)), "frozen config.mjs repeats the depth bound");
	// Only the allowlisted file keys exist; no generic path parameter. auth.json is reachable only through the
	// derived read, and it is absent from the patchable FILES map so `config.patch` can never address it.
	assert.ok(source.includes('models: "models.json"'));
	assert.ok(source.includes('settings: "settings.json"'));
	assert.ok(source.includes('trust: "trust.json"'));
	assert.ok(source.includes('mcp: "mcp.json"'));
	assert.ok(source.includes('const READ_AUTH = "auth.json"'), "the derived auth read names the file literally");
	assert.ok(!source.includes("params.path"), "no generic path parameter exists in the config scope");
	assert.equal(contract.REMOTE_CONFIG_MAX_AUTH_PROVIDERS, 200);
	assert.ok(source.includes("MAX_AUTH_PROVIDERS = " + String(contract.REMOTE_CONFIG_MAX_AUTH_PROVIDERS)), "frozen config.mjs repeats the provider bound");
	assert.ok(source.includes(contract.REMOTE_CONFIG_AUTH_PROVIDER_PATTERN.source), "frozen config.mjs repeats the provider-name pattern");
	// The credential values are compared, never copied into the answer.
	assert.ok(source.includes("credential.key.length > 0"), "api_key configured-ness is decided without returning the key");
	assert.ok(source.includes("credential.access.length > 0"), "oauth configured-ness is decided without returning tokens");
	assert.ok(!/providers\.push\(\{[^}]*credential\.(?:key|access|refresh)\b/.test(source), "a token value never enters the provider list");
	// Prototype-pollution and UTF-8 hardening are part of the same frozen artifact.
	assert.ok(source.includes("__proto__"), "frozen config.mjs rejects reserved keys");
	assert.ok(source.includes('new TextDecoder("utf-8", { fatal: true })'), "frozen config.mjs decodes UTF-8 strictly");
	// Real model fields must not be classified as secrets by the shared pattern.
	const secret = new RegExp(contract.REMOTE_CONFIG_SECRET_KEY_PATTERN.source, "i");
	for (const positive of ["apiKey", "OPENAI_API_KEY", "accessToken", "password", "provider_token", "clientSecret", "openaiApiKey", "dbPassword"]) assert.ok(secret.test(positive), positive + " must be a secret name");
	for (const negative of ["maxTokens", "max_tokens", "tokenizer", "tokens", "theme"]) assert.ok(!secret.test(negative), negative + " must not be a secret name");
});

test("the packed config artifact is one byte-frozen ASCII line with its own pin", () => {
	const source = config.REMOTE_CONFIG_SOURCE;
	const digest = createHash("sha256").update(source, "utf8").digest("hex");
	assert.equal(digest, config.REMOTE_HELPER_CONFIG_SHA256, "config.mjs changed without updating its pin");
	assert.equal(Buffer.byteLength(source, "utf8"), source.length, "frozen config artifact stays printable ASCII");
	assert.ok(!/[\r\n]/.test(source), "frozen config artifact is one line");
	assert.ok(!/[\u0000-\u001f\u007f]/.test(source), "no control byte may reach the helper command");
	assert.ok(!source.includes("console."), "stdout carries protocol frames only");
	assert.ok(!/\b(?:eval|Function)\s*\(/.test(source), "no evaluated code");
	assert.ok(!source.includes("require("), "the artifact needs nothing but its parameters and stdlib objects");
	assert.ok(source.length > 1024 && source.length < 96 * 1024, "unexpected artifact size " + source.length);
});

test("the entry re-pins the new artifact and reports the declared build", () => {
	// 不写死版本号：hello 报的版本必须等于源码声明的常量，bump 时只改一处。
	assert.ok(entry.REMOTE_HELPER_INLINE_SOURCE.includes(`"${entry.REMOTE_HELPER_ENTRY_VERSION}"`), "hello must report the declared build");
	const artifacts = Array.from(entry.REMOTE_HELPER_ARTIFACTS, (artifact) => artifact.name);
	assert.deepEqual(artifacts, ["helper.mjs", "git-read.mjs", "git-write.mjs", "git-sync.mjs", "config.mjs", "search-content.mjs", "upload-commit.mjs", "terminal-runner.mjs"]);
	const packed = entry.REMOTE_HELPER_ARTIFACTS.find((artifact) => artifact.name === "config.mjs");
	assert.equal(packed.sha256, config.REMOTE_HELPER_CONFIG_SHA256);
	assert.equal(packed.source, config.REMOTE_CONFIG_SOURCE);
	assert.equal(entry.REMOTE_HELPER_ENTRY_SHA256, createHash("sha256").update(entry.REMOTE_HELPER_INLINE_SOURCE, "utf8").digest("hex"));
});

test("shared remote config codes are the closed set the main backend returns", () => {
	const expected = ["REMOTE_CONFIG_TARGET_INVALID", "REMOTE_CONFIG_HOST_NOT_READY", "REMOTE_CONFIG_UNAVAILABLE", "REMOTE_CONFIG_UNSUPPORTED", "REMOTE_CONFIG_FILE_INVALID", "REMOTE_CONFIG_VERSION_CONFLICT", "REMOTE_CONFIG_RESULT_UNCONFIRMED", "REMOTE_CONFIG_PROVIDER_OPERATION_UNSUPPORTED"];
	assert.deepEqual(Object.values(shared.REMOTE_CONFIG_CODES).sort(), [...expected].sort());
	for (const code of expected) assert.ok(shared.REMOTE_CONFIG_CODE_SET.has(code), code);
	assert.deepEqual([...shared.PI_CONFIG_FILES], ["models", "settings", "trust", "mcp"]);
	assert.deepEqual([...shared.SSH_PI_CONFIG_READ_FILES], ["models", "settings", "trust", "mcp", "auth"]);
	assert.deepEqual([...shared.WSL_PI_CONFIG_FILES], ["models", "settings", "trust", "mcp", "auth"]);
	assert.equal(shared.piConfigFilesForTarget({ kind: "ssh", hostId: "h" }).includes("auth"), false, "ssh must never patch auth.json");
	assert.equal(shared.piConfigReadFilesForTarget({ kind: "ssh", hostId: "h" }).includes("auth"), true, "ssh reads the derived auth view");
});
