import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildAskEcho, askEchoToolMessage, injectAskEchoMessage } = loadTsCommonJs("src/renderer/src/utils/askUi.ts");

const injector = readFileSync("src/renderer/src/components/session/SessionRuntimeInjector.tsx", "utf8");
const askPanelOverlay = readFileSync("src/renderer/src/components/overlays/AskPanelOverlay.tsx", "utf8");
const overlay = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
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

test("echo capture records an inline anchor at the answering moment", () => {
	// 锚点＝应答时刻时间线最后一条消息 id（提问阻塞的工具调用位置），换代判据仍保留。
	assert.match(echoAtoms, /messages\[messages\.length\s*-\s*1\]\?\.id/);
	assert.match(echoAtoms, /anchorMessageId,\s*answeredAt:\s*Date\.now\(\)/);
	assert.doesNotMatch(echoAtoms, /userMessageCount/);
});

test("echo renders inline as an ask_question tool message (pi _askCard parity)", () => {
	const echo = buildAskEcho(
		askRequest({
			batchQuestions: [
				{ id: "q1", type: "select", question: "要重构吗？" },
				{ id: "q2", type: "input", question: "目标分支" },
			],
		}),
		{
			value: JSON.stringify({
				answers: [
					{ id: "q1", type: "select", value: "x", label: "要" },
					{ id: "q2", type: "input", value: "dev", label: "dev" },
				],
			}),
		},
	);
	const message = askEchoToolMessage({ echo, agentId: "agent-1", answeredAt: 123 });
	assert.equal(message.role, "tool");
	assert.equal(message.agentId, "agent-1");
	assert.equal(message.timestamp, 123);
	assert.equal(message.meta.toolName, "ask_question");
	assert.equal(message.meta.status, "done");
	// _askCard 形状与 pi（AgentManager.upsertToolMessage）一致：批量走 questions 列表，
	// 顶层 question/answered 供热区行头与「已回答」徽标。
	assert.equal(message.meta._askCard.question, "要重构吗？");
	assert.equal(message.meta._askCard.answered, true);
	assert.deepEqual(
		message.meta._askCard.questions.map((card) => [card.question, card.answer, card.answered]),
		[
			["要重构吗？", "要", true],
			["目标分支", "dev", true],
		],
	);
	const cancelled = askEchoToolMessage({ echo: buildAskEcho(askRequest({ batchQuestions: [{ id: "q1", type: "select", question: "是否执行？" }] }), { cancelled: true }), agentId: "a", answeredAt: 1 });
	assert.equal(cancelled.meta._askCard.answered, false);
});

test("injectAskEchoMessage splices at the anchor without mutating the source", () => {
	const base = [
		{ id: "m1", role: "user", text: "hi", timestamp: 1, agentId: "a" },
		{ id: "m2", role: "assistant", text: "ok", timestamp: 2, agentId: "a" },
	];
	const echo = { requestId: "req-1", cancelled: false, items: [{ question: "Q", answer: "A", answered: true }] };
	const placement = { echo, agentId: "a", anchorMessageId: "m2", answeredAt: 3 };
	const next = injectAskEchoMessage(base, placement);
	assert.deepEqual(
		base.map((m) => m.id),
		["m1", "m2"],
		"入参不得被就地修改",
	);
	assert.deepEqual(
		next.map((m) => m.id),
		["m1", "m2", "dsh-ask-echo:req-1"],
	);
	// 锚点在中间：回显落在锚点之后、后续消息之前（提问发生的原位）。
	const mid = injectAskEchoMessage(base, { ...placement, anchorMessageId: "m1" });
	assert.deepEqual(
		mid.map((m) => m.id),
		["m1", "dsh-ask-echo:req-1", "m2"],
	);
	// 锚点被压缩/重投影改写：宁缺不错位。
	assert.equal(injectAskEchoMessage(base, { ...placement, anchorMessageId: "gone" }), base);
	// 应答时还没有任何消息（无锚点）：插到头部（提问先于后续全部内容）。
	// 注意：注入结果数组诞生在 askUi 的 vm 沙箱 realm，deepStrictEqual 会比对原型，
	// 必须用宿主 spread 重新物化后再断言。
	const empty = injectAskEchoMessage([], { ...placement, anchorMessageId: undefined });
	assert.deepEqual([...empty.map((m) => m.id)], ["dsh-ask-echo:req-1"]);
	// 防重：已存在同 id 不再注入。
	assert.equal(injectAskEchoMessage(next, placement), next);
	assert.equal(injectAskEchoMessage(base, undefined), base);
});

test("timeline injects the echo into both grouping inputs and dropped the tail card", () => {
	// 换代判据：重启/重绑后旧答案不再代表当前会话。
	assert.match(timeline, /runtime\?\.agentId\s*!==\s*askEchoEntry\.agentId\s*\|\|\s*runtime\.runtimeGeneration\s*!==\s*askEchoEntry\.runtimeGeneration/);
	// 注入必须发生在 groupToolMessages 之前（派生层），且覆盖 runtime 窗口与分页两条分组输入；
	// 写进消息缓存会被 DSH host 全量折叠投影冲掉。
	assert.match(timeline, /injectAskEchoMessage\(controller\.messages,\s*askEchoPlacement\)/);
	assert.match(timeline, /injectAskEchoMessage\(paginatedMessages,\s*askEchoPlacement\)/);
	assert.match(timeline, /groupToolMessages\(echoedWindowMessages,/);
	assert.match(timeline, /groupToolMessages\(echoedPaginatedMessages,/);
	// 尾部固定回显卡已废弃（用户反馈：应显示在工具调用处，而不是钉在底部）。
	assert.doesNotMatch(timeline, /SessionAskEcho/);
});
