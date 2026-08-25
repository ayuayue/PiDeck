import assert from "node:assert/strict";
import test from "node:test";

import { OneDriveObjectStorage } from "../src/main/cloudSync/adapters/OneDriveObjectStorage.ts";
import { createCloudSyncObjectStorage } from "../src/main/cloudSync/adapters/index.ts";
import { normalizeOneDriveConfig } from "../src/main/cloudSync/providerConfig.ts";
import { parseProviderConfigInput } from "../src/main/cloudSync/parseProviderConfig.ts";
import { isCloudSyncConditionalWriteError } from "../src/main/cloudSync/objectStorage.ts";

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
