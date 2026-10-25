/**
 * 输入预测渲染 hook（usePromptSuggestion）的状态机测试。
 *
 * 用确定性 React 宿主（无 DOM）+ desktopApi/jotai 替身，锁定用户可见语义：
 * 只有「回合刚结束 + 草稿为空 + 开关与模型可用」才发请求；done 才出文案；
 * 切会话/关开关/开始新回合必须取消并清空，迟到的受理结果不能把 ghost 复活。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/** 略大于 hook 内部的 PREDICT_DELAY_MS(300ms)：用真实计时器，避免依赖 mock 时钟的实现细节。 */
const afterPredictDelay = () => new Promise((resolve) => setTimeout(resolve, 360));
const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));
const plain = (value) => JSON.parse(JSON.stringify(value));

function hookHarness() {
	const host = quickMessageHookHost();
	let messages = [];
	let runResult = { ok: true, runId: "run-1" };
	let contextEmpty = false;
	const payloads = [];
	const cancelled = [];
	const applies = [];
	// 预测不弹 toast：没预测/没结果的原因只能靠应用日志（scope=suggest）解释。
	const logs = [];
	let eventSink = null;

	const { usePromptSuggestion } = loadTsCommonJs("src/renderer/src/hooks/usePromptSuggestion.ts", {
		stubs: {
			react: host.react,
			jotai: { useStore: () => ({ get: () => ({ messages }) }) },
			"../atoms/session-atoms": { sessionMessageCacheBySessionIdAtomFamily: (sessionId) => ({ sessionId }) },
			"../utils/promptEnhanceContext": { collectPromptEnhanceContext: (list) => (contextEmpty ? [] : list.map(({ role, text }) => ({ role, text }))) },
			"../utils/rendererLog": { logFromRenderer: (level, scope, message, detail) => logs.push({ level, scope, message, detail }) },
			"../desktopApi": {
				desktopApi: {
					suggestion: {
						run: async (input) => {
							payloads.push(input);
							return typeof runResult === "function" ? runResult(input) : runResult;
						},
						cancel: async () => {
							cancelled.push(true);
							return { ok: true };
						},
						onEvent: (callback) => {
							eventSink = callback;
							return () => {
								eventSink = null;
							};
						},
					},
				},
			},
		},
	});

	const props = { scopeKey: "s1", enabled: true, target: { provider: "pi", modelId: "m" }, turnRunning: false, draftEmpty: true };
	const render = (patch = {}) => {
		Object.assign(props, patch);
		return host.render(() => usePromptSuggestion({ ...props, applyText: (text) => applies.push(text) }));
	};

	return {
		render,
		host,
		payloads,
		cancelled,
		applies,
		logs,
		setMessages: (next) => (messages = next),
		setRunResult: (value) => (runResult = value),
		setContextEmpty: (value) => (contextEmpty = value),
		emit: (event) => eventSink?.(event),
		hasEventSink: () => !!eventSink,
	};
}

const ASSISTANT_LAST = [
	{ role: "user", text: "帮我改登录页" },
	{ role: "assistant", text: "改好了，并补了测试" },
];

/** 从「正在跑」落到 idle，等预测受理完成。 */
async function finishTurn(h, patch = {}) {
	h.render({ turnRunning: true });
	h.render({ turnRunning: false, ...patch });
	await afterPredictDelay();
	await flushMicrotasks();
}

test("回合结束才预测：run 带目标模型与本轮上下文，idle→idle 不发请求", async () => {
	const h = hookHarness();
	h.setMessages(ASSISTANT_LAST);
	h.render();
	await afterPredictDelay();
	assert.deepEqual(h.payloads, []);

	await finishTurn(h);
	assert.equal(h.payloads.length, 1);
	assert.deepEqual(plain(h.payloads[0]), { provider: "pi", modelId: "m", context: ASSISTANT_LAST });
});

test("最后一条不是助手正文（错误/中断/用户消息）时不预测", async () => {
	for (const messages of [[], [{ role: "user", text: "还没回答" }], [...ASSISTANT_LAST, { role: "assistant", text: "  " }]]) {
		const h = hookHarness();
		h.setMessages(messages);
		await finishTurn(h);
		assert.deepEqual(h.payloads, [], JSON.stringify(messages));
	}
});

test("done 才出文案：规范化成一句话，空草稿可见、草稿非空或正在跑都隐藏", async () => {
	const h = hookHarness();
	h.setMessages(ASSISTANT_LAST);
	await finishTurn(h);
	h.emit({ runId: "run-1", phase: "started" });
	h.emit({ runId: "run-1", phase: "delta", text: "先看" });
	// delta 不逐字渲染（ghost 只认终态，避免抖动）。
	const streaming = h.render();
	assert.equal(streaming.text, "");
	assert.equal(streaming.visible, false);
	h.emit({ runId: "run-1", phase: "done", text: "「先看日志。然后再说」" });
	let view = h.render();
	assert.equal(view.text, "先看日志。");
	assert.equal(view.visible, true);
	assert.equal(h.render({ draftEmpty: false }).visible, false);
	assert.equal(h.render({ draftEmpty: true, turnRunning: true }).visible, false);
});

test("Tab / → 采纳：回填草稿并消费掉 ghost；Esc（dismiss）只清空不发请求", async () => {
	const h = hookHarness();
	h.setMessages(ASSISTANT_LAST);
	await finishTurn(h);
	h.emit({ runId: "run-1", phase: "done", text: "再补个边界用例" });
	assert.equal(h.render().visible, true);
	const view = h.render();
	// 纯策略：裸 Tab / → 算采纳，带修饰键或其他键不算。
	assert.equal(view.acceptKey({ key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }), true);
	assert.equal(view.acceptKey({ key: "ArrowRight", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }), true);
	assert.equal(view.acceptKey({ key: "Tab", shiftKey: true, altKey: false, ctrlKey: false, metaKey: false }), false);
	assert.equal(view.acceptKey({ key: "Enter", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }), false);
	// 草稿非空时即使还有文案也不该被 Tab 吃掉。
	assert.equal(h.render({ draftEmpty: false }).acceptKey({ key: "Tab", shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }), false);
	h.render({ draftEmpty: true }).accept();
	assert.deepEqual(h.applies, ["再补个边界用例"]);
	assert.equal(h.render().text, "");
	assert.equal(h.render().visible, false);

	h.emit({ runId: "run-1", phase: "done", text: "已经采纳过" });
	h.render({ turnRunning: true });
	h.render({ turnRunning: false });
	await afterPredictDelay();
	h.emit({ runId: "run-1", phase: "done", text: "下一条" });
	assert.equal(h.render().visible, true);
	h.render().dismiss();
	assert.equal(h.render().visible, false);
	assert.deepEqual(h.applies, ["再补个边界用例"]);
});

test("切会话 / 关开关 / 开始新回合：取消进行中的预测并清空旧文案", async () => {
	for (const transition of [{ scopeKey: "s2" }, { enabled: false }, { target: null }, { turnRunning: true }]) {
		const h = hookHarness();
		h.setMessages(ASSISTANT_LAST);
		await finishTurn(h);
		h.emit({ runId: "run-1", phase: "done", text: "旧会话建议" });
		assert.equal(h.render().visible, true, JSON.stringify(transition));
		// 未结算的 run 才需要取消；已 done 时只要求清空。
		h.render(transition);
		assert.equal(h.render().text, "");
		assert.equal(h.render().visible, false);
	}
});

test("受理前已取消：迟到结果立即撤回，不把 ghost 复活", async () => {
	const h = hookHarness();
	let accept;
	h.setMessages(ASSISTANT_LAST);
	h.setRunResult(() => new Promise((resolve) => (accept = resolve)));
	await finishTurn(h);
	assert.equal(h.payloads.length, 1);
	h.render({ scopeKey: "s2" });
	accept({ ok: true, runId: "run-late" });
	await flushMicrotasks();
	h.emit({ runId: "run-late", phase: "done", text: "迟到的建议" });
	assert.equal(h.render().visible, false);
	assert.ok(h.cancelled.length >= 2, "切会话取消一次 + 撤回迟到 run 一次");
});

test("失败静默：error/aborted 不产生文案，也不抛", async () => {
	for (const phase of ["error", "aborted"]) {
		const h = hookHarness();
		h.setMessages(ASSISTANT_LAST);
		await finishTurn(h);
		h.emit({ runId: "run-1", phase, errorKind: "model-error", message: "boom" });
		assert.equal(h.render().visible, false);
	}
});

test("开关关闭或无目标模型：不发起请求；事件订阅随卸载退订", async () => {
	for (const patch of [{ enabled: false }, { target: null }]) {
		const h = hookHarness();
		h.setMessages(ASSISTANT_LAST);
		await finishTurn(h, patch);
		assert.deepEqual(h.payloads, [], JSON.stringify(patch));
	}
	const h = hookHarness();
	h.setMessages(ASSISTANT_LAST);
	h.render();
	assert.equal(h.hasEventSink(), true);
	h.host.unmount();
	assert.equal(h.hasEventSink(), false);
});

/** 「没预测」与「没结果」必须能在日志里分辨：前者是本地判定（debug），后者是模型确实没给东西（info）。 */
const suggestionLogs = (h, text) => h.logs.filter((entry) => entry.scope === "suggest" && entry.message.includes(text));

test("没预测的原因进应用日志：无目标模型 / 最后一条不是正文 / 上下文为空", async () => {
	let h = hookHarness();
	h.setMessages(ASSISTANT_LAST);
	await finishTurn(h, { target: null });
	assert.equal(h.payloads.length, 0);
	assert.equal(suggestionLogs(h, "没有可用目标模型")[0]?.level, "debug");

	h = hookHarness();
	h.setMessages([{ role: "user", text: "还没回答" }]);
	await finishTurn(h);
	assert.equal(h.payloads.length, 0);
	assert.match(suggestionLogs(h, "最后一条不是 assistant 正文")[0]?.message ?? "", /role=user/);

	h = hookHarness();
	h.setMessages(ASSISTANT_LAST);
	h.setContextEmpty(true);
	await finishTurn(h);
	assert.equal(h.payloads.length, 0);
	assert.ok(suggestionLogs(h, "上下文为空").length > 0);
});

test("开关关着不记日志（每轮都刷一条只会淹没有用信息）", async () => {
	const h = hookHarness();
	h.setMessages(ASSISTANT_LAST);
	await finishTurn(h, { enabled: false });
	assert.deepEqual(h.logs, []);
});

test("模型返回空建议：记 info 并保持无 ghost（区别于请求失败）", async () => {
	const h = hookHarness();
	h.setMessages(ASSISTANT_LAST);
	await finishTurn(h);
	h.emit({ runId: "run-1", phase: "done", text: "   " });
	assert.equal(h.render().visible, false);
	const line = suggestionLogs(h, "无可用结果")[0];
	assert.equal(line?.level, "info");
	assert.match(line.message, /清洗后为空/);
});
