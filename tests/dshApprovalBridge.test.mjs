import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const bridge = loadTsCommonJs("src/main/dsh/dshApprovalBridge.ts");

const approvalFrame = () => ({
	rpcId: "rpc-approval-1",
	payload: {
		sessionId: "session-1",
		approvalId: "approval-1",
		toolName: "pwsh",
		reason: "execute command",
	},
});

const questionFrame = () => ({
	rpcId: "rpc-question-1",
	payload: {
		sessionId: "session-1",
		questions: [
			{ id: "q1", question: "继续吗？", options: [{ label: "是" }, { label: "否" }] },
			{ id: "q2", question: "补充说明", detail: "free text" },
		],
	},
});

test("parseDshApprovalFrame 收窄合法帧", () => {
	const frame = bridge.parseDshApprovalFrame(approvalFrame());
	assert.equal(frame?.requestId, "rpc-approval-1");
	assert.equal(frame?.sessionId, "session-1");
	assert.equal(frame?.approvalId, "approval-1");
	assert.equal(frame?.toolName, "pwsh");
	assert.equal(frame?.reason, "execute command");
});

test("parseDshApprovalFrame 拒绝缺字段帧", () => {
	assert.equal(bridge.parseDshApprovalFrame(undefined), undefined);
	assert.equal(bridge.parseDshApprovalFrame({ rpcId: "x", payload: {} }), undefined);
	assert.equal(
		bridge.parseDshApprovalFrame({
			rpcId: "x",
			payload: { sessionId: "s", approvalId: "" },
		}),
		undefined,
	);
});

test("parseDshQuestionFrame 收窄合法帧并要求至少一个问题", () => {
	const frame = bridge.parseDshQuestionFrame(questionFrame());
	assert.equal(frame?.requestId, "rpc-question-1");
	assert.equal(frame?.questions.length, 2);
	assert.equal(bridge.parseDshQuestionFrame({ rpcId: "x", payload: { sessionId: "s", questions: [] } }), undefined);
});

test("approvalUiRequest 映射为 confirm 请求（标题带工具名/原因）", () => {
	const request = bridge.approvalUiRequest(bridge.parseDshApprovalFrame(approvalFrame()), "dsh:session-1");
	assert.equal(request.requestId, "rpc-approval-1");
	assert.equal(request.method, "confirm");
	assert.equal(request.title, "pwsh: execute command");
	assert.equal(request.agentId, "dsh:session-1");
});

test("questionUiRequest 映射为 batch_ask（select 保选项、无选项降级 confirm）", () => {
	const request = bridge.questionUiRequest(bridge.parseDshQuestionFrame(questionFrame()), "dsh:session-1");
	assert.equal(request.requestId, "rpc-question-1");
	assert.equal(request.method, "batch_ask");
	const questions = request.batchQuestions;
	assert.equal(questions.length, 2);
	assert.equal(questions[0].type, "select");
	assert.equal(questions[0].options.length, 2);
	assert.equal(questions[0].options[0].label, "是");
	assert.equal(questions[0].options[1].label, "否");
	assert.equal(questions[1].type, "confirm", "无 options 的提问降级 confirm");
});

test("approval 应答：confirmed → allowed-once，否则 rejected", () => {
	const frame = bridge.parseDshApprovalFrame(approvalFrame());
	const allow = bridge.buildDshRespondValue(frame, { confirmed: true });
	assert.equal(allow.sessionId, "session-1");
	assert.equal(allow.approvalId, "approval-1");
	assert.equal(allow.outcome, "allowed-once");
	const reject = bridge.buildDshRespondValue(frame, { confirmed: false });
	assert.equal(reject.outcome, "rejected");
	const cancelled = bridge.buildDshRespondValue(frame, { cancelled: true });
	assert.equal(cancelled.outcome, "rejected");
});

test("question 应答：解析渲染层 serializeBatchAnswers 的 JSON envelope", () => {
	const frame = bridge.parseDshQuestionFrame(questionFrame());
	// 与渲染层 serializeBatchAnswers 输出形状一致
	const envelope = JSON.stringify({
		answers: [
			{ id: "q1", type: "select", value: "是", label: "是", wasCustom: false },
			{ id: "q2", type: "confirm", value: true, label: "true", wasCustom: false },
		],
	});
	const value = bridge.buildDshRespondValue(frame, { value: envelope });
	assert.equal(value.sessionId, "session-1");
	const answers = value.answer.answers;
	assert.equal(answers.length, 2);
	assert.equal(answers[0].id, "q1");
	assert.equal(answers[0].selected.length, 1);
	assert.equal(answers[0].selected[0], "是");
	assert.equal(answers[1].id, "q2");
	assert.equal(answers[1].selected[0], "true");
});

test("question 应答：自定义文本走 custom 槽", () => {
	const frame = bridge.parseDshQuestionFrame(questionFrame());
	const envelope = JSON.stringify({
		answers: [{ id: "q2", type: "select", value: "自定义", label: "自定义", wasCustom: true }],
	});
	const value = bridge.buildDshRespondValue(frame, { value: envelope });
	const answers = value.answer.answers;
	assert.equal(answers.length, 1);
	assert.equal(answers[0].id, "q2");
	assert.equal(answers[0].selected.length, 0);
	assert.equal(answers[0].custom, "自定义");
});

test("question 应答：损坏 JSON / 缺 answers 返回 undefined", () => {
	const frame = bridge.parseDshQuestionFrame(questionFrame());
	assert.equal(bridge.buildDshRespondValue(frame, { value: "{not-json" }), undefined);
	assert.equal(bridge.buildDshRespondValue(frame, { value: JSON.stringify({ foo: 1 }) }), undefined);
	assert.equal(bridge.buildDshRespondValue(frame, { value: "" }), undefined);
});

test("multiSelect 提问映射为 multi_select（不降级成 select，避免勾一项就提交）", () => {
	const request = bridge.questionUiRequest(
		bridge.parseDshQuestionFrame({
			rpcId: "rpc-question-2",
			payload: {
				sessionId: "session-1",
				questions: [{ id: "q1", question: "选哪些？", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }],
			},
		}),
		"dsh:session-1",
	);
	assert.equal(request.batchQuestions[0].type, "multi_select");
});

test("question 应答：multi_select 的数组值整组透传到 selected", () => {
	const frame = bridge.parseDshQuestionFrame({
		rpcId: "rpc-question-2",
		payload: { sessionId: "session-1", questions: [{ id: "q1", question: "选哪些？", multiSelect: true, options: [{ label: "A" }, { label: "B" }] }] },
	});
	const envelope = JSON.stringify({ answers: [{ id: "q1", type: "multi_select", value: ["A", "B"], label: "A、B", wasCustom: false }] });
	const value = bridge.buildDshRespondValue(frame, { value: envelope });
	const answers = value.answer.answers;
	// 沙箱加载的模块对象原型不同，逐字段断言（不用 deepEqual）
	assert.equal(answers.length, 1);
	assert.equal(answers[0].id, "q1");
	assert.deepEqual([...answers[0].selected], ["A", "B"]);
});
