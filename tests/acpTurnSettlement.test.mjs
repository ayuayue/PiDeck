/**
 * 空白回合诊断串（debugDetails）与响应片段提取的单测：
 * 概括文案「没有返回任何输出」区分不出限流/登录失败/事件流丢失，原始证据必须能
 * 拼进 toast（渲染层截前 140 字符）与主进程日志。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { describeEmptyTurn, emptyTurnRejection, isNativeCommandPrompt, promptResultSnippet, stalledTurnRejection } = loadTsCommonJs("src/main/acp/acpTurnSettlement.ts");

test("describeEmptyTurn 把 stderr 排在最前,并带上 stopReason/update 统计/通知/响应原文", () => {
	const details = describeEmptyTurn({
		stopReason: "end_turn",
		updateKinds: new Map([["agent_message_chunk", 3]]),
		stderrTail: ["line1", "Error: quota exceeded"],
		foreignNotification: 'session/error: {"message":"quota"}',
		rawResult: '{"error":"quota"}',
	});
	assert.match(details, /^stderr=line1 \| Error: quota exceeded;/);
	assert.match(details, /stopReason=end_turn/);
	assert.match(details, /updates=agent_message_chunkx3/);
	assert.match(details, /notification=session\/error/);
	assert.match(details, /result=\{"error":"quota"\}$/);
});

test("describeEmptyTurn 无 update 时写 none", () => {
	assert.equal(describeEmptyTurn({ stopReason: "end_turn" }), "stopReason=end_turn; updates=none");
});

test("promptResultSnippet 只保留 stopReason/_meta 之外的字段", () => {
	assert.equal(promptResultSnippet({ stopReason: "end_turn", _meta: { a: 1 } }), undefined);
	assert.equal(promptResultSnippet({ stopReason: "end_turn", error: "quota" }), '{"error":"quota"}');
	assert.equal(promptResultSnippet(undefined), undefined);
});

test("emptyTurnRejection 带上诊断,无诊断时保持原样", () => {
	assert.equal(emptyTurnRejection("CodeBuddy").debugDetails, undefined);
	assert.equal(emptyTurnRejection("CodeBuddy", "stderr=boom").debugDetails, "stderr=boom");
});

test("stalledTurnRejection:被看门狗掐断的回合按失败收口(#500)", () => {
	const result = stalledTurnRejection("CodeBuddy", "updates=agent_message_chunkx1");
	assert.equal(result.accepted, false, "有产出的 stall 不得谎报 accepted:true");
	// delivery=unknown:用户消息已留在时间线,回填草稿会让用户重发一遍
	assert.equal(result.delivery, "unknown");
	assert.equal(result.i18nKey, "acp.stallForceStopped");
	assert.deepEqual({ ...result.i18nParams }, { tool: "CodeBuddy" });
	assert.equal(result.debugDetails, "updates=agent_message_chunkx1");
	assert.match(result.error, /CodeBuddy/);
	assert.equal(stalledTurnRejection("CodeBuddy").debugDetails, undefined);
});

test("isNativeCommandPrompt:行首斜杠视为 CLI 原生命令,带图片的按普通 prompt 走(#512)", () => {
	// 与 composerBehavior「斜线命令原样发送」同一判定口径
	assert.equal(isNativeCommandPrompt({ agentId: "a", message: "/clear" }), true);
	assert.equal(isNativeCommandPrompt({ agentId: "a", message: "  /compact  " }), true);
	assert.equal(isNativeCommandPrompt({ agentId: "a", message: "hi" }), false);
	assert.equal(isNativeCommandPrompt({ agentId: "a", message: "" }), false);
	// 命令 + 图片无法确定 CLI 语义(图片块会走普通 prompt 能力门控),不当作命令豁免
	assert.equal(isNativeCommandPrompt({ agentId: "a", message: "/clear", images: [{ type: "image", mimeType: "image/png", data: "x" }] }), false);
});
