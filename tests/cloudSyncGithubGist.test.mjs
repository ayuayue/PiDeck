import assert from "node:assert/strict";
import test from "node:test";

import {
	GithubGistObjectStorage,
	startGithubDeviceFlow,
	pollGithubDeviceFlow,
} from "../src/main/cloudSync/adapters/GithubGistObjectStorage.ts";

/** 内存假 GitHub API：按 URL 路由到 gist 对象存储。 */
function fakeGithub(gistFiles) {
	const files = new Map(Object.entries(gistFiles ?? {}));
	let revisionCounter = 0;
	const updatedAt = () => `rev-${++revisionCounter}`;
	const gistPayload = () => ({
		id: "gist-1",
		description: "PiDeck cloud sync (end-to-end encrypted)",
		updated_at: updatedAt(),
		files: Object.fromEntries([...files.entries()].map(([name, content]) => [name, { content }])),
	});
	const fetchImpl = async (url, init) => {
		if (url.includes("/login/device/code")) {
			return { status: 200, json: async () => ({ device_code: "dc-1", user_code: "AB12-CD34", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 }), text: async () => "" };
		}
		if (url.includes("/login/oauth/access_token")) {
			return { status: 200, json: async () => ({ access_token: "gho_token_123" }), text: async () => "" };
		}
		if (url.includes("/gists?per_page=100")) {
			return { status: 200, json: async () => [gistPayload()], text: async () => "" };
		}
		if (/\/gists\/[^/]+$/.test(url) && init?.method === "PATCH") {
			const body = JSON.parse(init.body ?? "{}");
			for (const [name, value] of Object.entries(body.files ?? {})) {
				if (value === null) files.delete(name);
				else files.set(name, value.content);
			}
			return { status: 200, json: async () => gistPayload(), text: async () => "" };
		}
		if (/\/gists\/[^/]+$/.test(url) && (init?.method === "GET" || !init?.method)) {
			return { status: 200, json: async () => gistPayload(), text: async () => "" };
		}
		if (url.endsWith("/gists") && init?.method === "POST") {
			return { status: 201, json: async () => gistPayload(), text: async () => "" };
		}
		return { status: 404, json: async () => ({}), text: async () => "not found" };
	};
	return { files, fetchImpl, gistPayload };
}

test("github device flow parses start and polls for the access token", async () => {
	const { fetchImpl } = fakeGithub({});
	const start = await startGithubDeviceFlow("client-123", fetchImpl);
	assert.equal(start.userCode, "AB12-CD34");
	assert.equal(start.verificationUrl, "https://github.com/login/device");
	const token = await pollGithubDeviceFlow("client-123", "dc-1", fetchImpl);
	assert.equal(token.accessToken, "gho_token_123");
});

test("github gist storage reads and writes encrypted objects", async () => {
	const { files, fetchImpl } = fakeGithub({ "pideck-index.json": "{}" });
	const storage = new GithubGistObjectStorage({ token: "gho_token_123" }, fetchImpl);
	const { account } = await storage.connect();
	assert.ok(account.id);
	assert.equal(files.get("pideck-index.json"), "{}");

	// 写入对象：以 base64 承载密文（Gist 文件是 UTF-8 文本）
	await storage.writeObject("pideck-sessions/s1.jsonl.enc", Buffer.from("ciphertext-bytes"));
	const written = files.get("pideck-sessions/s1.jsonl.enc");
	assert.equal(written, Buffer.from("ciphertext-bytes").toString("base64"));

	// 读回
	const read = await storage.readObject("pideck-sessions/s1.jsonl.enc");
	assert.equal(read.found, true);
	assert.equal(Buffer.from(read.bytes).toString("utf8"), Buffer.from("ciphertext-bytes").toString("base64"));

	// 删除
	const deleted = await storage.deleteObject("pideck-sessions/s1.jsonl.enc");
	assert.equal(deleted.deleted, true);
	assert.equal(files.has("pideck-sessions/s1.jsonl.enc"), false);

	// 未授权 token → API 报错不落地
	const bad = new GithubGistObjectStorage({ token: "bad" }, async () => ({ status: 401, json: async () => ({}), text: async () => "unauthorized" }));
	await assert.rejects(() => bad.connect(), /401/);

	// gist 已有 → 复用而非重建（创建后描述一致）
	const storage2 = new GithubGistObjectStorage({ token: "t" }, fetchImpl);
	await storage2.connect();
	assert.equal(storage2["gistId"], "gist-1");
});
