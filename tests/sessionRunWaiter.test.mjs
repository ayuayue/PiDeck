import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回合等待器（sessionRunWaiter）测试。
 *
 * 它是 IM 通道判断「这一轮跑完没、成没成」的唯一入口，也是后端切换的地基：
 * 判定契约照抄自动化运行协调器（只认 agents:state 全量快照 + 回合开始证据），
 * 这里的每条断言都对应一次真实事故或一个真实后端行为：
 * - 提交前残留的 idle 快照 → 误判完成（自动化有记录：会杀掉还在跑的进程）；
 * - pi 只在 settled/error 时发快照 → 回合开始的证据来自 isTurnActive=true 补丁；
 * - DSH 失败不置 error 状态 → 靠时间线里的 role="error" 消息；
 * - 退订必须发生 → 泄漏的监听会唤醒旧等待器重复回信。
 */

const { waitForSessionRunEnd } = loadTsCommonJs("src/main/sessions/sessionRunWaiter.ts");

/** 沙箱里的对象原型属于另一个 realm，deepStrictEqual 会连原型一起比，先降级成纯数据。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const SESSION = "s1";
const AGENT = "a1";
const STATE = "agents:state";
const RUNTIME_STATE = "agents:runtime-state";

function makeRig({ messages = [] } = {}) {
	const listeners = new Set();
	const rig = {
		listeners,
		messages,
		deps: {
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			getMessages: () => rig.messages,
		},
		/** 发一条会话运行时事件（sessionId 默认本会话）。 */
		emit(sourceChannel, payload, sessionId = SESSION) {
			const event = { kind: "event", sessionId, agentId: AGENT, runtimeGeneration: 1, sourceChannel, payload };
			for (const listener of [...listeners]) listener(event);
		},
		startTurn() {
			rig.emit(RUNTIME_STATE, { agentId: AGENT, state: { isTurnActive: true } });
		},
	};
	return rig;
}

/** 等待器定时器是 unref 的（主进程常驻），测试里要有 ref 手柄把事件循环撑住。 */
async function waitForOutcome(rig, { sinceIndex = 0, timeoutMs = 200 } = {}) {
	const keepAlive = setTimeout(() => {}, timeoutMs + 200);
	try {
		return await waitForSessionRunEnd(rig.deps, { sessionId: SESSION, sinceIndex, timeoutMs });
	} finally {
		clearTimeout(keepAlive);
	}
}

test("提交前残留的 idle 快照不算完成（回合必须真的开始过）", async () => {
	const rig = makeRig();
	const pending = waitForOutcome(rig, { timeoutMs: 30 });
	rig.emit(STATE, { id: AGENT, status: "idle" });

	assert.deepEqual(plain(await pending), { kind: "timeout" }, "没开始过的回合不能被一次空闲快照收口");
});

test("pi 的回合开始证据是 isTurnActive=true，随后 idle 才算结束", async () => {
	const rig = makeRig();
	const pending = waitForOutcome(rig);
	rig.startTurn();
	rig.emit(STATE, { id: AGENT, status: "idle" });

	assert.deepEqual(plain(await pending), { kind: "ended", failed: false });
});

test("running 快照同样证明回合开始过（DSH 控制态只有 idle/running）", async () => {
	const rig = makeRig();
	const pending = waitForOutcome(rig);
	rig.emit(STATE, { id: AGENT, status: "running" });
	rig.emit(STATE, { id: AGENT, status: "idle" });

	assert.deepEqual(plain(await pending), { kind: "ended", failed: false });
});

test("DSH 式失败：idle 收口时按时间线里的 role=error 消息判失败并取原文", async () => {
	// DSH 的回合失败不置 error 状态，失败是 turn/end 时追加的一条错误消息。
	const rig = makeRig({
		messages: [
			{ role: "user", text: "跑一下" },
			{ role: "assistant", text: "半截回答" },
			{ role: "error", text: "模型鉴权失败" },
		],
	});
	const pending = waitForOutcome(rig);
	rig.emit(STATE, { id: AGENT, status: "running" });
	rig.emit(STATE, { id: AGENT, status: "idle" });

	assert.deepEqual(plain(await pending), { kind: "ended", failed: true, errorMessage: "模型鉴权失败" });
});

test("错误快照优先用时间线里的错误原文，退回 payload.error", async () => {
	const withMessage = makeRig({ messages: [{ role: "error", text: "供应商 500" }] });
	const first = waitForOutcome(withMessage);
	withMessage.startTurn();
	withMessage.emit(STATE, { id: AGENT, status: "error", error: "Runtime error" });
	assert.deepEqual(plain(await first), { kind: "ended", failed: true, errorMessage: "供应商 500" }, "错误原文比笼统兜底文案有用");

	const withoutMessage = makeRig();
	const second = waitForOutcome(withoutMessage);
	withoutMessage.startTurn();
	withoutMessage.emit(STATE, { id: AGENT, status: "error", error: "boom" });
	assert.deepEqual(plain(await second), { kind: "ended", failed: true, errorMessage: "boom" });

	const empty = makeRig();
	const third = waitForOutcome(empty);
	empty.startTurn();
	empty.emit(STATE, { id: AGENT, status: "error" });
	assert.deepEqual(plain(await third), { kind: "ended", failed: true }, "没有任何文本时只报失败，不编造原因");
});

test("先失败后重试成功的回合不算失败（只看最后一条助手/错误消息）", async () => {
	const rig = makeRig({
		messages: [
			{ role: "assistant", text: "第一次" },
			{ role: "error", text: "供应商 500" },
			{ role: "assistant", text: "重试成功" },
		],
	});
	const pending = waitForOutcome(rig);
	rig.startTurn();
	rig.emit(STATE, { id: AGENT, status: "idle" });

	assert.deepEqual(plain(await pending), { kind: "ended", failed: false });
});

test("sinceIndex 之前的旧错误不算本回合的失败", async () => {
	const rig = makeRig({
		messages: [
			{ role: "error", text: "上一轮的错误" },
			{ role: "assistant", text: "本轮结果" },
		],
	});
	const pending = waitForOutcome(rig, { sinceIndex: 2 });
	rig.startTurn();
	rig.emit(STATE, { id: AGENT, status: "idle" });

	assert.deepEqual(plain(await pending), { kind: "ended", failed: false }, "切片起点之外的错误消息与本轮无关");
});

test("进程在回合结束前退出算失败", async () => {
	const rig = makeRig();
	const pending = waitForOutcome(rig);
	rig.startTurn();
	rig.emit(STATE, { id: AGENT, status: "closed" });

	const outcome = await pending;
	assert.equal(outcome.kind, "ended");
	assert.equal(outcome.failed, true);
	assert.match(outcome.errorMessage, /exited/);
});

test("只认本会话的运行时事件", async () => {
	const rig = makeRig();
	const pending = waitForOutcome(rig);
	rig.emit(STATE, { id: "a9", status: "idle" }, "s9");
	rig.startTurn();
	rig.emit(STATE, { id: AGENT, status: "idle" });

	assert.deepEqual(plain(await pending), { kind: "ended", failed: false }, "别的会话的快照不能收口本会话");
});

test("收口与超时都必须退订（泄漏的监听会唤醒旧等待器重复回信）", async () => {
	const settled = makeRig();
	const pending = waitForOutcome(settled);
	assert.equal(settled.listeners.size, 1, "等待期间必须已订阅（注册早于提交 prompt 才不丢终态）");
	settled.startTurn();
	settled.emit(STATE, { id: AGENT, status: "idle" });
	await pending;
	assert.equal(settled.listeners.size, 0, "收口后退订");

	const timedOut = makeRig();
	const pendingTimeout = waitForOutcome(timedOut, { timeoutMs: 30 });
	await pendingTimeout;
	assert.equal(timedOut.listeners.size, 0, "超时后退订");
});
