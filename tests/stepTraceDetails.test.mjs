import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 过程行（重试/错误）展开详情解析的行为契约。
 *
 * 用户反馈：重试/连接超时归入工具调用时间线后「无法点击查看详情」——
 * 根因是 resolveStepDetail 只认 meta.debugDetails/errorMessage，而主进程
 * 多条错误链路（AgentManager 请求失败气泡、DSH turn/end 错误投影）只把原因
 * 写进 message.text。要求：这类条目必须回退正文，展开才有内容、整行才可点。
 */
const { resolveStepDetail } = loadTsCommonJs("src/renderer/src/components/session/turn/StepTraceDetails.tsx", {
	stubs: {
		react: { memo: (fn) => fn },
		"../../ui-shadcn/stack-trace": { StackTrace: () => null },
	},
});

function message(extras = {}) {
	return {
		id: "msg-1",
		agentId: "agent-1",
		role: extras.role ?? "error",
		text: extras.text ?? "",
		timestamp: 1,
		meta: extras.meta,
	};
}

test("resolveStepDetail: debugDetails wins over errorMessage and text", () => {
	assert.equal(
		resolveStepDetail(
			message({
				text: "请求失败。",
				meta: { i18nKey: "diagnostic.requestFailed", debugDetails: "429 Too Many Requests", errorMessage: "ignored" },
			}),
		),
		"429 Too Many Requests",
	);
});

test("resolveStepDetail: falls back to meta.errorMessage when debugDetails missing", () => {
	assert.equal(
		resolveStepDetail(
			message({
				text: "自动重试失败，已重试 3/3 次",
				meta: { i18nKey: "diagnostic.retryFailed", status: "error", errorMessage: "Connection error." },
			}),
		),
		"Connection error.",
	);
});

test("resolveStepDetail: untranslated error row (no i18nKey) falls back to raw text", () => {
	// AgentManager「请求失败：<原因>」与 DSH turn/end 投影都只有裸 text、无 meta。
	assert.equal(resolveStepDetail(message({ text: "请求失败：Connection timed out (connect ETIMEDOUT)" })), "请求失败：Connection timed out (connect ETIMEDOUT)");
	assert.equal(resolveStepDetail(message({ role: "system", text: "connect ETIMEDOUT" })), "connect ETIMEDOUT");
});

test("resolveStepDetail: localized retry status rows are NOT details (no expand echo)", () => {
	// 「自动重试成功」等带 i18nKey 且无原因的行，展开只会原样重复行文案 → 保持不可点。
	assert.equal(resolveStepDetail(message({ role: "system", text: "自动重试成功，共重试 2 次", meta: { i18nKey: "diagnostic.retrySucceeded", status: "success", errorMessage: "" } })), "");
	// assistant/user 正文永远不是「错误详情」。
	assert.equal(resolveStepDetail(message({ role: "assistant", text: "模型正常回复内容" })), "");
});

test("resolveStepDetail: strips ANSI and whitespace", () => {
	assert.equal(resolveStepDetail(message({ text: "\u001b[31m  API error: 500  \u001b[0m" })), "API error: 500");
	assert.equal(resolveStepDetail(message({ text: "   " })), "");
});
