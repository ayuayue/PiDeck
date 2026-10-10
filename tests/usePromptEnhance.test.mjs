/**
 * 提示词增强渲染 hook（usePromptEnhance）的状态机测试。
 *
 * 用确定性 React 宿主（无 DOM）+ desktopApi/i18n/notice 替身，锁定用户可见语义：
 * 点击后必须有可见状态（starting/streaming）、随时可打断、失败可读、
 * 切会话作废进行中的 run（结果绝不跨会话回填）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

function hookHarness() {
	const host = quickMessageHookHost();
	const notices = [];
	let events = [];
	let eventSink = null;
	let runResult = { ok: true, runId: "run-1" };
	const applies = [];
	const cancelled = [];
	const payloads = [];
	const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

	const { usePromptEnhance } = loadTsCommonJs("src/renderer/src/hooks/usePromptEnhance.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": {
				desktopApi: {
					enhance: {
						run: async (input) => {
							payloads.push(input);
							if (runResult instanceof Error) throw runResult;
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
			"../i18n": { t: (key, params) => (params ? `${key}:${params.count ?? ""}` : key) },
			"../utils/notice": { showNotice: (message) => notices.push(message) },
		},
	});

	const render = (scopeKey = "s1", model = { provider: "p", modelId: "m" }, draft = "草稿") =>
		host.render(() =>
			usePromptEnhance({
				scopeKey,
				modelLabel: model ? `${model.provider}/${model.modelId}` : undefined,
				captureRequest: () => (model ? { ...model, draft } : null),
				applyText: (text) => applies.push(text),
			}),
		);

	return { render, notices, applies, cancelled, payloads, setRunResult: (value) => (runResult = value), emit: (event) => eventSink?.(event), flushMicrotasks };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("点击后进入 starting，首个 delta 转 streaming 并累积预览", async () => {
	const h = hookHarness();
	h.render().start();
	assert.equal(h.render().view.phase, "starting");
	await flush();
	h.emit({ runId: "run-1", phase: "delta", text: "增强后" });
	h.emit({ runId: "run-1", phase: "delta", text: "的提示词" });
	const view = h.render();
	assert.equal(view.view.phase, "streaming");
	assert.equal(view.view.preview, "增强后的提示词");
	assert.equal(view.view.chars, 7);
	assert.equal(view.view.original, "草稿");
});

test("done：回填输入框并清回 idle", async () => {
	const h = hookHarness();
	h.render().start();
	await flush();
	h.emit({ runId: "run-1", phase: "done", text: "增强后的提示词" });
	assert.deepEqual(h.applies, ["增强后的提示词"]);
	assert.equal(h.render().view.phase, "idle");
	assert.deepEqual(h.notices, ["enhance.applied"]);
});

test("发起请求的 payload 形状与 IPC 校验契约对齐（provider/modelId/userText，无多余字段）", async () => {
	const h = hookHarness();
	h.render("s1", { provider: "builtin:bigmodel-start-plan", modelId: "GLM-5.3-Flash" }, "帮我写个爬虫").start();
	await flush();
	// vm realm 的原型链与宿主不同，deepEqual 需先 JSON round-trip 比结构。
	assert.deepEqual(JSON.parse(JSON.stringify(h.payloads)), [{ provider: "builtin:bigmodel-start-plan", modelId: "GLM-5.3-Flash", userText: "帮我写个爬虫" }]);
});

test("受理失败：可读错误 toast + 回 idle，不产生任何回调", async () => {
	const h = hookHarness();
	h.setRunResult({ ok: false, errorKind: "model-not-found", message: "" });
	const view = h.render();
	view.start();
	await flush();
	assert.deepEqual(h.notices, ["enhance.failed：enhance.error.modelNotFound"]);
	const after = h.render();
	assert.equal(after.view.phase, "idle");
	assert.deepEqual(h.applies, []);
});

test("模型不在 pi 目录：原始模型名不能遮掉设置页操作提示", async () => {
	const h = hookHarness();
	h.render().start();
	await flush();
	h.emit({ runId: "run-1", phase: "error", errorKind: "model-not-found", message: "builtin:dsh-only/model" });
	assert.deepEqual(h.notices, ["enhance.failed：enhance.error.modelNotFound"]);
});

test("增强入口模型随设置立即刷新，不需要重挂输入框", () => {
	const h = hookHarness();
	assert.equal(h.render("s1", { provider: "session", modelId: "model" }).view.modelLabel, "session/model");
	assert.equal(h.render("s1", { provider: "fixed-pi", modelId: "new" }).view.modelLabel, "fixed-pi/new");
	assert.equal(h.render("s1", null).view.modelLabel, undefined);
});

test("下一次请求读取新模型和上下文，进行中请求保持发起快照", async () => {
	const h = hookHarness();
	const context = [{ role: "user", text: "仅 s1 的上下文" }];
	h.render("s1", { provider: "fixed-pi", modelId: "new-model", context }).start();
	await flush();
	h.render("s1", { provider: "next-pi", modelId: "next-model" }).start();
	assert.equal(h.payloads.length, 1);
	assert.deepEqual(JSON.parse(JSON.stringify(h.payloads[0])), { provider: "fixed-pi", modelId: "new-model", userText: "草稿", context });
	h.emit({ runId: "run-1", phase: "done", text: "完成" });
	h.render("s1", { provider: "next-pi", modelId: "next-model" }).start();
	await flush();
	assert.deepEqual(JSON.parse(JSON.stringify(h.payloads[1])), { provider: "next-pi", modelId: "next-model", userText: "草稿" });
});

test("stop：立即回 idle 并通知主进程取消", async () => {
	const h = hookHarness();
	h.render().start();
	await flush();
	h.render().cancel();
	assert.equal(h.render().view.phase, "idle");
	assert.equal(h.cancelled.length, 1);
	// 主进程稍后送达的 aborted 因 runId 已清空被忽略，不会二次结算。
	h.emit({ runId: "run-1", phase: "aborted" });
	assert.deepEqual(h.applies, []);
});

test("切会话：进行中的 run 被取消，done 事件不回填", async () => {
	const h = hookHarness();
	h.render("s1").start();
	await flush();
	h.render("s2");
	assert.equal(h.cancelled.length, 1);
	h.emit({ runId: "run-1", phase: "done", text: "迟到结果" });
	assert.deepEqual(h.applies, []);
});

test("未知 runId 的事件被忽略（多输入框实例只认自己的 run）", async () => {
	const h = hookHarness();
	h.render().start();
	await flush();
	h.emit({ runId: "other-run", phase: "delta", text: "别人的输出" });
	h.emit({ runId: "other-run", phase: "done", text: "别人的结果" });
	const view = h.render();
	assert.equal(view.view.phase, "starting");
	assert.deepEqual(h.applies, []);
});

test("草稿为空 / 无模型：不发起请求，给可读提示", async () => {
	const h = hookHarness();
	h.render("s1", { provider: "p", modelId: "m" }, "   ").start();
	await flush();
	assert.deepEqual(h.notices, ["enhance.emptyDraft"]);
	h.render("s1", null, "草稿").start();
	await flush();
	assert.deepEqual(h.notices, ["enhance.emptyDraft", "enhance.noModel"]);
});

test("受理结果返回前已取消：结果不受理，多余 run 被取消", async () => {
	const h = hookHarness();
	// run 返回前用户先点了 stop（候选占位被清空）。
	h.setRunResult(async () => {
		h.render().cancel();
		return { ok: true, runId: "run-1" };
	});
	h.render().start();
	await flush();
	// 一次来自用户 stop，一次来自 hook 发现「候选已被取消」后的防御性 cancel。
	assert.equal(h.cancelled.length, 2);
	h.emit({ runId: "run-1", phase: "done", text: "不该回填" });
	assert.deepEqual(h.applies, []);
});
