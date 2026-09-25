import assert from "node:assert/strict";
import test from "node:test";
import { deriveRespondingKind } from "../src/renderer/src/components/session/timeline/respondingKind.ts";
import { historyHasCurrentAssistantText, resolveStreamingTextUpdate, shouldHoldLiveText, shouldReleaseHeldLiveText } from "../src/renderer/src/utils/liveTextHandoff.ts";
import { classifySmoothStreamChange } from "../src/renderer/src/utils/smoothStreamContent.ts";

test("工具进行中优先于预热和回复中", () => {
	assert.equal(
		deriveRespondingKind({
			isStarting: true,
			isExecutingTool: true,
			liveTextStreaming: true,
		}),
		"executing",
	);
});

test("已有 live 正文或思考时不再显示预热", () => {
	assert.equal(deriveRespondingKind({ isStarting: true, liveTextStreaming: true }), "responding");
	assert.equal(deriveRespondingKind({ isStarting: true, liveThinkingStreaming: true }), "thinking");
});

test("思考与正文是两个阶段：思考期不得报「撰写回复」", () => {
	// 只有思考 delta → thinking；只有正文 delta → responding。
	// 合并成同一个状态会让状态条在纯推理期就显示「撰写回复」（用户反馈动画与后台不符）。
	assert.equal(deriveRespondingKind({ liveThinkingStreaming: true }), "thinking");
	assert.equal(deriveRespondingKind({ liveTextStreaming: true }), "responding");
	// 思考收尾与正文首字同批到达时正文优先，避免状态条来回跳
	assert.equal(deriveRespondingKind({ liveTextStreaming: true, liveThinkingStreaming: true }), "responding");
});

test("预热只在还没有字和工具时成立", () => {
	assert.equal(deriveRespondingKind({ isStarting: true }), "starting");
});

test("残留 thinking id 不算回复中：没有 streaming 就降为等待", () => {
	assert.equal(deriveRespondingKind({ isStarting: false, isExecutingTool: false }), "waiting");
});

test("done 空快照保留上一帧正文；reset 必须清掉", () => {
	assert.equal(resolveStreamingTextUpdate("已经出来的字", "", true), "已经出来的字");
	assert.equal(resolveStreamingTextUpdate("已经出来的字", "已经出来的字。", false), "已经出来的字。");
	assert.equal(resolveStreamingTextUpdate("上一轮正文", "", true, true), "");
});

test("History 还没有本轮助手正文时 hold live 槽", () => {
	assert.equal(shouldHoldLiveText({ done: true, liveText: "你好", historyHasAssistantText: false }), true);
	assert.equal(shouldHoldLiveText({ done: true, liveText: "你好", historyHasAssistantText: true }), false);
	assert.equal(shouldHoldLiveText({ done: true, liveText: "", historyHasAssistantText: false }), false);
	assert.equal(
		shouldHoldLiveText({
			done: true,
			reset: true,
			liveText: "上一轮",
			historyHasAssistantText: false,
		}),
		false,
	);
});

test("只认本轮最后一条助手正文，上一轮不能解开 hold", () => {
	assert.equal(
		historyHasCurrentAssistantText([
			{ role: "assistant", text: "旧回答" },
			{ role: "user", text: "下一问" },
			{ role: "assistant", text: "" },
		]),
		false,
	);
	assert.equal(
		historyHasCurrentAssistantText([
			{ role: "user", text: "下一问" },
			{ role: "assistant", text: "新回答" },
		]),
		true,
	);
	assert.equal(shouldReleaseHeldLiveText([{ role: "user", text: "下一问" }]), true);
});

test("打字机：更短后缀快照忽略，前缀回退才钳制，无关才整段替换", () => {
	assert.equal(classifySmoothStreamChange("hello wo", "hello wo", "hello world").kind, "append");
	assert.equal(classifySmoothStreamChange("hello world", "hello world", "hello").kind, "rewind");
	assert.equal(classifySmoothStreamChange("hello world extra", "hello world extra", "extra").kind, "ignore");
	assert.equal(classifySmoothStreamChange("alpha", "alpha", "totally different").kind, "replace");
});
