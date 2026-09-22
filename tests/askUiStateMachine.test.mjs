import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * Ask 提问 UI 状态机与应答构造（#ask-ui）：
 * - 纯逻辑：pickActiveAskRequest / buildAskResponse / serializeBatchAnswers / shouldSuppressAskClick
 * - 静态契约：渲染层使用提取的纯逻辑 + shadcn 组件与语义字号 token；
 *   主进程 select 无选项降级为 input（不再静默取消）；
 *   overlay / timeline / 安全卡在选项点击前调按压感知守卫 shouldSuppressAskClick，避免划选 mouseup 冒充 click 误答。
 */

function loadAskUi(sandboxExtras = {}) {
	const source = readFileSync("src/renderer/src/utils/askUi.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "askUi.ts",
	}).outputText;
	const sandbox = { exports: {}, require: () => ({}), ...sandboxExtras };
	vm.runInNewContext(output, sandbox, { filename: "askUi.ts" });
	return sandbox.exports;
}

function request(overrides) {
	return {
		agentId: "agent-1",
		requestId: "req-1",
		method: "input",
		title: "问题",
		...overrides,
	};
}

test("pickActiveAskRequest: 无请求返回 undefined", () => {
	const { pickActiveAskRequest } = loadAskUi();
	assert.equal(pickActiveAskRequest(undefined), undefined);
	assert.equal(pickActiveAskRequest({}), undefined);
	assert.equal(pickActiveAskRequest({ a: { status: "completed", request: request() } }), undefined);
});

test("pickActiveAskRequest: 单个 pending 返回该请求", () => {
	const { pickActiveAskRequest } = loadAskUi();
	const req = request({ requestId: "req-1", method: "select" });
	const picked = pickActiveAskRequest({ a: { status: "pending", request: req } });
	assert.equal(picked, req);
});

test("pickActiveAskRequest: 多 pending 返回最新到达的（不被旧请求遮蔽）", () => {
	const { pickActiveAskRequest } = loadAskUi();
	const oldReq = request({ requestId: "req-old", method: "select", title: "旧问题" });
	const newReq = request({ requestId: "req-new", method: "input", title: "新问题" });
	const picked = pickActiveAskRequest({
		old: { status: "pending", request: oldReq },
		new: { status: "pending", request: newReq },
	});
	assert.equal(picked, newReq);
});

test("pickActiveAskRequest: 过滤 responding 与 pending 之外的请求", () => {
	const { pickActiveAskRequest } = loadAskUi();
	const active = request({ requestId: "req-active" });
	const picked = pickActiveAskRequest({
		a: { status: "cancelled", request: request({ requestId: "a" }) },
		b: { status: "completed", request: request({ requestId: "b" }) },
		c: { status: "responding", request: active },
	});
	assert.equal(picked, active);
});

test("resolveActiveAskRequest: 同代且 pending 时才返回请求", () => {
	const { resolveActiveAskRequest } = loadAskUi();
	const req = request({ requestId: "req-1", method: "select" });
	const ui = { agentId: "agent-1", runtimeGeneration: 3, requests: { a: { status: "pending", request: req } } };
	assert.equal(resolveActiveAskRequest({ agentId: "agent-1", runtimeGeneration: 3, status: "running" }, ui), req);
	// 旧 runtime 的迟到请求：agentId / generation 不同一律拒绝
	assert.equal(resolveActiveAskRequest({ agentId: "agent-1", runtimeGeneration: 2, status: "running" }, ui), undefined);
	assert.equal(resolveActiveAskRequest({ agentId: "agent-old", runtimeGeneration: 3, status: "running" }, ui), undefined);
	// detached / closed 的 runtime 不再可交互（即使 UI 还残留 pending 请求）
	assert.equal(resolveActiveAskRequest({ agentId: "agent-1", runtimeGeneration: 3, status: "detached" }, ui), undefined);
	assert.equal(resolveActiveAskRequest({ agentId: "agent-1", runtimeGeneration: 3, status: "closed" }, ui), undefined);
	// 缺少 runtime 或 ui 时没有可交互请求
	assert.equal(resolveActiveAskRequest(undefined, ui), undefined);
	assert.equal(resolveActiveAskRequest({ agentId: "agent-1", runtimeGeneration: 3, status: "running" }, undefined), undefined);
});

test("shouldAutoAdvanceBatchAnswer: 多题批次的单值选择才自动前进", () => {
	const { shouldAutoAdvanceBatchAnswer } = loadAskUi();
	// select / confirm / input 是「一次提交即完成本题」，答完即自动前进（issue #230 第 1 点）
	assert.equal(shouldAutoAdvanceBatchAnswer({ type: "select", total: 3 }), true);
	assert.equal(shouldAutoAdvanceBatchAnswer({ type: "confirm", total: 3 }), true);
	assert.equal(shouldAutoAdvanceBatchAnswer({ type: "input", total: 3 }), true);
	// multi_select 需多次勾选，editor 每次击键都写答案（会打字即跳题），都不能自动跳
	assert.equal(shouldAutoAdvanceBatchAnswer({ type: "multi_select", total: 3 }), false);
	assert.equal(shouldAutoAdvanceBatchAnswer({ type: "editor", total: 3 }), false);
	// 单题批次不自动：卡片本身就是确认卡，点选项即提交等于删掉确认步骤，误触无法反悔。
	assert.equal(shouldAutoAdvanceBatchAnswer({ type: "select", total: 1 }), false);
	assert.equal(shouldAutoAdvanceBatchAnswer({ type: "confirm", total: 1 }), false);
	assert.equal(shouldAutoAdvanceBatchAnswer({ type: "select", total: 0 }), false);
});

test("classifyAskCardStatus: 明确回答视为 answered", () => {
	const { classifyAskCardStatus } = loadAskUi();
	assert.equal(classifyAskCardStatus("answered", false), "answered");
	// answered 状态但 response.cancelled=true：两者都未成定论，按历史行为视为仍待确认（waiting）
	assert.equal(classifyAskCardStatus("answered", true), "waiting");
});

test("classifyAskCardStatus: 取消或出错视为 cancelled", () => {
	const { classifyAskCardStatus } = loadAskUi();
	assert.equal(classifyAskCardStatus("cancelled", false), "cancelled");
	assert.equal(classifyAskCardStatus("error", false), "cancelled");
});

test("classifyAskCardStatus: 其余（含缺省）视为 waiting", () => {
	const { classifyAskCardStatus } = loadAskUi();
	assert.equal(classifyAskCardStatus("pending", false), "waiting");
	assert.equal(classifyAskCardStatus(undefined, false), "waiting");
	assert.equal(classifyAskCardStatus("responding", false), "waiting");
});

const json = (value) => JSON.stringify(value);

test("buildAskResponse: select/input/editor 回传 value", () => {
	const { buildAskResponse } = loadAskUi();
	assert.equal(json(buildAskResponse("select", "选项A")), json({ value: "选项A" }));
	assert.equal(json(buildAskResponse("input", "文本")), json({ value: "文本" }));
	assert.equal(json(buildAskResponse("editor", "多行\n内容")), json({ value: "多行\n内容" }));
});

test("buildAskResponse: confirm 回传 confirmed + value", () => {
	const { buildAskResponse } = loadAskUi();
	assert.equal(json(buildAskResponse("confirm", true, { confirmed: true })), json({ confirmed: true, value: true }));
	assert.equal(json(buildAskResponse("confirm", false, { confirmed: false })), json({ confirmed: false, value: false }));
});

test("buildAskResponse: 取消回传 cancelled", () => {
	const { buildAskResponse } = loadAskUi();
	assert.equal(json(buildAskResponse("input", undefined, { cancelled: true })), json({ cancelled: true }));
});

test("splitAskOption: 保留普通选项并拆分标题与说明", () => {
	const { splitAskOption, formatAskTitle } = loadAskUi();
	assert.equal(
		JSON.stringify(splitAskOption("开始执行|恢复写权限，按步骤改代码并勾进度")),
		JSON.stringify({
			label: "开始执行",
			description: "恢复写权限，按步骤改代码并勾进度",
		}),
	);
	assert.equal(
		JSON.stringify(splitAskOption("包含 | 竖线的普通文案")),
		JSON.stringify({
			label: "包含",
			description: "竖线的普通文案",
		}),
	);
	assert.equal(JSON.stringify(splitAskOption("普通选项")), JSON.stringify({ label: "普通选项" }));
	assert.equal(
		JSON.stringify(splitAskOption("模型 A — 适合长上下文任务")),
		JSON.stringify({
			label: "模型 A",
			description: "适合长上下文任务",
		}),
	);
	assert.equal(formatAskTitle("[PI_DECK_PLAN_NEXT] 计划草案已就绪\n\n1. 读取代码"), "计划草案已就绪\n\n1. 读取代码");
});

test("parseSecurityConfirmTitle: 解析安全确认 JSON 负载，非安全标题返回 null", () => {
	const { parseSecurityConfirmTitle } = loadAskUi();
	const parsed = parseSecurityConfirmTitle('[PI_DECK_SECURITY_CONFIRM]{"tool":"bash","level":"standard","detail":"rm -rf node_modules"}');
	assert.equal(
		JSON.stringify(parsed),
		JSON.stringify({
			tool: "bash",
			level: "standard",
			detail: "rm -rf node_modules",
		}),
	);
	// 非安全确认标题不误判
	assert.equal(parseSecurityConfirmTitle("普通提问"), null);
	assert.equal(parseSecurityConfirmTitle("[PI_DECK_PLAN_NEXT] 计划草案"), null);
});

test("parseSecurityConfirmTitle: JSON 损坏兑底返回原始负载，不丢确认卡", () => {
	const { parseSecurityConfirmTitle } = loadAskUi();
	const parsed = parseSecurityConfirmTitle("[PI_DECK_SECURITY_CONFIRM]not-json");
	assert.equal(parsed.tool, "");
	assert.equal(parsed.level, "");
	assert.equal(parsed.detail, "not-json");
});

test("formatAskTitle: 安全确认标记兑换底为可读摘要，不泄露 JSON", () => {
	const { formatAskTitle, formatSecurityConfirmSummary } = loadAskUi();
	assert.equal(formatAskTitle('[PI_DECK_SECURITY_CONFIRM]{"tool":"bash","level":"strict","detail":"sudo rm"}'), "安全确认：bash");
	assert.equal(formatSecurityConfirmSummary({ tool: "", level: "", detail: "" }), "安全确认");
});

test("serializeBatchAnswers: 混合题型序列化并保留 label/wasCustom", () => {
	const { serializeBatchAnswers, batchAnswerLabel } = loadAskUi();
	const questions = [
		{ id: "b1", type: "select" },
		{ id: "b2", type: "confirm" },
		{ id: "b3", type: "input" },
	];
	const answers = {
		b1: "React",
		b2: true,
		b3: undefined,
	};
	const meta = {
		b1: { label: "React", wasCustom: false },
		b3: { label: "自定", wasCustom: true },
	};
	const parsed = JSON.parse(serializeBatchAnswers(questions, answers, meta));
	assert.equal(parsed.answers.length, 3);
	assert.deepEqual(parsed.answers[0], { id: "b1", type: "select", value: "React", label: "React", wasCustom: false });
	assert.deepEqual(parsed.answers[1], { id: "b2", type: "confirm", value: true, label: "true", wasCustom: false });
	assert.deepEqual(parsed.answers[2], { id: "b3", type: "input", value: null, label: "自定", wasCustom: true });
	// 无 meta 时 label 回退 batchAnswerLabel
	assert.equal(batchAnswerLabel(true), "true");
	assert.equal(batchAnswerLabel("x"), "x");
	assert.equal(batchAnswerLabel(undefined), "");
});

test("serializeBatchAnswers: multi_select 数组 value 序列化与 label 拼接", () => {
	const { serializeBatchAnswers, batchAnswerLabel } = loadAskUi();
	const questions = [{ id: "m1", type: "multi_select" }];
	const answers = { m1: ["A", "C"] };
	const parsed = JSON.parse(serializeBatchAnswers(questions, answers));
	assert.deepEqual(parsed.answers[0], { id: "m1", type: "multi_select", value: ["A", "C"], label: "A、C", wasCustom: false });
	// 空数组视为未作答（label 回退为空）
	assert.equal(batchAnswerLabel([]), "");
	assert.equal(batchAnswerLabel(["A"]), "A");
	assert.equal(batchAnswerLabel(["A", "B", "C"]), "A、B、C");
});

function mockSelection(text) {
	return {
		window: {
			getSelection: () => (text === null ? null : { toString: () => text }),
		},
	};
}

// 按压感知划选守卫（askUi.ts）：只吞「本次按压新拖出的选区」。
// 背景：Chromium 按钮上 mousedown 不塌缩选区，旧守卫直接查全局选区会把
// 「划选复制/双击选词之后的真实点击」也吞掉（ask 选项点不动，2026-09 修复）。
test("shouldSuppressAskClickSnapshot: click 时无有效选区 → 放行（任意快照）", () => {
	const { shouldSuppressAskClickSnapshot } = loadAskUi("");
	assert.equal(shouldSuppressAskClickSnapshot("", ""), false);
	assert.equal(shouldSuppressAskClickSnapshot("旧选区", ""), false);
	assert.equal(shouldSuppressAskClickSnapshot(null, ""), false);
	// 纯空白选区与旧守卫 trim 语义一致
	assert.equal(shouldSuppressAskClickSnapshot(null, "  \n\t  "), false);
});

test("shouldSuppressAskClickSnapshot: 选区与按压快照一致（旧选区残留）→ 放行 —— 修复点", () => {
	const { shouldSuppressAskClickSnapshot } = loadAskUi("问题标题文本");
	assert.equal(shouldSuppressAskClickSnapshot("问题标题文本", "问题标题文本"), false);
});

test("shouldSuppressAskClickSnapshot: 选区与快照不一致（本次按压新拖出）→ 吞掉", () => {
	const { shouldSuppressAskClickSnapshot } = loadAskUi("拖出来的新选区");
	// 按压开始时无选区，click 时出现选区 = 划选恰好结束在按钮上的冒充 click
	assert.equal(shouldSuppressAskClickSnapshot("", "拖出来的新选区"), true);
	// 按压期间选区被改变同样视为冒充
	assert.equal(shouldSuppressAskClickSnapshot("按压前的旧选区", "改变后选区"), true);
});

test("shouldSuppressAskClickSnapshot: 无按压快照且有选区 → 保守吞掉（兜底旧守卫语义）", () => {
	const { shouldSuppressAskClickSnapshot } = loadAskUi("划选文本");
	assert.equal(shouldSuppressAskClickSnapshot(null, "划选文本"), true);
	assert.equal(shouldSuppressAskClickSnapshot(undefined, "划选文本"), true);
});

test("shouldSuppressAskClick: 无 window 视为不吞（SSR 兜底）", () => {
	const { shouldSuppressAskClick } = loadAskUi(undefined);
	assert.equal(shouldSuppressAskClick(), false);
});

// ── 静态契约 ──

test("SessionRuntimeUiOverlay 使用提取的纯逻辑与语义字号 token", () => {
	const source = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
	assert.match(source, /import \{[^}]*resolveActiveAskRequest[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.match(source, /import \{[^}]*buildAskResponse[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.match(source, /import \{[^}]*serializeBatchAnswers[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.match(source, /import \{[^}]*shouldSuppressAskClick[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.doesNotMatch(source, /hasTextSelection/);
	// 不再直接构造应答 payload（统一走 askUi.buildAskResponse）
	assert.doesNotMatch(source, /void answer\(\{ value/);
	assert.doesNotMatch(source, /void answer\(\{ confirmed/);
	// 选项按钮 shadcn outline 化 + 字号 token（不再硬编码 text-[13px]）
	assert.match(source, /variant="outline"/);
	assert.doesNotMatch(source, /text-\[13px\]/);
	assert.doesNotMatch(source, /text-\[11px\]/);
	// submitValue 与 BatchQuestion 的 true/false/select 都要守卫划选（后者不走 submitValue）；
	// 统一用按压感知守卫：只吞本次按压新拖出的选区，旧选区残留不得吞真实点击
	const guards = source.match(/if \(shouldSuppressAskClick\(\)\) return;/g);
	assert.ok(guards && guards.length >= 4);
});

test("SessionRuntimeUiOverlay keeps recovery prompts visible after model errors", () => {
	const source = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
	assert.doesNotMatch(source, /runtime\.status !== "error"/);
	// 同代判定（含 detached/closed 拒绝）已提到 askUi.resolveActiveAskRequest：
	// overlay 与布局层（底栏占位）必须用同一份判据，不能再在组件里各写一份。
	const askUi = readFileSync("src/renderer/src/utils/askUi.ts", "utf8");
	assert.match(askUi, /runtime\.status === "detached" \|\| runtime\.status === "closed"/);
	assert.match(source, /resolveActiveAskRequest\(runtime, ui\)/);
});

test("Timeline 已清理死代码，安全卡在选项点击前调按压感知守卫", () => {
	const timeline = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
	const security = readFileSync("src/renderer/src/components/overlays/SecurityConfirmCard.tsx", "utf8");
	// AskQuestionCard 死代码已删除：Timeline 不再有可交互 ask 卡片，守卫职责由 SessionRuntimeUiOverlay 承担
	assert.doesNotMatch(timeline, /import \{[^}]*hasTextSelection[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	assert.match(security, /import \{[^}]*shouldSuppressAskClick[^}]*\} from "\.\.\/\.\.\/utils\/askUi"/);
	const securityGuards = security.match(/if \(shouldSuppressAskClick\(\)\) return;/g);
	assert.ok(securityGuards && securityGuards.length >= 2);
});

test("AgentManager/飞书 envelope 白名单接受 multi_select 批量问题", () => {
	// multi_select 走批量 envelope，主进程与飞书两处同构解析都必须放行该类型
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	const askCard = readFileSync("src/main/feishu/AskCard.ts", "utf8");
	// 渲染端 toAgentUiRequest 白名单也必须同构放行，否则 multi_select 选项不渲染
	// （2026-09 回归：主进程放行、渲染端过滤导致选项组件整体消失）。
	const sessionAtoms = readFileSync("src/renderer/src/atoms/session-atoms.ts", "utf8");
	const whiteList = /\["select", "multi_select", "confirm", "input", "editor"\]\.includes\(String\(typed\.type\)\)/;
	assert.match(agentManager, whiteList);
	assert.match(askCard, whiteList);
	assert.match(sessionAtoms, whiteList);
});

test("AgentManager select 无选项降级为 input（不静默取消）", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /select 无有效选项时降级为 input/);
	assert.match(source, /effectiveMethod/);
	assert.doesNotMatch(source, /select 无选项时自动取消，不等用户响应/);
});

test("ask_question 扩展 schema 支持 multi_select 且强制走批量 envelope", () => {
	const ext = readFileSync("resources/extensions/pi-deck-ask-question.ts", "utf8");
	// 批量与单问题两处类型枚举都含 multi_select
	const enumOccurrences = ext.match(/StringEnum\(\["select", "multi_select", "confirm", "input", "editor"\]/g);
	assert.ok(enumOccurrences && enumOccurrences.length >= 2);
	// 单问题 multi_select 也强制走批量 envelope（RPC 单选无法表达多选）
	assert.match(ext, /needsBatchEnvelope = isBatch \|\| questions\.some\(\(q\) => q\.type === "multi_select"\)/);
	// multi_select 空数组视为未作答
	assert.match(ext, /!Array\.isArray\(value\) \|\| value\.length > 0/);
});

test("渲染层不再用 find 取第一个 pending 请求", () => {
	const source = readFileSync("src/renderer/src/components/overlays/SessionRuntimeUiOverlay.tsx", "utf8");
	assert.doesNotMatch(source, /Object\.values\(ui\.requests\)\.find/);
	// 同代判定 + 当前请求解析统一走 askUi.resolveActiveAskRequest：
	// 布局层（SessionRuntimeInjector）必须用同一份判据决定底栏 ask 是否占位。
	assert.match(source, /resolveActiveAskRequest\(runtime, ui\)/);
});
