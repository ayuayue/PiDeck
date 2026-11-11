import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * RemotePiConfigBackend (Batch A): request shape, reply re-validation and closed-code mapping.
 * A fake transport stands in for a ready helper session; no process, file or network is involved.
 */

const backendModule = loadTsCommonJs("src/main/config/RemotePiConfigBackend.ts");
const shared = loadTsCommonJs("src/shared/piConfig.ts");
const contract = loadTsCommonJs("src/main/remote/RemoteHelperContract.ts");

const HOST = "11111111-1111-4111-8111-111111111111";
const VERSION = "a".repeat(64);
const MODEL_DATA = { providers: { openai: { baseUrl: "https://example.test", apiKey: "configured", models: [] } }, unknownTop: 1 };
const SECRETS = [{ path: "providers.openai.apiKey", status: "configured" }];

function snapshot(overrides = {}) {
	return { version: VERSION, sha256: VERSION, data: MODEL_DATA, secrets: SECRETS, ...overrides };
}

function harness(respond = () => snapshot()) {
	const calls = [];
	const transport = {
		async request(hostId, method, params) {
			calls.push({ hostId, method, params });
			const result = respond({ hostId, method, params, index: calls.length - 1 });
			if (result instanceof Error) throw result;
			return result;
		},
	};
	return { calls, backend: backendModule.createRemotePiConfigBackend(transport) };
}

async function rejectionCode(run) {
	try {
		await run();
	} catch (error) {
		return typeof error?.message === "string" ? error.message : String(error);
	}
	throw new Error("EXPECTED_REJECTION");
}

test("read/patch address one allowlisted file through the injected host transport only", async () => {
	const h = harness();
	const read = await h.backend.read({ hostId: HOST, file: "models" });
	assert.equal(read.kind, "remote");
	assert.equal(read.hostId, HOST);
	assert.equal(read.file, "models");
	assert.equal(read.version, VERSION);
	assert.deepEqual(JSON.parse(JSON.stringify(read.data)), MODEL_DATA);
	assert.deepEqual(JSON.parse(JSON.stringify(read.secrets)), SECRETS);
	assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { hostId: HOST, method: "config.read", params: { file: "models" } });

	const receipt = await h.backend.patch({ hostId: HOST, file: "models", expectedVersion: VERSION, patch: { providers: { openai: { baseUrl: "https://next.test" } } } });
	assert.deepEqual(JSON.parse(JSON.stringify(receipt)), { kind: "remote", hostId: HOST, file: "models", version: VERSION, sha256: VERSION });
	assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), { hostId: HOST, method: "config.patch", params: { file: "models", expectedVersion: VERSION, patch: { providers: { openai: { baseUrl: "https://next.test" } } } } });
});

test("every helper reply is re-validated before it can reach the caller", async () => {
	const bad = [
		{ name: "non-object", value: "nope" },
		{ name: "version shape", value: snapshot({ version: "xyz" }) },
		{ name: "version != sha", value: snapshot({ sha256: "b".repeat(64) }) },
		{ name: "data not object", value: snapshot({ data: [] }) },
		{ name: "models without providers", value: snapshot({ data: {}, secrets: [] }) },
		{ name: "plaintext secret", value: snapshot({ data: { providers: { openai: { apiKey: "sk-live-1" } } }, secrets: [] }) },
		{ name: "secret list mismatch", value: snapshot({ secrets: [] }) },
		{ name: "secret status invalid", value: snapshot({ data: { providers: { openai: { apiKey: "plain" } } }, secrets: [{ path: "providers.openai.apiKey", status: "configured" }] }) },
	];
	for (const entry of bad) {
		const h = harness(() => entry.value);
		assert.equal(await rejectionCode(() => h.backend.read({ hostId: HOST, file: "models" })), shared.REMOTE_CONFIG_CODES.fileInvalid, entry.name);
	}
});

test("helper and connection codes collapse into the shared closed set without leaking raw text", async () => {
	const cases = [
		["CONFIG_FILE_INVALID", shared.REMOTE_CONFIG_CODES.fileInvalid],
		["CONFIG_FILE_TOO_LARGE", shared.REMOTE_CONFIG_CODES.fileInvalid],
		["CONFIG_PATH_UNSUPPORTED", shared.REMOTE_CONFIG_CODES.fileInvalid],
		["CONFIG_VERSION_CONFLICT", shared.REMOTE_CONFIG_CODES.versionConflict],
		["CONFIG_RESULT_UNCONFIRMED", shared.REMOTE_CONFIG_CODES.resultUnconfirmed],
		["CONFIG_UNAVAILABLE", shared.REMOTE_CONFIG_CODES.unavailable],
		["METHOD_NOT_FOUND", shared.REMOTE_CONFIG_CODES.unsupported],
		["SSH_HOST_NOT_READY", shared.REMOTE_CONFIG_CODES.hostNotReady],
		["SSH_HOST_DISCONNECTED", shared.REMOTE_CONFIG_CODES.hostNotReady],
		["REMOTE_CONNECTION_LOST", shared.REMOTE_CONFIG_CODES.hostNotReady],
		["REQUEST_TIMEOUT", shared.REMOTE_CONFIG_CODES.hostNotReady],
		["SOMETHING_UNKNOWN", shared.REMOTE_CONFIG_CODES.unavailable],
	];
	for (const [helperCode, expected] of cases) {
		const h = harness(() => Object.assign(new Error("raw helper text must not leak"), { code: helperCode }));
		const code = await rejectionCode(() => h.backend.read({ hostId: HOST, file: "settings" }));
		assert.equal(code, expected, helperCode);
	}
	// A plain transport error is UNAVAILABLE, never a local read.
	const h = harness(() => new Error("socket closed"));
	assert.equal(await rejectionCode(() => h.backend.read({ hostId: HOST, file: "settings" })), shared.REMOTE_CONFIG_CODES.unavailable);
});

test("trust/mcp 与 models/settings 同一条白名单通道；auth 始终被拒", async () => {
	// 每个允许的文件都真实发出同一种 config.read/config.patch 帧（不新增方法，不新增能力位）。
	for (const file of ["trust", "mcp"]) {
		const h = harness(({ method }) => (file === "mcp" ? snapshot({ data: { mcpServers: {} }, secrets: [] }) : snapshot({ data: { "/srv/work": true }, secrets: [] })));
		const read = await h.backend.read({ hostId: HOST, file });
		assert.equal(read.file, file);
		assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { hostId: HOST, method: "config.read", params: { file } });
		const patch = file === "mcp" ? { mcpServers: { docs: { url: "https://example.test/mcp" } } } : { "/srv/work": false };
		const receipt = await h.backend.patch({ hostId: HOST, file, expectedVersion: VERSION, patch });
		assert.equal(receipt.file, file);
		assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])), { hostId: HOST, method: "config.patch", params: { file, expectedVersion: VERSION, patch } });
	}
	// mcpServers 必须是对象：数组/字符串会让 pi 拒绝整份文件，主进程在发出请求前就拦住。
	const badShape = harness(() => snapshot({ data: { mcpServers: [] }, secrets: [] }));
	assert.equal(await rejectionCode(() => badShape.backend.read({ hostId: HOST, file: "mcp" })), shared.REMOTE_CONFIG_CODES.fileInvalid);
	assert.deepEqual(badShape.calls.length, 1, "畸形回包是读之后才发现：只发一次读，不发写");
	// auth 结构性不可达：config 白名单里没有它，连传输层都不该被触达。
	const auth = harness();
	assert.equal(await rejectionCode(() => auth.backend.read({ hostId: HOST, file: "auth" })), shared.REMOTE_CONFIG_CODES.targetInvalid);
	assert.deepEqual(auth.calls, []);
});

test("readAuth 只接受派生视图：任何无值字段或多余字段都被拒，且不退回本机读盘", async () => {
	const view = {
		version: VERSION,
		sha256: VERSION,
		providers: [
			{ provider: "openai", type: "api_key", configured: true },
			{ provider: "anthropic", type: "oauth", configured: false },
		],
	};
	const h = harness(() => view);
	const snapshot = await h.backend.readAuth({ hostId: HOST });
	assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { kind: "remote-auth", hostId: HOST, version: VERSION, sha256: VERSION, providers: view.providers });
	assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0])), { hostId: HOST, method: "config.readAuth", params: {} });

	const bad = [
		{ name: "non-object", value: "nope" },
		{ name: "version shape", value: { ...view, version: "xyz" } },
		{ name: "version != sha", value: { ...view, sha256: "b".repeat(64) } },
		{ name: "providers not array", value: { ...view, providers: {} } },
		{ name: "too many providers", value: { ...view, providers: Array.from({ length: contract.REMOTE_CONFIG_MAX_AUTH_PROVIDERS + 1 }, (_, index) => ({ provider: "p" + index, type: "api_key", configured: true })) } },
		{ name: "unknown type", value: { ...view, providers: [{ provider: "openai", type: "session", configured: true }] } },
		{ name: "configured not boolean", value: { ...view, providers: [{ provider: "openai", type: "api_key", configured: "yes" }] } },
		{ name: "bad provider name", value: { ...view, providers: [{ provider: "bad name", type: "api_key", configured: true }] } },
		{
			name: "duplicate provider",
			value: {
				...view,
				providers: [
					{ provider: "openai", type: "api_key", configured: true },
					{ provider: "openai", type: "oauth", configured: false },
				],
			},
		},
		// 带值的回包是本层必须拒的形状：不接受「多余的字段」，哪怕它看起来只是额外信息。
		{ name: "credential value smuggled in", value: { ...view, providers: [{ provider: "openai", type: "api_key", configured: true, key: "sk-live" }] } },
	];
	for (const entry of bad) {
		const broken = harness(() => entry.value);
		assert.equal(await rejectionCode(() => broken.backend.readAuth({ hostId: HOST })), shared.REMOTE_CONFIG_CODES.fileInvalid, entry.name);
	}
	assert.equal(await rejectionCode(() => harness().backend.readAuth({ hostId: "not-a-host" })), shared.REMOTE_CONFIG_CODES.targetInvalid);
});

test("invalid inputs are refused before the transport is called", async () => {
	const h = harness();
	for (const hostId of ["not-a-host", "", "11111111-1111-4111-8111-11111111111Z"]) {
		assert.equal(await rejectionCode(() => h.backend.read({ hostId, file: "models" })), shared.REMOTE_CONFIG_CODES.targetInvalid);
	}
	assert.equal(await rejectionCode(() => h.backend.read({ hostId: HOST, file: "auth" })), shared.REMOTE_CONFIG_CODES.targetInvalid);
	assert.equal(await rejectionCode(() => h.backend.patch({ hostId: HOST, file: "models", expectedVersion: "forged", patch: {} })), shared.REMOTE_CONFIG_CODES.versionConflict);
	assert.equal(await rejectionCode(() => h.backend.patch({ hostId: HOST, file: "models", expectedVersion: VERSION, patch: [] })), shared.REMOTE_CONFIG_CODES.fileInvalid);
	// Depth and size are bounded before the helper sees the patch.
	let deep = { leaf: true };
	for (let index = 0; index < contract.REMOTE_CONFIG_MAX_DEPTH + 2; index += 1) deep = { nested: deep };
	assert.equal(await rejectionCode(() => h.backend.patch({ hostId: HOST, file: "models", expectedVersion: VERSION, patch: deep })), shared.REMOTE_CONFIG_CODES.fileInvalid);
	const wide = { blob: "x".repeat(contract.REMOTE_CONFIG_MAX_FILE_BYTES + 16) };
	assert.equal(await rejectionCode(() => h.backend.patch({ hostId: HOST, file: "models", expectedVersion: VERSION, patch: wide })), shared.REMOTE_CONFIG_CODES.fileInvalid);
	assert.deepEqual(h.calls, []);
	// Constructor shape is fail-closed too.
	assert.equal(await rejectionCode(async () => backendModule.createRemotePiConfigBackend({})), shared.REMOTE_CONFIG_CODES.unavailable);
});

test("reserved keys are rejected recursively before any transport call", async () => {
	const h = harness();
	const ownProto = JSON.parse('{"__proto__":{"polluted":"yes"}}');
	const nested = JSON.parse('{"providers":{"p":{"constructor":{"prototype":{"x":1}}}}}');
	for (const patch of [ownProto, nested, { settings: { prototype: 1 } }]) {
		assert.equal(await rejectionCode(() => h.backend.patch({ hostId: HOST, file: "models", expectedVersion: VERSION, patch })), shared.REMOTE_CONFIG_CODES.fileInvalid);
	}
	assert.deepEqual(h.calls, [], "no patch carrying a reserved key may reach the host");
});

test("the backend never imports the local ConfigManager or a filesystem module", () => {
	const source = readFileSync("src/main/config/RemotePiConfigBackend.ts", "utf8");
	assert.doesNotMatch(source, /from "[^"]*ConfigManager/);
	assert.doesNotMatch(source, /configManager\./);
	assert.doesNotMatch(source, /node:fs|node:child_process|node:os/);
	assert.match(source, /transport.request/);
});
