import test from "node:test";
import assert from "node:assert/strict";
import { createSendHarness } from "./helpers/sessionSendHarness.mjs";

/**
 * 发送期模板表补齐（回归）。
 *
 * 现场（2026-10 e2e 抓到）：agent 还在收尾时发送 `/模板名` 走的是**队列分支**——它在
 * 入队时就展开，比 prepareMessage 更早。若此刻模板表还没加载（刚打开会话 / runtime 刚绑定），
 * 展开器认不出模板名，消息原样入队，flush 时直接发给 pi，模板名不进会话文件、chip 丢失。
 * 修法：队列分支在展开前也要 `await ensureTemplates(message)`。
 */

function harnessWith(scenario) {
	const templates = [];
	const enqueued = [];
	const order = [];
	const harness = createSendHarness({
		draft: "/review 补充",
		templates,
		ensureTemplates: async (message) => {
			order.push(`ensure:${message}`);
			// 模拟异步补齐：补齐后模板表里才有这个模板
			await Promise.resolve();
			templates.push({ name: "review", path: "", description: "d", content: "REVIEW-BODY" });
			scenario?.onEnsure?.();
		},
		enqueue: (sessionId, payload) => {
			enqueued.push(payload);
			return true;
		},
	});
	return { harness, templates, enqueued, order };
}

test("队列分支（忙碌 steer）在展开前补齐模板表，入队消息已带自包含块", async () => {
	const { harness, enqueued, order } = harnessWith();
	await harness.send("steer");

	assert.equal(order.length, 1, "必须调用一次 ensureTemplates");
	assert.equal(enqueued.length, 1, "忙碌时必须入队而不是直发");
	assert.match(enqueued[0].message, /<prompt_template name="review">/);
	assert.match(enqueued[0].message, /REVIEW-BODY/);
	assert.match(enqueued[0].message, /补充/);
	assert.doesNotMatch(enqueued[0].message, /(^|\s)\/review(\s|$)/);
});

test("ensureTemplates 抛错不阻断发送（fail-open：退回交给 pi 展开）", async () => {
	const enqueued = [];
	const harness = createSendHarness({
		draft: "/review x",
		templates: [],
		ensureTemplates: async () => {
			throw new Error("runtime gone");
		},
		enqueue: (sessionId, payload) => {
			enqueued.push(payload);
			return true;
		},
	});
	await harness.send("steer");
	assert.equal(enqueued.length, 1, "模板表补齐失败也必须照常入队");
	assert.match(enqueued[0].message, /(^|\s)\/review(\s|$)/, "未展开时保留原文，由 pi 兜底展开");
});

test("队列分支也遵守保留集：后端命令原样入队（DSH host 命令不被抢）", async () => {
	const templates = [{ name: "permission", path: "", description: "", content: "PERMISSION-BODY" }];
	const enqueued = [];
	const harness = createSendHarness({
		draft: "/permission allow",
		templates,
		reservedCommandNames: new Set(["permission"]),
		enqueue: (sessionId, payload) => {
			enqueued.push(payload);
			return true;
		},
	});
	await harness.send("steer");
	assert.equal(enqueued.length, 1);
	assert.equal(enqueued[0].message, "/permission allow", "DSH 的 /permission 必须原样交给 host 执行");
});
