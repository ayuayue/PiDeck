import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

// 「中间回复可引用」DOM 契约（2026-12 引用范围扩展）：
// settled 中间回复的正文根节点必须带 data-message-id，划选浮层才能把选区归属到具体消息；
// 思考卡必须带 data-thinking-step，防止展开正文被误当回答引用。
// 正则全部空白容忍（AGENTS.md 门禁）。

const answerOutputSource = readFileSync("src/renderer/src/components/session/AnswerOutput.tsx", "utf8");
const interimAnswerSource = readFileSync("src/renderer/src/components/session/turn/InterimAnswer.tsx", "utf8");
const turnRowSource = readFileSync("src/renderer/src/components/session/turn/TurnRow.tsx", "utf8");
const processFoldSource = readFileSync("src/renderer/src/components/session/turn/ProcessFold.tsx", "utf8");
const timelineEventCardsSource = readFileSync("src/renderer/src/components/session/TimelineEventCards.tsx", "utf8");
const policySource = readFileSync("src/renderer/src/components/session/timeline/selectionToolbarPolicy.ts", "utf8");
// 只取选择器定义行（注释里会提及被放开的旧选择器名，不能参与断言）。
const quoteExcludedSelectorLine = policySource.split("\n").find((line) => line.includes("QUOTE_EXCLUDED_SELECTOR =")) ?? "";

test("AnswerOutput renders data-message-id anchor on settled interim bodies", () => {
	// messageId prop 存在并透传到 settled 容器的 data-message-id
	assert.match(answerOutputSource, /messageId\?:\s*string/);
	assert.match(answerOutputSource, /data-message-id=\{props\.messageId\}/);
	// live 分支（主组件内）不加锚点（流式轮整体排除，快照会失真）
	const liveBranch = answerOutputSource.slice(answerOutputSource.indexOf('props.mode === "live"'), answerOutputSource.indexOf("const cleanText"));
	assert.ok(liveBranch.length > 0, "live branch must exist");
	assert.doesNotMatch(liveBranch, /data-message-id/);
	// LiveAnswerBody 带排除戳：settle 交接期残留时（轮已切 complete），
	// 划选不得解析到外层 run id——靠 data-live-answer 截住。
	const liveBodyIndex = answerOutputSource.indexOf("const LiveAnswerBody");
	assert.ok(liveBodyIndex > 0, "LiveAnswerBody must exist");
	const liveBody = answerOutputSource.slice(liveBodyIndex);
	assert.doesNotMatch(liveBody, /data-message-id/);
	assert.match(liveBody, /data-live-answer="true"/);
});

test("InterimAnswer forwards messageId to AnswerOutput", () => {
	assert.match(interimAnswerSource, /messageId\?:\s*string/);
	assert.match(interimAnswerSource, /messageId=\{props\.messageId\}/);
});

test("TurnRow flat mode passes message id to settled interim answers", () => {
	const interimBranch = turnRowSource.slice(turnRowSource.indexOf('item.kind === "interim-answer"'), turnRowSource.indexOf("<FinalAnswer"));
	assert.ok(interimBranch.length > 0, "interim branch must exist");
	assert.match(interimBranch, /messageId=\{item\.id\}/);
});

test("ProcessFold passes node id to settled interim answers", () => {
	const interimCase = processFoldSource.slice(processFoldSource.indexOf('case "interim"'), processFoldSource.indexOf('case "entry"'));
	assert.ok(interimCase.length > 0, "interim case must exist");
	assert.match(interimCase, /messageId=\{node\.id\}/);
});

test("ThinkingBlock marks its card so expanded reasoning text stays excluded from quoting", () => {
	assert.match(timelineEventCardsSource, /<section\s+data-thinking-step="true"/);
});

test("quote exclusion no longer blacklists the whole execution fold", () => {
	// 放开折叠区整体排除；逐项排除工具/重试/错误/思考/过程组头体/live 正文副本
	assert.ok(quoteExcludedSelectorLine.length > 0, "QUOTE_EXCLUDED_SELECTOR must be defined");
	assert.doesNotMatch(quoteExcludedSelectorLine, /execution-summary-details/);
	for (const marker of ["[data-tool-kind]", "[data-retry-step]", "[data-error-step]", "[data-thinking-step]", "[data-process-group-head]", "[data-process-group-body]", "[data-live-answer]"]) {
		assert.ok(quoteExcludedSelectorLine.includes(marker), `QUOTE_EXCLUDED_SELECTOR must contain ${marker}`);
	}
	assert.match(quoteExcludedSelectorLine, /\.turn-row--pending/);
});
