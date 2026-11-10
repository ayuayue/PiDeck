import assert from "node:assert/strict";
import test from "node:test";

import { queuedPrompt, queuedPromptHarness } from "./helpers/queuedPromptHarness.mjs";

// 复现：排队的消息被「连发两条」。
//
// pi / dsh 的 sendPrompt 是「入队即回」：accepted 只代表 pi 收下了消息，回合可能还没开始，
// 此时 runtime 原子仍是 idle。App.tsx 的队列 effect 依赖 queuedPrompts，而 drain 会改队列
// （队首标 sending、accepted 后移除），effect 必然再触发一次；只要这次触发落在「accepted 已回、
// 回合还没忙起来」的窗口里，就会把第二条也发出去。
test("drain 之后 runtime 仍 idle 时，不得连发队列里的下一条", async () => {
	const harness = queuedPromptHarness();
	harness.addSession("A", "idle");
	harness.queue.setSessionQueuedPrompts("A", () => [queuedPrompt("q1"), queuedPrompt("q2")]);

	await harness.queue.flushNextQueuedPrompt("A");
	assert.equal(harness.submissions.length, 1, "第一条应当发出");

	// 模拟 App effect 在队列 state 变化后再次触发：此刻 runtime 还没被任何事件置忙。
	await harness.queue.flushNextQueuedPrompt("A");
	assert.equal(harness.submissions.length, 1, "第二条必须等本回合结束，不能在 accepted 窗口里连发");
});

test("回合真的忙起来之后，队列继续按序投递", async () => {
	const harness = queuedPromptHarness();
	harness.addSession("A", "idle");
	harness.queue.setSessionQueuedPrompts("A", () => [queuedPrompt("q1"), queuedPrompt("q2")]);

	await harness.queue.flushNextQueuedPrompt("A");
	assert.equal(harness.submissions.length, 1);

	// 回合开始：runtime 进入 running，门禁解除。
	harness.setRuntime("A", "running");
	// 回合结束：回到 idle，下一条应当发出。
	harness.setRuntime("A", "idle");
	await harness.queue.flushNextQueuedPrompt("A");
	assert.equal(harness.submissions.length, 2, "回合结束后第二条应当发出");
});

test("ACP 的 accepted 就是回合结算，不设门禁：下一条立即按序发出", async () => {
	const harness = queuedPromptHarness();
	harness.addSession("A", "idle", 1, "acp");
	harness.queue.setSessionQueuedPrompts("A", () => [queuedPrompt("q1"), queuedPrompt("q2")]);

	await harness.queue.flushNextQueuedPrompt("A");
	assert.equal(harness.submissions.length, 1);

	// ACP 没有「收下了但回合还没开始」的窗口，门禁若照设，下一条只能空等超时。
	await harness.queue.flushNextQueuedPrompt("A");
	assert.equal(harness.submissions.length, 2, "ACP 不应被 pi/dsh 的 accepted 门禁挡住");
});

test("门禁到期自己叫醒队列，不依赖外部事件", async () => {
	const harness = queuedPromptHarness();
	harness.addSession("A", "idle");
	harness.queue.setSessionQueuedPrompts("A", () => [queuedPrompt("q1"), queuedPrompt("q2")]);

	await harness.queue.flushNextQueuedPrompt("A");
	assert.equal(harness.submissions.length, 1);

	// 后端一个状态事件都没发：门禁不能把队列永久钉死。
	harness.fireTimers(2000);
	assert.equal(harness.submissions.length, 2, "到期必须自己续排");
});
