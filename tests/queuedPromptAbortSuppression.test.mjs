import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { queuedPrompt, queuedPromptHarness } from "./helpers/queuedPromptHarness.mjs";

/**
 * 「停止响应」与排队消息的交互（对齐 pi TUI 的打断语义：interrupt 把队列还给用户）。
 *
 * 用户点停止后，排队消息不得自动投递（旧行为：abort → 会话空闲 → App effect 立即把
 * 队首发出去，表现为「点了停止它又开始跑」）。抑制由两个 abort 入口置位：
 * useSessionRunControl.abortAgent 与 useSessionComposerController.abort；
 * 会话再次变忙（用户直发/重发新回合）时自动解除。
 */
test("abort suppression holds the follow-up queue through the idle boundary", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("held"));
	h.queue.suppressSessionQueueAutoDrain("A");
	assert.equal(h.notices.length, 1, "must tell the user the queue is paused");
	assert.equal(h.queue.queuedPromptsRef.current.A?.length, 1);
	// abort 完成：运行时回到 idle——正是旧行为里自动投递队首的时机
	h.setRuntime("A", "idle");
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 0, "suppressed queue must not auto-dispatch");
	assert.equal(h.queue.queuedPromptsRef.current.A?.length, 1, "queued item must stay pending");
	assert.equal(h.queueFlushBySessionRef.current.has("A"), false);
});

test("steer drain is blocked while an abort is winding down", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("held", "steer"));
	h.queue.suppressSessionQueueAutoDrain("A");
	await h.queue.flushQueuedSteerPrompts("A");
	assert.equal(h.submissions.length, 0, "must not steer into a turn the user is aborting");
	assert.equal(h.queueFlushBySessionRef.current.has("A"), false);
	assert.equal(h.queue.queuedPromptsRef.current.A?.length, 1);
});

test("re-engagement (busy again) lifts suppression and drains normally", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("held"));
	h.queue.suppressSessionQueueAutoDrain("A");
	h.setRuntime("A", "idle");
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 0);
	// 用户重新直发一条消息：会话再次变忙 → 抑制解除；该回合结束后队列恢复正常 drain
	h.setRuntime("A", "running");
	h.setRuntime("A", "idle");
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 1, "queue resumes after the user re-engages");
});

test("double stop does not repeat the pause notice", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("held"));
	h.queue.suppressSessionQueueAutoDrain("A");
	h.queue.suppressSessionQueueAutoDrain("A");
	assert.equal(h.notices.length, 1);
});

test("aborting a session without queued prompts stays silent", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.suppressSessionQueueAutoDrain("A");
	assert.equal(h.notices.length, 0);
	h.setRuntime("A", "idle");
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 0);
});

test("deleting a suppressed session clears the flag for a fresh session of the same id", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("held"));
	h.queue.suppressSessionQueueAutoDrain("A");
	h.removeSession("A");
	h.addSession("A", "idle");
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("fresh"));
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 1, "recreated session must not inherit suppression");
});

test("in-flight dispatch during abort settles without cascading further queue items", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("first", "steer"));
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("second", "steer"));
	// steer 回合进行中：先 claim 第一条（dispatch 挂起），用户此时点停止
	const flushing = h.queue.flushQueuedSteerPrompts("A");
	assert.equal(h.submissions.length, 1, "first item is already in flight");
	h.queue.suppressSessionQueueAutoDrain("A");
	h.setRuntime("A", "running");
	// 回包到达：第一条结算（accepted 后移出队列），其余不得续排
	await flushing;
	assert.equal(h.submissions.length, 1, "suppressed cascade must stop after in-flight settlement");
	assert.equal(h.queue.queuedPromptsRef.current.A?.length, 1, "remaining steer item stays queued");
	assert.equal(h.queue.queuedPromptsRef.current.A?.[0]?.id, "second");
	h.setRuntime("A", "idle");
	h.fireTimers(150);
	await h.queue.flushNextQueuedPrompt("A");
	assert.equal(h.submissions.length, 1, "idle continuation must respect suppression");
});

/** 源码契约（空白容忍）：两个 abort 入口必须把抑制接到 App 级队列。 */
test("abort entry points are wired to queue suppression", () => {
	const runControlSource = readFileSync("src/renderer/src/hooks/session/useSessionRunControl.ts", "utf8");
	// abortAgent 在等待 IPC 前置位（先表达用户意图，风掉期间到达的 tool-end steer）
	assert.match(runControlSource, /suppressQueueAutoDrain\?\.\(target\.sessionId\);\s*\n[\s\S]*?await\s+api\.sessions\.abortRuntime\(target\)/);

	const composerSource = readFileSync("src/renderer/src/hooks/useSessionComposerController.ts", "utf8");
	assert.match(composerSource, /suppressQueuedDrain\?\.\(sessionId\);\s*\n[\s\S]*?desktopApi\.sessions\.abortRuntime\(target\)/);

	const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
	assert.match(appSource, /suppressQueueAutoDrain:\s*queue\.suppressSessionQueueAutoDrain/);
	assert.match(appSource, /queueSuppressAutoDrain:\s*queue\.suppressSessionQueueAutoDrain/);

	const composerAreaSource = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	// 会话分屏/预览共用同一份 paneServices（App 装配），不再现场调 hook。
	assert.match(composerAreaSource, /suppressQueuedDrain:\s*paneServices\.queueSuppressAutoDrain/);

	const servicesSource = readFileSync("src/renderer/src/components/session/SessionPaneServices.tsx", "utf8");
	assert.match(servicesSource, /queueSuppressAutoDrain\?:\s*\(sessionId:\s*string\)\s*=>\s*void/);
});

test("drain suppression projects to the UI atom across set, lift and delete", async () => {
	const h = queuedPromptHarness({ status: "running" });
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("held"));
	h.queue.suppressSessionQueueAutoDrain("A");
	assert.equal(h.store.get(h.atoms.queueDrainSuppressedByIdAtom).A, true);
	h.setRuntime("A", "idle");
	h.setRuntime("A", "running"); // 观测过 idle 后再变忙 = 用户重新发起回合，解除抑制
	assert.equal(h.store.get(h.atoms.queueDrainSuppressedByIdAtom).A, undefined, "lift must clear the projection");
	h.queue.enqueueQueuedPrompt("A", queuedPrompt("held2"));
	h.queue.suppressSessionQueueAutoDrain("A");
	assert.equal(h.store.get(h.atoms.queueDrainSuppressedByIdAtom).A, true);
	h.removeSession("A");
	assert.equal(h.store.get(h.atoms.queueDrainSuppressedByIdAtom).A, undefined, "session delete must clear the projection");
});

/** 面板常驻提示（toast 瞬时易逝）：抑制期间队列条显示「已暂停自动发送」。 */
test("queue strip shows a persistent paused banner while suppressed", () => {
	const panelsSource = readFileSync("src/renderer/src/components/session/ComposerPanels.tsx", "utf8");
	assert.match(panelsSource, /useAtomValue\(queueDrainSuppressedByIdAtom\)\[sessionId \?\? ""\] === true/);
	assert.match(panelsSource, /data-testid="queue-drain-suspended"/);
	assert.match(panelsSource, /t\("app\.queueDrainPausedBadge"\)/);
	const atomsSource = readFileSync("src/renderer/src/atoms/composer-atoms.ts", "utf8");
	assert.match(atomsSource, /export const queueDrainSuppressedByIdAtom/);
});
