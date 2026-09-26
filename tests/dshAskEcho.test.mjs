import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildAskEcho } = loadTsCommonJs("src/renderer/src/utils/askUi.ts");

const injector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
const askPanelOverlay = readFileSync("src/renderer/src/components/overlays/AskPanelOverlay.tsx", "utf8");
const overlay = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
const echoCard = readFileSync("src/renderer/src/components/session/SessionAskEcho.tsx", "utf8");
const echoAtoms = readFileSync("src/renderer/src/atoms/ask-echo-atoms.ts", "utf8");
const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");

/** 构造完整 AgentUiRequest 的测试工厂（只给 ask 相关字段）。 */
function askRequest(fields) {
	return { agentId: "agent-1", requestId: "req-1", method: "batch_ask", title: "", ...fields };
}

test("buildAskEcho decodes the batch envelope into per-question answer rows", () => {
	const request = askRequest({
		batchQuestions: [
			{ id: "q1", type: "select", question: "要重构吗？" },
			{ id: "q2", type: "input", question: "目标分支" },
			{ id: "q3", type: "multi_select", question: "覆盖哪些模块" },
		],
	});
	const value = JSON.stringify({
		answers: [
			{ id: "q1", type: "select", value: true, label: "要", wasCustom: false },
			{ id: "q2", type: "input", value: "dev", label: "dev", wasCustom: false },
			{ id: "q3", type: "multi_select", value: ["a", "b"], label: "a、b", wasCustom: false },
		],
	});
	const echo = buildAskEcho(request, { value });
	assert.equal(echo.cancelled, false);
	assert.deepEqual(
		echo.items.map((item) => [item.question, item.answer, item.answered]),
		[
			["要重构吗？", "要", true],
			["目标分支", "dev", true],
			["覆盖哪些模块", "a、b", true],
		],
	);
});

test("buildAskEcho marks unanswered batch items without inventing answers", () => {
	const request = askRequest({
		batchQuestions: [
			{ id: "q1", type: "select", question: "第一题" },
			{ id: "q2", type: "input", question: "第二题" },
		],
	});
	// 信封缺 q2（协议允许 value:null 或整项缺失）：回显不得给未答题编造答案。
	const value = JSON.stringify({ answers: [{ id: "q1", type: "select", value: "x", label: "X" }] });
	const echo = buildAskEcho(request, { value });
	assert.equal(echo.items[0].answer, "X");
	assert.equal(echo.items[1].answer, null);
	assert.equal(echo.items[1].answered, false);
});

test("buildAskEcho keeps questions visible on cancel", () => {
	const request = askRequest({ batchQuestions: [{ id: "q1", type: "select", question: "是否执行？" }] });
	const echo = buildAskEcho(request, { cancelled: true });
	assert.equal(echo.cancelled, true);
	assert.equal(echo.items.length, 1);
	assert.equal(echo.items[0].answered, false);
	assert.equal(echo.items[0].answer, null);
});

test("buildAskEcho falls back to the raw string when the batch envelope is corrupt", () => {
	const request = askRequest({ title: "批量提问", batchQuestions: [{ id: "q1", type: "select", question: "唯一题" }] });
	const echo = buildAskEcho(request, { value: "not-json{{{" });
	// 原题行未答 + 原文兜底行，保证「用户提交了什么」不丢。
	assert.equal(echo.items[0].answered, false);
	assert.equal(echo.items[1].answer, "not-json{{{");
});

test("buildAskEcho covers single-question methods and strips internal title markers", () => {
	const confirm = buildAskEcho(askRequest({ method: "confirm", title: "[PI_DECK_PLAN_NEXT] 开始执行？" }), { confirmed: true, value: true });
	assert.equal(confirm.items[0].question, "开始执行？");
	assert.equal(confirm.items[0].answer, true);
	assert.equal(confirm.items[0].answered, true);

	const select = buildAskEcho(askRequest({ method: "select", title: "选一个", options: ["a", "b"] }), { value: "b" });
	assert.equal(select.items[0].answer, "b");

	const inputCancelled = buildAskEcho(askRequest({ method: "input", title: "输入分支名" }), { cancelled: true });
	assert.equal(inputCancelled.cancelled, true);
	assert.equal(inputCancelled.items[0].answered, false);
});

test("buildAskEcho ignores non-ask ui methods", () => {
	assert.equal(buildAskEcho(askRequest({ method: "notify", message: "hi" }), { value: "x" }), undefined);
	assert.equal(buildAskEcho(askRequest({ method: "setWidget" }), { value: "x" }), undefined);
});

test("answered responses are captured through the responder onAccepted hook", () => {
	// 捕获点必须是 send 成功后（rollback/拒绝路径不留回显），且两处 responder 挂载点都要接线，
	// 否则主会话底栏与并行问询胶囊其中一条提交路径会静默丢回显。
	assert.match(overlay, /await input\.send\(envelope\);[\s\S]{0,80}input\.onAccepted\?\.\(request,\s*response\);/);
	assert.match(injector, /onAccepted:\s*\(request,\s*response\)\s*=>\s*setRecordAskEcho\(\{\s*sessionId:\s*currentSessionId,\s*request,\s*response,?\s*\}\)/);
	assert.match(askPanelOverlay, /onAccepted:\s*\(request,\s*response\)\s*=>\s*setRecordAskEcho\(\{\s*sessionId,\s*request,\s*response,?\s*\}\)/);
});

test("echo capture is gated to the DSH backend inside the atom", () => {
	// pi 路径已有 _askCard 工具静态卡；再记一份会双影。DSH 的提问是带外 server-request，
	// completed 事件不带答案，只能靠渲染层在 accepted 时投影。门控收在 atom 内部，两处接线点无须各自判。
	assert.match(echoAtoms, /runtime\.backend\s*!==\s*"dsh"/);
	assert.match(echoAtoms, /buildAskEcho\(input\.request,\s*input\.response\)/);
});

test("echo card yields to newer state instead of lingering in the timeline", () => {
	// 三条失效判据缺一不可：
	// - runtime 换代：重启/重绑后旧答案不再代表当前会话；
	// - 新的 pending ask：常驻底栏交互卡优先，避免同屏两张 ask 卡；
	// - 用户发了下一轮消息：回显（确认答案送达）使命结束，不再钉在时间线尾部误导位置。
	assert.match(echoCard, /runtime\.agentId\s*!==\s*entry\.agentId\s*\|\|\s*runtime\.runtimeGeneration\s*!==\s*entry\.runtimeGeneration/);
	assert.match(echoCard, /resolveActiveAskRequest\(runtime,\s*runtimeUi\)/);
	assert.match(echoCard, /userMessageCount\s*>\s*entry\.userMessageCount/);
	// 挂载点在时间线尾部（与 runtimeUi 槽同段正常流，不 sticky）。
	assert.match(timeline, /<SessionAskEcho\s+sessionId=\{sessionId\}\s*\/>/);
});
