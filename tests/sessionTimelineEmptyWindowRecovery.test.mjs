/**
 * Issue #350 回归：runtime 换代下发的**空消息窗口**不得让时间线永久停在「正在加载历史」。
 *
 * 现场：重启/换代后主进程先下发未初始化（0 条）的消息窗口，替换掉会话此前显示的
 * runtime 内容；此时后台历史加载可能还没发布（或已被取消）。渲染层若把「缓存条目存在」
 * 当成「已经读过盘」，就会跳过磁盘读取，loadState 停在 undefined → 骨架屏永驻，
 * 必须切走再切回（重新触发读盘）才能恢复。
 *
 * 契约（本测试用真实 hook + 真实 atoms 锁定行为）：
 *   - 换上空 runtime 投影后，本栏必须自己发起磁盘读取恢复，不需要切会话；
 *   - 恢复期间不得重复读盘（runtime 节流 flush 会不断重建缓存条目）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const SESSION_ID = "session-a";
const AGENT_ID = "agent-a";
const GENERATION = 2;
const diskHistory = [{ id: "history-u1", agentId: "legacy-agent", role: "user", text: "saved history", timestamp: 1 }];

/** 确定性宿主：mock React 槽位 + 真实 Jotai store（读走 store.get，写走 store.set）。 */
function harness() {
	const store = createStore();
	const host = quickMessageHookHost();
	const setters = new Map();
	const reads = [];
	const stubs = {
		// 被动 effect 关闭：只跑 layout effect（初始读盘决策就在 layout effect 里）。
		react: { ...host.react, useEffect: () => {}, useLayoutEffect: host.react.useEffect, useMemo: (factory, deps) => host.react.useCallback(factory, deps)() },
		jotai: {
			atom,
			useAtomValue: (value) => store.get(value),
			useStore: () => store,
			useSetAtom: (value) => {
				if (!setters.has(value)) setters.set(value, (...args) => store.set(value, ...args));
				return setters.get(value);
			},
		},
		"../atoms": {},
		"../i18n": { t: (key) => key },
		"../desktopApi": {
			desktopApi: {
				sessions: {
					readRecordMessagePage: async (sessionId) => {
						reads.push(sessionId);
						return { messages: diskHistory, total: diskHistory.length, nextBefore: null };
					},
				},
			},
		},
	};
	const load = createTsSandbox({ stubs, globals: { window: {} } });
	const atoms = load("src/renderer/src/atoms/session-atoms.ts");
	const selectors = load("src/renderer/src/atoms/session-selectors.ts");
	stubs["../atoms"] = { ...atoms, ...selectors };
	const { useSessionTimelineController } = load("src/renderer/src/hooks/useSessionTimelineController.ts");
	store.set(atoms.sessionRecordsAtom, {
		[SESSION_ID]: { id: SESSION_ID, projectId: "project-a", title: "History", source: "pi", backend: "pi", environment: "native", status: "active", filePath: "C:/project/session.jsonl", messageCount: 1, createdAt: 1, updatedAt: 1 },
	});
	store.set(atoms.sessionTabIdsAtom, [SESSION_ID]);
	const render = () => host.render(() => useSessionTimelineController({ sessionId: SESSION_ID }));
	const publishRuntimeWindow = (messages, totalLength = messages.length) => store.set(atoms.applySessionRuntimeEventAtom, { sessionId: SESSION_ID, agentId: AGENT_ID, runtimeGeneration: GENERATION, sourceChannel: "agents:message", payload: { messages, totalLength } });
	return { atoms, store, host, reads, render, publishRuntimeWindow };
}

/** 等 IPC 读盘的 promise 链结算（真实 hook 不在本进程变更调度）。 */
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("empty runtime window replacing displayed history recovers from disk without switching sessions", async () => {
	const h = harness();
	// 会话此前由 runtime 投影显示（本次挂载从未读盘：loadState 仍是 undefined）。
	h.publishRuntimeWindow([{ id: "live-1", agentId: AGENT_ID, role: "user", text: "live history", timestamp: 2 }]);
	const first = h.render();
	assert.equal(first.isSurfaceLoading, false);
	assert.equal(first.messages.length, 1);
	assert.equal(h.reads.length, 0, "非空 runtime 投影不需要读盘");

	// 换代：同一会话/绑定下发未初始化的空窗口（历史加载尚未发布）。
	h.publishRuntimeWindow([]);
	const replaced = h.render();
	assert.equal(replaced.messages.length, 0);
	assert.equal(replaced.isSurfaceLoading, true, "空窗口落地时先显示加载态");
	assert.deepEqual(h.reads, [SESSION_ID], "必须自己补读磁盘，而不是等用户切会话");

	await flushMicrotasks();
	const recovered = h.render();
	assert.equal(recovered.isSurfaceLoading, false, "读盘完成后恢复历史");
	assert.equal(recovered.messages.length, 1);
	assert.deepEqual(h.reads, [SESSION_ID], "恢复后不得因缓存条目重建重复读盘");
	h.host.unmount();
});

test("runtime churn while the initial disk read is in flight does not restart the read", async () => {
	const h = harness();
	// 挂载时缓存是空 runtime 投影：首帧就应发起读盘。
	h.publishRuntimeWindow([]);
	const first = h.render();
	assert.equal(first.isSurfaceLoading, true);
	assert.deepEqual(h.reads, [SESSION_ID]);
	// 读盘在途期间 runtime 继续 flush（缓存条目被重建）：不得再排一次初始读盘。
	h.publishRuntimeWindow([]);
	h.render();
	assert.deepEqual(h.reads, [SESSION_ID], "在途读盘期间不重复发起");
	h.host.unmount();
});
