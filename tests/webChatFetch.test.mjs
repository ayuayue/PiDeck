/**
 * /api/chat 重试中间件单测：只在「一个字节都没回来」的网络异常上重试一次，
 * 且必须是同体重放（服务端按 sessionId+messageId 去重，换体会变成第二条 prompt）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRetryingChatFetch, WEB_CHAT_RETRY_DELAY_MS } = loadTsCommonJs("src/renderer/src/web/webChatFetch.ts");

const body = JSON.stringify({ messages: [], sessionId: "s1", messageId: "m1" });

test("首个连接静默死掉时用同一份请求体重试一次", async () => {
	const seen = [];
	let attempt = 0;
	const baseFetch = async (input, init) => {
		attempt += 1;
		seen.push({ url: String(input), body: init?.body });
		if (attempt === 1) throw new TypeError("Failed to fetch");
		return new Response("ok");
	};
	const fetchImpl = createRetryingChatFetch(baseFetch, 0);
	const response = await fetchImpl("/api/chat", { method: "POST", body });

	assert.equal(await response.text(), "ok");
	assert.equal(attempt, 2, "恰好重试一次");
	assert.deepEqual(seen[0], seen[1], "重试必须同 URL 同 body（幂等键不变）");
});

test("第一次就成功时不重试", async () => {
	let attempt = 0;
	const fetchImpl = createRetryingChatFetch(async () => {
		attempt += 1;
		return new Response("ok");
	}, 0);
	await fetchImpl("/api/chat", { method: "POST", body });
	assert.equal(attempt, 1);
});

test("两次都失败时把错误抛给调用方（仍然是一次重试，不放大）", async () => {
	let attempt = 0;
	const fetchImpl = createRetryingChatFetch(async () => {
		attempt += 1;
		throw new TypeError("Failed to fetch");
	}, 0);
	await assert.rejects(() => fetchImpl("/api/chat", { method: "POST", body }), /Failed to fetch/);
	assert.equal(attempt, 2);
});

test("用户已中止时不重试（停止按钮点了就不再投递）", async () => {
	let attempt = 0;
	const controller = new AbortController();
	const fetchImpl = createRetryingChatFetch(async () => {
		attempt += 1;
		controller.abort();
		throw new DOMException("aborted", "AbortError");
	}, 0);
	await assert.rejects(() => fetchImpl("/api/chat", { method: "POST", body, signal: controller.signal }));
	assert.equal(attempt, 1);
});

test("不可重放的请求体（流式/表单）直接抛原错误", async () => {
	let attempt = 0;
	const fetchImpl = createRetryingChatFetch(async () => {
		attempt += 1;
		throw new TypeError("Failed to fetch");
	}, 0);
	await assert.rejects(() => fetchImpl("/api/upload", { method: "POST", body: new FormData() }), /Failed to fetch/);
	assert.equal(attempt, 1);
});

test("重试前的等待取 WEB_CHAT_RETRY_DELAY_MS（留时间丢弃死连接）", () => {
	assert.ok(WEB_CHAT_RETRY_DELAY_MS > 0);
});
