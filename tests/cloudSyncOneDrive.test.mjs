import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { OneDriveObjectStorage } from "../src/main/cloudSync/adapters/OneDriveObjectStorage.ts";
import { createCloudSyncObjectStorage } from "../src/main/cloudSync/adapters/index.ts";
import { normalizeOneDriveConfig } from "../src/main/cloudSync/providerConfig.ts";
import { parseProviderConfigInput } from "../src/main/cloudSync/parseProviderConfig.ts";
import { isCloudSyncConditionalWriteError } from "../src/main/cloudSync/objectStorage.ts";
import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import { createDefaultExternalEditorSettings } from "../src/shared/types/project.ts";

const CLIENT_ID = "client-123";
const BASE_CONFIG = { clientId: CLIENT_ID, accessToken: "token-1", refreshToken: "refresh-1", expiresAt: Date.now() + 3600_000 };

function jsonResponse(status, body, headers = {}) {
	return {
		status,
		headers: { get(name) { return headers[name] ?? null; } },
		async json() { return body; },
		async arrayBuffer() { return Uint8Array.from(Buffer.from(JSON.stringify(body))).buffer; },
	};
}

function bytesResponse(status, bytes, headers = {}) {
	return {
		status,
		headers: { get(name) { return headers[name] ?? null; } },
		async json() { throw new Error("not json"); },
		// 注意：不能用 Buffer.from(x).buffer —— 小 Buffer 来自共享 slab（8KB 池），
		// 会暴露整块池内存；Uint8Array.from 生成精确大小的 ArrayBuffer。
		async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
	};
}

/** Graph mock：按规范化 item path 存储，支持条件语义与 upload session。 */
function createGraphMock() {
	const items = new Map(); // itemPath -> { eTag, bytes }
	let etagCounter = 0;
	const calls = [];
	let failNextWith401 = false;

	function itemPathFrom(url) {
		const urlObj = new URL(url);
		let path = decodeURIComponent(urlObj.pathname);
		path = path.replace(/^\/v1\.0\/me\/drive\/special\/approot:?/, "");
		return path; // 保留 :/content 与 :/createUploadSession 后缀，分支内处理
	}

	const mock = {
		calls,
		items,
		setFailNextWith401() { failNextWith401 = true; },
		async fetchLike(url, init = {}) {
			const method = init.method ?? "GET";
			const headers = init.headers ?? {};
			calls.push({ url, method, headers });
			if (url.includes("/oauth2/v2.0/token")) {
				return jsonResponse(200, { access_token: "fresh-token", refresh_token: "fresh-refresh", expires_in: 3600 });
			}
			if (failNextWith401 && !url.includes("/oauth2/v2.0/token")) {
				failNextWith401 = false;
				return jsonResponse(401, { error: { code: "unauthenticated" } });
			}
			if (url.includes("createUploadSession")) {
				mock.uploadSessionPath = itemPathFrom(url).replace(/:\/createUploadSession$/, "");
				return jsonResponse(200, { uploadUrl: "https://upload.example.test/session-1" });
			}
			if (url === "https://upload.example.test/session-1") {
				const bytes = Buffer.from(init.body);
				const path = mock.uploadSessionPath ?? "";
				const eTag = `"etag-${++etagCounter}"`;
				items.set(path, { eTag, bytes });
				return jsonResponse(201, { eTag }, { ETag: eTag });
			}
			const path = itemPathFrom(url);
			const isContent = path.endsWith(":/content");
			const itemPath = isContent ? path.slice(0, -":/content".length) : path;
			const existing = items.get(itemPath);
			if (method === "GET") {
				if (itemPath === "") return jsonResponse(200, { eTag: "\"etag-root\"", name: "" }); // approot 根
				if (isContent) {
					if (!existing) return bytesResponse(404, Buffer.alloc(0));
					return bytesResponse(200, existing.bytes, { ETag: existing.eTag });
				}
				if (!existing) return jsonResponse(404, { error: { code: "itemNotFound" } });
				return jsonResponse(200, { eTag: existing.eTag, name: itemPath });
			}
			if (method === "PUT") {
				if (headers["If-None-Match"] === "*" && existing) return jsonResponse(409, { error: { code: "nameAlreadyExists" } });
				if (headers["If-Match"] && existing && headers["If-Match"] !== existing.eTag) return jsonResponse(412, { error: { code: "etagMismatch" } });
				const bytes = Buffer.from(init.body);
				const eTag = `"etag-${++etagCounter}"`;
				items.set(itemPath, { eTag, bytes });
				return jsonResponse(201, { eTag }, { ETag: eTag });
			}
			if (method === "DELETE") {
				if (!existing) return jsonResponse(404, { error: { code: "itemNotFound" } });
				if (headers["If-Match"] && headers["If-Match"] !== existing.eTag) return jsonResponse(412, { error: { code: "etagMismatch" } });
				items.delete(itemPath);
				return jsonResponse(204, {});
			}
			return jsonResponse(400, { error: { code: "badRequest" } });
		},
	};
	return mock;
}

// ── Config / boundary ──────────────────────────────────────────────────────

test("normalizeOneDriveConfig validates clientId and optional tokens", () => {
	assert.equal(normalizeOneDriveConfig({ clientId: "abc" }).clientId, "abc");
	assert.equal(normalizeOneDriveConfig({ clientId: "abc", tenant: "consumers", accessToken: "t", refreshToken: "r", expiresAt: 1 }).tenant, "consumers");
	assert.throws(() => normalizeOneDriveConfig({}), /clientId/);
	assert.throws(() => normalizeOneDriveConfig({ clientId: "" }), /clientId/);
	assert.throws(() => normalizeOneDriveConfig({ clientId: "   " }), /clientId/);
	assert.throws(() => normalizeOneDriveConfig({ clientId: "abc", expiresAt: "soon" }), /expiresAt/);
	assert.throws(() => normalizeOneDriveConfig(null), TypeError);
});

test("parseProviderConfigInput accepts onedrive and rejects invalid shapes", () => {
	assert.deepEqual(parseProviderConfigInput({ provider: "onedrive", config: { clientId: "abc" } }), {
		provider: "onedrive",
		config: { clientId: "abc" },
	});
	assert.throws(() => parseProviderConfigInput({ provider: "onedrive", config: {} }), /OneDrive config is invalid/);
	assert.throws(() => parseProviderConfigInput({ provider: "unknown", config: {} }), /Unknown cloud provider/);
});

test("factory creates the OneDrive adapter for provider onedrive", () => {
	const storage = createCloudSyncObjectStorage("onedrive", BASE_CONFIG);
	assert.ok(storage instanceof OneDriveObjectStorage);
	assert.equal(storage.providerId, "onedrive");
});

// ── Adapter unit tests (mock fetch, no real network) ──────────────────────

test("OneDrive adapter connects by validating the token against approot metadata", async () => {
	const graph = createGraphMock();
	const storage = new OneDriveObjectStorage(BASE_CONFIG, { fetchLike: graph.fetchLike });
	const { account } = await storage.connect();
	assert.equal(account.id, "onedrive");
	assert.deepEqual(await storage.getAccount(), account);
	const metaCall = graph.calls.find((call) => call.url.includes("/me/drive/special/approot") && call.method === "GET");
	assert.ok(metaCall, "connect should validate via approot metadata GET");
	assert.ok(metaCall.headers.Authorization?.startsWith("Bearer "));
	await storage.disconnect();
	assert.equal(await storage.getAccount(), null);
});

test("OneDrive adapter writes, reads and deletes objects with eTag revisions", async () => {
	const graph = createGraphMock();
	const storage = new OneDriveObjectStorage(BASE_CONFIG, { fetchLike: graph.fetchLike });
	await storage.connect();

	const key = "pideck-sessions/session-a.jsonl.enc";
	const bytes = Buffer.from([0, 1, 2, 255]);
	const write = await storage.writeObject(key, bytes);
	assert.equal(write.created, true);
	assert.ok(typeof write.revision === "string" && write.revision.startsWith("\"etag-"));

	const read = await storage.readObject(key);
	assert.equal(read.found, true);
	assert.deepEqual(Buffer.from(read.bytes), bytes);
	assert.equal(read.revision, write.revision);

	// 覆盖写 created=false
	const overwrite = await storage.writeObject(key, Buffer.from("v2"));
	assert.equal(overwrite.created, false);

	assert.deepEqual(await storage.deleteObject(key), { deleted: true });
	assert.deepEqual(await storage.readObject(key), { found: false, key, bytes: null });
	assert.deepEqual(await storage.deleteObject(key), { deleted: false });
});

test("OneDrive adapter honors create-only and conditional writes", async () => {
	const graph = createGraphMock();
	const storage = new OneDriveObjectStorage(BASE_CONFIG, { fetchLike: graph.fetchLike });
	await storage.connect();
	const key = "pideck-index.json";

	assert.equal((await storage.writeObject(key, Buffer.from("a"), { expectedRevision: null })).created, true);
	await assert.rejects(
		() => storage.writeObject(key, Buffer.from("b"), { expectedRevision: null }),
		(error) => isCloudSyncConditionalWriteError(error),
	);

	const current = await storage.readObject(key);
	await assert.rejects(
		() => storage.writeObject(key, Buffer.from("c"), { expectedRevision: "stale" }),
		(error) => isCloudSyncConditionalWriteError(error),
	);
	// 重写成功 → revision 更新，后续条件操作必须用新 revision。
	const rewritten = await storage.writeObject(key, Buffer.from("c"), { expectedRevision: current.revision });
	assert.equal(rewritten.created, false);

	await assert.rejects(
		() => storage.deleteObject(key, { expectedRevision: "stale" }),
		(error) => isCloudSyncConditionalWriteError(error),
	);
	assert.deepEqual(await storage.deleteObject(key, { expectedRevision: rewritten.revision }), { deleted: true });
});

test("OneDrive adapter uses a resumable upload session for objects over 4MB", async () => {
	const graph = createGraphMock();
	const storage = new OneDriveObjectStorage(BASE_CONFIG, { fetchLike: graph.fetchLike });
	await storage.connect();

	const large = Buffer.alloc(4 * 1024 * 1024 + 1, 7);
	const key = "pideck-sessions/big.jsonl.enc";
	const write = await storage.writeObject(key, large);
	assert.equal(write.created, true);
	assert.ok(graph.calls.some((call) => call.url.includes("createUploadSession")), "should create an upload session");
	const ranged = graph.calls.find((call) => call.url === "https://upload.example.test/session-1");
	assert.ok(ranged, "should PUT to the session URL");
	assert.match(ranged.headers["Content-Range"], /^bytes 0-\d+\/\d+$/);
	assert.deepEqual(Buffer.from((await storage.readObject(key)).bytes), large);
});

test("OneDrive adapter refreshes an expired token on 401 and retries", async () => {
	const graph = createGraphMock();
	const expired = { ...BASE_CONFIG, expiresAt: Date.now() - 1000 };
	const storage = new OneDriveObjectStorage(expired, { fetchLike: graph.fetchLike });
	await storage.connect();

	// 第一次内容请求返回 401 → 触发刷新 → 重试成功
	graph.setFailNextWith401();
	const read = await storage.readObject("pideck-index.json");
	assert.equal(read.found, false); // 重试后按 404 处理
	const refreshCalls = graph.calls.filter((call) => call.url.includes("/oauth2/v2.0/token"));
	assert.ok(refreshCalls.length >= 1, "should hit the refresh endpoint");
});

// ── Manager OAuth flow（真实回环回调 + 注入换码，无外部网络） ─────────────

function minimalSettings() {
	return {
		theme: "dark",
		accent: "green",
		favoriteModels: [],
		externalEditors: createDefaultExternalEditorSettings(),
	};
}

test("manager OneDrive OAuth flow completes via loopback callback and configures the provider", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-od-manager-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });

		/** 内存存储替身：OAuth 成功后 configureProvider 自动连接用它，不发真实网络。 */
		const memoryStorage = {
			objects: new Map(),
			async connect() { return { account: { id: "mem", name: "memory" } }; },
			async disconnect() {},
			async getAccount() { return { id: "mem", name: "memory" }; },
			async getCapabilities() { return { revisions: true, conditionalWrites: true, atomicReplacement: true }; },
			async readObject(key) {
				const entry = this.objects.get(key);
				if (!entry) return { found: false, key, bytes: null };
				return { found: true, key, bytes: entry.bytes, revision: entry.revision };
			},
			async writeObject(key, bytes, options) {
				const existing = this.objects.get(key);
				if (options?.expectedRevision === null && existing) {
					const err = new Error("conditional"); err.code = "conditional_write_conflict"; throw err;
				}
				const revision = `rev-${this.objects.size + 1}`;
				this.objects.set(key, { bytes, revision });
				return { created: !existing, revision };
			},
			async deleteObject(key) { return { deleted: this.objects.delete(key) }; },
		};

		let exchangedCode = "";
		const manager = new CloudSyncManager({
			userDataDir,
			homeDir,
			deviceName: "test",
			appVersion: "0.0.0-test",
			listProjects: () => [],
			listSessionRecords: () => [],
			getDesktopSettings: minimalSettings,
			updateDesktopSettings: async () => undefined,
			createAdapter: () => memoryStorage,
			// 注入换码实现：断言收到的参数，返回假 token。
			exchangeOneDriveCode: async (input) => {
				exchangedCode = input.code;
				assert.equal(input.tenant, "consumers");
				assert.ok(input.codeVerifier.length >= 43);
				assert.match(input.redirectUri, /^http:\/\/localhost:\d+$/);
				return { accessToken: "access-from-exchange", refreshToken: "refresh-from-exchange", expiresIn: 3600 };
			},
		});
		await manager.initialize();
		await manager.setupMasterKey("correct horse battery staple");

		const flow = await manager.startOneDriveOAuth("client-oauth-123");
		assert.ok(flow.port > 0);
		assert.match(flow.verificationUrl, /client_id=client-oauth-123/);
		assert.match(flow.verificationUrl, /code_challenge=/);
		assert.match(flow.verificationUrl, /code_challenge_method=S256/);
		assert.match(flow.verificationUrl, /redirect_uri=http%3A%2F%2Flocalhost%3A/);

		// 尚未回调 → pending
		assert.equal((await manager.pollOneDriveOAuth()).status, "pending");

		// 模拟真实回环回调（本地 127.0.0.1，非外部网络）。
		const state = new URL(flow.verificationUrl).searchParams.get("state");
		const callback = await fetch(`http://127.0.0.1:${flow.port}/?code=the-auth-code&state=${state}`);
		assert.equal(callback.status, 200);

		// 轮询：先仍可能 pending（回调落盘有延迟），重试直到 ok。
		let result = await manager.pollOneDriveOAuth();
		for (let i = 0; i < 10 && result.status === "pending"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			result = await manager.pollOneDriveOAuth();
		}
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(exchangedCode, "the-auth-code");

		// OAuth 成功后自动完成 provider 配置并自动连接（快照 connected）。
		const snapshot = manager.getStateSnapshot();
		assert.equal(snapshot.providers.onedrive.configured, true);
		assert.equal(snapshot.providers.onedrive.status, "connected");

		// 错误状态：无活动流程。
		assert.equal((await manager.pollOneDriveOAuth()).status, "error");

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("manager OneDrive OAuth rejects a callback with a mismatched state", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-od-manager-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });
		const manager = new CloudSyncManager({
			userDataDir,
			homeDir,
			deviceName: "test",
			appVersion: "0.0.0-test",
			listProjects: () => [],
			listSessionRecords: () => [],
			getDesktopSettings: minimalSettings,
			updateDesktopSettings: async () => undefined,
			exchangeOneDriveCode: async () => { throw new Error("should not be called"); },
		});
		await manager.initialize();
		await manager.setupMasterKey("correct horse battery staple");

		const flow = await manager.startOneDriveOAuth("client-oauth-123");
		// 错误 state → 回调返回 404，flow 保持 pending。
		const callback = await fetch(`http://127.0.0.1:${flow.port}/?code=x&state=wrong-state`);
		assert.equal(callback.status, 404);
		assert.equal((await manager.pollOneDriveOAuth()).status, "pending");

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
