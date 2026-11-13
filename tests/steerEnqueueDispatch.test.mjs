import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { queuedPrompt, queuedPromptHarness } from "./helpers/queuedPromptHarness.mjs";

/**
 * 「加入当前回合」入队后必须立刻派发（2026-11 用户反馈）。
 *
 * 事故：忙碌时点「加入当前回合」，消息进本地队列后没有任何人叫醒
 * flushQueuedSteerPrompts——它只有三个触发点（工具结束 / 用户改投递方式 / 点名发送）。
 * 于是要等到下一次 tool-end 才进 pi 队列：时间线上看不到消息，模型也没停，
 * 用户感受到的是「像被打断，还等很久，前端也没显示」。
 *
 * 修法：入队成功且 behavior 是 steer 时，延后一拍（微任务）派发——同一拍里调用方
 * 可能还要设抑制或换运行时，立即派发会插进用户正要中止的回合。
 */

const loadQueueModule = createTsSandbox({
	stubs: { "../../../shared/types": {} },
});
const queueSource = readFileSync("src/renderer/src/hooks/useQueuedPrompt.ts", "utf8");

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("steer 入队后一个微任务内就派发，不必等 tool-end", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("插话", "steer"));
	assert.equal(h.submissions.length, 0, "派发在微任务里，不是同步插进去");
	await settle();
	assert.equal(h.submissions.length, 1, "忙碌时 steer 应立刻进入 pi 队列");
	assert.equal(h.submissions[0][1], "expanded:插话");
	h.unmount();
});

test("同一拍里设了抑制（正在停止回合）就不许插队", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("插话", "steer"));
	h.queue.suppressSessionQueueAutoDrain("A");
	await settle();
	assert.equal(h.submissions.length, 0, "用户正在中止的回合不能被插话");
	assert.equal(h.queue.queuedPromptsRef.current.A?.length, 1, "消息仍在队列里等");
	h.unmount();
});

test("followUp 入队不提前派发：它只在 agent 空闲时发", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("下一轮", "followUp"));
	await settle();
	assert.equal(h.submissions.length, 0);
	h.unmount();
});

test("入队派发写在 enqueue 内部，不再依赖外部事件叫醒", () => {
	// 运行时锚：派发挑选规则来自生产模块
	const queueModule = loadQueueModule("src/renderer/src/utils/queuedPromptQueue.ts");
	const claimed = queueModule.claimNextSteerPrompt({ A: [queuedPrompt("排队项", "followUp"), queuedPrompt("插话项", "steer")] }, "A");
	assert.equal(claimed.prompt?.displayText, "插话项");

	// 坏样本：删掉这次派发，本断言失败——「加入当前回合」又会退回等 tool-end。
	assert.match(queueSource, /if \(added && queuedPrompt\.behavior === "steer"\) queueMicrotask\(\(\) => void flushQueuedSteerPrompts\(sessionId\)\);/);
});
