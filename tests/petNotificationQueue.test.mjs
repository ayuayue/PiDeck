import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadQueue() {
	const source = readFileSync("src/main/pet/notificationQueue.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const module = { exports: {} };
	vm.runInNewContext(
		outputText,
		{ module, exports: module.exports },
		{
			filename: "notificationQueue.ts",
		},
	);
	return module.exports;
}

const Q = loadQueue();
const EMPTY = () => ({ ...Q.EMPTY_NOTIFICATION_QUEUE });

const waiting = (title = "会话一") => ({ type: "waiting", text: `${title} 等待操作`, agentId: "a1", timestamp: 1, persistent: true });
const error = (text = "出错了") => ({ type: "error", text, agentId: "a1", timestamp: 2 });
const done = (text = "完成了") => ({ type: "done", text, agentId: "a1", timestamp: 2 });

test("waiting shows immediately when idle", () => {
	const w = waiting();
	const next = Q.nextNotificationQueueState(EMPTY(), w);
	assert.equal(next.active, w);
	assert.equal(next.queued, null);
});

test("waiting arriving during an error display is queued, not shown", () => {
	const state = { active: error(), queued: null };
	const next = Q.nextNotificationQueueState(state, waiting());
	// active 保持为 error，waiting 排队等待
	assert.equal(next.active, state.active);
	assert.equal(next.queued.type, "waiting");
});

test("error arriving over a waiting display preserves the waiting for later", () => {
	const w = waiting();
	const state = { active: w, queued: null };
	const next = Q.nextNotificationQueueState(state, error());
	assert.equal(next.active.type, "error");
	assert.equal(next.queued, w);
});

test("timer elapse restores the queued waiting", () => {
	const w = waiting();
	const state = { active: error(), queued: w };
	const next = Q.onNotificationTimerElapse(state);
	assert.equal(next.active, w);
	assert.equal(next.queued, null);
});

test("timer elapse without a queue clears the display", () => {
	const next = Q.onNotificationTimerElapse({ active: error(), queued: null });
	assert.equal(next.active, null);
	assert.equal(next.queued, null);
});

test("waiting clear signal dismisses only a persistent display", () => {
	// persistent 展示中收到 null → 收起
	const fromWaiting = Q.nextNotificationQueueState({ active: waiting(), queued: null }, null);
	assert.equal(fromWaiting.active, null);
	// 非持久化展示中收到 null（waiting 被取消）→ 保持 error 展示，等计时器到点
	const state = { active: error(), queued: waiting() };
	const fromError = Q.nextNotificationQueueState(state, null);
	assert.equal(fromError.active, state.active);
	assert.equal(fromError.queued, null);
});

test("new waiting while error displayed replaces the queued waiting", () => {
	const state = { active: error(), queued: waiting("旧") };
	const next = Q.nextNotificationQueueState(state, waiting("新"));
	assert.equal(next.queued.text, "新 等待操作");
	assert.equal(next.active, state.active);
});

test("new error over an error display replaces it without queueing", () => {
	const state = { active: error("旧错误"), queued: null };
	const next = Q.nextNotificationQueueState(state, error("新错误"));
	assert.equal(next.active.text, "新错误");
	assert.equal(next.queued, null);
});

test("done notification follows the same queue rules as error", () => {
	const w = waiting();
	const state = { active: w, queued: null };
	const next = Q.nextNotificationQueueState(state, done());
	assert.equal(next.active.type, "done");
	assert.equal(next.queued, w);
});
