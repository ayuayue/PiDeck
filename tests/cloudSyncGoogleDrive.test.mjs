import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GoogleDriveObjectStorage } from "../src/main/cloudSync/adapters/GoogleDriveObjectStorage.ts";
import { createCloudSyncObjectStorage } from "../src/main/cloudSync/adapters/index.ts";
import { normalizeGoogleDriveConfig } from "../src/main/cloudSync/providerConfig.ts";
import { parseProviderConfigInput } from "../src/main/cloudSync/parseProviderConfig.ts";
import { isCloudSyncConditionalWriteError } from "../src/main/cloudSync/objectStorage.ts";
import { CloudSyncManager } from "../src/main/cloudSync/CloudSyncManager.ts";
import { createDefaultExternalEditorSettings } from "../src/shared/types/project.ts";

const CLIENT_ID = "1234567890-client.apps.googleusercontent.com";
const BASE_CONFIG = { clientId: CLIENT_ID, accessToken: "token-1", refreshToken: "refresh-1", expiresAt: Date.now() + 3600_000 };

function jsonResponse(status, body, headers = {}) {
	return {
		status,
		headers: { get(name) { return headers[name] ?? null; } },
		async json() { return body; },
		async arrayBuffer() { return Uint8Array.from(Buffer.from(JSON.stringify(body))).buffer; },
		async text() { return JSON.stringify(body); },
	};
}

function bytesResponse(status, bytes, headers = {}) {
	return {
		status,
		headers: { get(name) { return headers[name] ?? null; } },
		async json() { throw new Error("not json"); },
		// 小 Buffer 来自共享 slab，必须用 Uint8Array.from 生成精确大小的 ArrayBuffer。
		async arrayBuffer() { return Uint8Array.from(bytes).buffer; },
		async text() { throw new Error("not text"); },
	};
}

/** Drive API mock：files 按 base64url 文件名存储，模拟条件写与 resumable session。 */
function createDriveMock() {
	const files = new Map(); // name -> { id, etag, bytes }
	let idCounter = 0;
	let etagCounter = 0;
	const calls = [];
	let failNextWith401 = false;
	let pendingSessionName = "";

	function nameFromQuery(url) {
		const query = new URL(url).searchParams.get("q") ?? "";
		const match = /name='([^']*)'/.exec(query);
		return match ? match[1] : "";
	}

	const mock = {
		calls,
		files,
		setFailNextWith401() { failNextWith401 = true; },
		async fetchLike(url, init = {}) {
			const method = init.method ?? "GET";
			const headers = init.headers ?? {};
			calls.push({ url, method, headers });
			if (url.includes("oauth2.googleapis.com/token")) {
				return jsonResponse(200, { access_token: "fresh-token", refresh_token: "fresh-refresh", expires_in: 3600 });
			}
			if (failNextWith401 && !url.includes("/token")) {
				failNextWith401 = false;
				return jsonResponse(401, { error: { code: 401 } });
			}
			// connect 校验：空列表
			if (method === "GET" && url.includes("pageSize=1")) {
				return jsonResponse(200, { files: [] });
			}
			// resumable session 初始化
			if (method === "POST" && url.includes("uploadType=resumable")) {
				const metadata = JSON.parse(String(init.body ?? "{}"));
				pendingSessionName = metadata.name ?? "";
				return {
					status: 200,
					headers: { get(name) { return name.toLowerCase() === "location" ? "https://upload.example.test/session-1" : null; } },
					async json() { return {}; },
					async arrayBuffer() { return new ArrayBuffer(0); },
					async text() { return ""; },
				};
			}
			// resumable 分段上传
			if (url === "https://upload.example.test/session-1") {
				const name = pendingSessionName;
				const bytes = Buffer.from(init.body);
				const eTag = `"etag-${++etagCounter}"`;
				files.set(name, { id: `id-${++idCounter}`, name, eTag, bytes });
				return jsonResponse(200, { etag: eTag }, { ETag: eTag });
			}
			// 新建元数据
			if (method === "POST" && url.includes("/drive/v3/files?fields=id,etag")) {
				const metadata = JSON.parse(String(init.body ?? "{}"));
				const id = `id-${++idCounter}`;
				files.set(metadata.name, { id, name: metadata.name, eTag: `"etag-${++etagCounter}"`, bytes: Buffer.alloc(0) });
				return jsonResponse(200, { id, etag: files.get(metadata.name).eTag });
			}
			// 媒体更新（简单上传）
			const mediaMatch = /\/files\/(id-\d+)\?uploadType=media/.exec(url);
			if (method === "PATCH" && mediaMatch) {
				const entry = [...files.values()].find((item) => item.id === mediaMatch[1]);
				if (!entry) return jsonResponse(404, {});
				if (headers["If-Match"] && headers["If-Match"] !== entry.eTag) return jsonResponse(412, {});
				entry.bytes = Buffer.from(init.body);
				entry.eTag = `"etag-${++etagCounter}"`;
				return jsonResponse(200, { etag: entry.eTag }, { ETag: entry.eTag });
			}
			// 查找
			if (method === "GET" && url.includes("spaces=appDataFolder&q=")) {
				const name = nameFromQuery(url);
				const entry = files.get(name);
				return jsonResponse(200, {
					files: entry ? [{ id: entry.id, name: entry.name, etag: entry.eTag, md5Checksum: "x", size: String(entry.bytes.length) }] : [],
				});
			}
			// 下载内容
			const altMedia = /\/files\/(id-\d+)\?alt=media/.exec(url);
			if (method === "GET" && altMedia) {
				const entry = [...files.values()].find((item) => item.id === altMedia[1]);
				if (!entry) return bytesResponse(404, Buffer.alloc(0));
				return bytesResponse(200, entry.bytes, { ETag: entry.eTag });
			}
			// 删除
			const deleteMatch = /\/files\/(id-\d+)$/.exec(url);
			if (method === "DELETE" && deleteMatch) {
				const entry = [...files.values()].find((item) => item.id === deleteMatch[1]);
				if (!entry) return jsonResponse(404, {});
				if (headers["If-Match"] && headers["If-Match"] !== entry.eTag) return jsonResponse(412, {});
				files.delete(entry.name);
				return jsonResponse(204, {});
			}
			return jsonResponse(400, { error: { code: 400, message: `unhandled ${method} ${url}` } });
		},
	};
	return mock;
}

// ── Config / boundary ──────────────────────────────────────────────────────

test("normalizeGoogleDriveConfig validates clientId and optional fields", () => {
	assert.equal(normalizeGoogleDriveConfig({ clientId: "abc" }).clientId, "abc");
	assert.equal(normalizeGoogleDriveConfig({ clientId: "abc", clientSecret: "s", accessToken: "t", refreshToken: "r", expiresAt: 1 }).clientSecret, "s");
	assert.throws(() => normalizeGoogleDriveConfig({}), /clientId/);
	assert.throws(() => normalizeGoogleDriveConfig({ clientId: "   " }), /clientId/);
	assert.throws(() => normalizeGoogleDriveConfig({ clientId: "abc", expiresAt: "soon" }), /expiresAt/);
	assert.throws(() => normalizeGoogleDriveConfig(null), TypeError);
});

test("parseProviderConfigInput accepts google and rejects invalid shapes", () => {
	assert.deepEqual(parseProviderConfigInput({ provider: "google", config: { clientId: "abc" } }), {
		provider: "google",
		config: { clientId: "abc" },
	});
	assert.throws(() => parseProviderConfigInput({ provider: "google", config: {} }), /Google Drive config is invalid/);
	assert.throws(() => parseProviderConfigInput({ provider: "unknown", config: {} }), /Unknown cloud provider/);
});

test("factory creates the Google Drive adapter for provider google", () => {
	const storage = createCloudSyncObjectStorage("google", BASE_CONFIG);
	assert.ok(storage instanceof GoogleDriveObjectStorage);
	assert.equal(storage.providerId, "google");
});

// ── Adapter unit tests (mock fetch, no real network) ──────────────────────

test("Google Drive adapter connects by listing appDataFolder", async () => {
	const graph = createDriveMock();
	const storage = new GoogleDriveObjectStorage(BASE_CONFIG, { fetchLike: graph.fetchLike });
	const { account } = await storage.connect();
	assert.equal(account.id, "google");
	assert.deepEqual(await storage.getAccount(), account);
	const listCall = graph.calls.find((call) => call.url.includes("pageSize=1"));
	assert.ok(listCall, "connect should validate via appDataFolder list");
	assert.ok(listCall.headers.Authorization?.startsWith("Bearer "));
	await storage.disconnect();
	assert.equal(await storage.getAccount(), null);
});

test("Google Drive adapter writes, reads and deletes objects with eTag revisions", async () => {
	const graph = createDriveMock();
	const storage = new GoogleDriveObjectStorage(BASE_CONFIG, { fetchLike: graph.fetchLike });
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

	// 文件名是 base64url(key)（Drive 文件名不允许 "/"）
	const storedName = Buffer.from(key, "utf8").toString("base64url");
	assert.ok(graph.files.has(storedName), "file should be stored under the encoded name");

	const overwrite = await storage.writeObject(key, Buffer.from("v2"));
	assert.equal(overwrite.created, false);

	assert.deepEqual(await storage.deleteObject(key), { deleted: true });
	assert.deepEqual(await storage.readObject(key), { found: false, key, bytes: null });
	assert.deepEqual(await storage.deleteObject(key), { deleted: false });
});

test("Google Drive adapter honors create-only and conditional writes", async () => {
	const graph = createDriveMock();
	const storage = new GoogleDriveObjectStorage(BASE_CONFIG, { fetchLike: graph.fetchLike });
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
	const rewritten = await storage.writeObject(key, Buffer.from("c"), { expectedRevision: current.revision });
	assert.equal(rewritten.created, false);

	await assert.rejects(
		() => storage.deleteObject(key, { expectedRevision: "stale" }),
		(error) => isCloudSyncConditionalWriteError(error),
	);
	assert.deepEqual(await storage.deleteObject(key, { expectedRevision: rewritten.revision }), { deleted: true });
});

test("Google Drive adapter uses a resumable session for objects over 5MB", async () => {
	const graph = createDriveMock();
	const storage = new GoogleDriveObjectStorage(BASE_CONFIG, { fetchLike: graph.fetchLike });
	await storage.connect();

	const large = Buffer.alloc(5 * 1024 * 1024 + 1, 7);
	const key = "pideck-sessions/big.jsonl.enc";
	const write = await storage.writeObject(key, large);
	assert.equal(write.created, true);
	assert.ok(graph.calls.some((call) => call.url.includes("uploadType=resumable")), "should create a resumable session");
	const ranged = graph.calls.find((call) => call.url === "https://upload.example.test/session-1");
	assert.ok(ranged, "should PUT to the session URL");
	assert.match(ranged.headers["Content-Range"], /^bytes 0-\d+\/\d+$/);
	assert.deepEqual(Buffer.from((await storage.readObject(key)).bytes), large);
});

test("Google Drive adapter refreshes an expired token on 401 and retries", async () => {
	const graph = createDriveMock();
	const expired = { ...BASE_CONFIG, expiresAt: Date.now() - 1000 };
	const storage = new GoogleDriveObjectStorage(expired, { fetchLike: graph.fetchLike });
	await storage.connect();

	graph.setFailNextWith401();
	const read = await storage.readObject("pideck-index.json");
	assert.equal(read.found, false); // 重试后按 404 处理
	const refreshCalls = graph.calls.filter((call) => call.url.includes("oauth2.googleapis.com/token"));
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

test("manager Google OAuth flow completes via loopback callback and configures the provider", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-google-mgr-"));
	try {
		const userDataDir = join(base, "userData");
		const homeDir = join(base, "home");
		await mkdir(homeDir, { recursive: true });

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
			exchangeGoogleCode: async (input) => {
				exchangedCode = input.code;
				assert.equal(input.clientSecret, "secret-123");
				assert.ok(input.codeVerifier.length >= 43);
				assert.match(input.redirectUri, /^http:\/\/localhost:\d+$/);
				return { accessToken: "access-from-exchange", refreshToken: "refresh-from-exchange", expiresIn: 3600 };
			},
		});
		await manager.initialize();
		await manager.setupMasterKey("correct horse battery staple");

		const flow = await manager.startGoogleOAuth("client-google-123", "secret-123");
		assert.ok(flow.port > 0);
		assert.match(flow.verificationUrl, /client_id=client-google-123/);
		assert.match(flow.verificationUrl, /code_challenge=/);
		assert.match(flow.verificationUrl, /code_challenge_method=S256/);
		assert.match(flow.verificationUrl, /access_type=offline/);
		assert.match(flow.verificationUrl, /drive.appfolder/);

		assert.equal((await manager.pollGoogleOAuth()).status, "pending");

		const state = new URL(flow.verificationUrl).searchParams.get("state");
		const callback = await fetch(`http://127.0.0.1:${flow.port}/?code=the-auth-code&state=${state}`);
		assert.equal(callback.status, 200);

		let result = await manager.pollGoogleOAuth();
		for (let i = 0; i < 10 && result.status === "pending"; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			result = await manager.pollGoogleOAuth();
		}
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(exchangedCode, "the-auth-code");

		const snapshot = manager.getStateSnapshot();
		assert.equal(snapshot.providers.google.configured, true);
		assert.equal(snapshot.providers.google.status, "connected");

		assert.equal((await manager.pollGoogleOAuth()).status, "error");

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("manager Google OAuth rejects a callback with a mismatched state", async () => {
	const base = await mkdtemp(join(tmpdir(), "pideck-google-mgr-"));
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
			exchangeGoogleCode: async () => { throw new Error("should not be called"); },
		});
		await manager.initialize();
		await manager.setupMasterKey("correct horse battery staple");

		const flow = await manager.startGoogleOAuth("client-google-123");
		const callback = await fetch(`http://127.0.0.1:${flow.port}/?code=x&state=wrong-state`);
		assert.equal(callback.status, 404);
		assert.equal((await manager.pollGoogleOAuth()).status, "pending");

		await manager.dispose();
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});
