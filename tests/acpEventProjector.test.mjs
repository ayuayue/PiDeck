/**
 * ACP 投影器状态机单测(纯函数,不依赖真实 CLI):
 * user 回显、assistant 流式聚合(thought 与 message 分流)、tool 卡片按
 * toolCallId 精确回写状态、plan/available_commands_update 投影、settleAcpTurn
 * 回合收口、未知 update 前向兼容忽略。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { initialAcpProjection, projectAcpSessionUpdate, settleAcpTurn, appendAcpUserPrompt, rollbackAcpUserPrompt, ACP_TOOL_RESULT_MAX_CHARS } = loadTsCommonJs("src/main/acp/AcpEventProjector.ts");

const AGENT = "agent-1";

function step(state, update) {
	return projectAcpSessionUpdate(state, update, AGENT);
}

test("user_message_chunk merges the blocks of one replayed prompt into a single message", () => {
	// 规范一次只携带一个 content block;同一 prompt 的文本+图片分多条 update 回放,
	// 必须并回同一条消息,否则图文 prompt 恢复后被拆成多个气泡。
	let state = step(initialAcpProjection(), { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello " } });
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "world" } });
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "image", data: "abcd", mimeType: "image/png" } });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].role, "user");
	assert.equal(state.messages[0].text, "hello world");
	assert.equal(state.messages[0].images[0].mimeType, "image/png");
	assert.equal(state.replayed, true);
});

test("agent_message_chunk aggregates into one streaming assistant message per turn", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo world" } });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].text, "Hello world");
	assert.equal(state.activeAssistantIndex, 0);
	state = settleAcpTurn(state, "end_turn");
	// 新回合由本地 seed 的用户消息开启,助手正文另起一条
	state = appendAcpUserPrompt(state, "next prompt", null, AGENT);
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "second turn" } });
	assert.equal(state.messages.length, 3);
	assert.equal(state.messages[2].text, "second turn");
});

test("late chunk after turn settle merges back into the same assistant bubble", () => {
	// 实测(opencode):session/prompt 响应先返回,末尾几个 chunk 随后才到。
	// 收口时若按「新回合」另起气泡,一条回复会被拆成两处渲染(用户截图:词中间断开)。
	let state = appendAcpUserPrompt(initialAcpProjection(), "你好", null, AGENT);
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我是 opencode,底层模型是 zui/deep" } });
	state = settleAcpTurn(state, "end_turn");
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "seek-v4.1-flash)。" } });
	assert.equal(state.messages.length, 2, "用户消息 + 一条完整助手消息");
	assert.equal(state.messages[1].text, "我是 opencode,底层模型是 zui/deepseek-v4.1-flash)。");
	assert.equal(state.messages[1].stopReason, "pending", "仍在续写:恢复流式态,等真正结束时再 settle");
});

test("late chunk does not merge when a new turn has already seeded its user message", () => {
	let state = appendAcpUserPrompt(initialAcpProjection(), "第一问", null, AGENT);
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第一答" } });
	state = settleAcpTurn(state, "end_turn");
	state = appendAcpUserPrompt(state, "第二问", null, AGENT);
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "第二答" } });
	assert.equal(state.messages.length, 4);
	assert.equal(state.messages[1].text, "第一答");
	assert.equal(state.messages[3].text, "第二答");
});

test("deduped prompt echo does not break the streaming bubble", () => {
	// 回显不是轮次边界:去重命中若清空流式指针,后续 chunk 会另起气泡
	let state = appendAcpUserPrompt(initialAcpProjection(), "你好", null, AGENT);
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "前半" } });
	assert.equal(state.activeAssistantIndex, 1);
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "你好" } });
	assert.equal(state.activeAssistantIndex, 1, "去重命中的回显不得清空流式指针");
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "后半" } });
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[1].text, "前半后半");
});

test("thought chunks stream into thinking field, not message text", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking..." } });
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer" } });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].text, "answer");
	assert.equal(state.messages[0].thinking, "thinking...");
});

test("tool_call updates the same card by toolCallId across status transitions", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read file", kind: "read", status: "in_progress" });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].meta.status, "running");
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "Read file", kind: "read", status: "completed", content: [{ type: "text", text: "file body" }] });
	// 同一 callId 更新原卡片,不新增消息
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].meta.status, "completed");
	assert.equal(state.messages[0].meta.fullText, "file body");
	// 第二个工具追加新卡片
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc2", title: "Run build", kind: "execute", status: "in_progress", locations: [{ path: "src/a.ts", line: 3 }] });
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[1].meta.locations.length, 1);
	// 流式 assistant 消息不会被工具卡切断:消息后仍可继续聚合
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } });
	const last = state.messages[state.messages.length - 1];
	assert.equal(last.role, "assistant");
	assert.equal(last.text, "done");
});

test("tool content truncates beyond cap and keeps fullText", () => {
	const long = "x".repeat(ACP_TOOL_RESULT_MAX_CHARS + 100);
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc1", title: "T", status: "completed", content: [{ type: "text", text: long }] });
	assert.equal(state.messages[0].meta.fullText.length, ACP_TOOL_RESULT_MAX_CHARS + 100);
	assert.ok(state.messages[0].text === undefined || state.messages[0].text.length <= 4);
	// 特殊块占位
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "tc2", title: "T2", status: "completed", content: [{ type: "diff", path: "a.ts" }, { type: "terminal" }] });
	assert.match(state.messages[1].meta.fullText, /\[diff a\.ts\]/);
	assert.match(state.messages[1].meta.fullText, /\[terminal\]/);
});

test("plan and available_commands_update project last-wins", () => {
	let state = initialAcpProjection();
	state = step(state, {
		sessionUpdate: "plan",
		plan: [
			{ content: "a", status: "in_progress" },
			{ content: "b", status: "pending" },
		],
	});
	assert.equal(state.todos.length, 2);
	assert.equal(state.todos[0].status, "in_progress");
	state = step(state, { sessionUpdate: "plan", plan: [{ content: "only", status: "completed" }] });
	assert.equal(state.todos.length, 1);
	assert.equal(state.todos[0].status, "completed");
	state = step(state, { sessionUpdate: "available_commands_update", commands: [{ name: "/run", description: "run it" }] });
	assert.equal(state.commands.length, 1);
	assert.equal(state.commands[0].name, "/run");
	assert.equal(state.commands[0].source, "acp");
	// opencode 等实现实际发 availableCommands（2027-02 live smoke 实测）：必须等价投影。
	state = step(state, { sessionUpdate: "available_commands_update", availableCommands: [{ name: "/review", description: "review changes" }] });
	assert.equal(state.commands.length, 1);
	assert.equal(state.commands[0].name, "/review");
});

test("usage_update 投影为 runtime 上下文仪表数据源（opencode 顶层形态 + usage 嵌套形态）", () => {
	let state = initialAcpProjection();
	// 顶层形态：opencode 实测帧 {"sessionUpdate":"usage_update","used":25528,"size":1000000,"cost":{"amount":0,"currency":"USD"}}
	state = step(state, { sessionUpdate: "usage_update", used: 25528, size: 1_000_000, cost: { amount: 1.23, currency: "USD" } });
	assert.equal(state.usage?.used, 25528);
	assert.equal(state.usage?.size, 1_000_000);
	assert.equal(state.usage?.costAmount, 1.23);
	assert.equal(state.usage?.costCurrency, "USD");
	// usage 嵌套形态：部分实现把指标放进 usage 子对象；cost 是裸数字；缺字段不抹掉旧值。
	state = step(state, { sessionUpdate: "usage_update", usage: { used: 41000, size: 200_000, cost: 0.5 } });
	assert.equal(state.usage?.used, 41000);
	assert.equal(state.usage?.size, 200_000);
	assert.equal(state.usage?.costAmount, 0.5);
	// 空载荷/全部缺失：保留上一份 usage（last-wins 只对有值字段生效）
	state = step(state, { sessionUpdate: "usage_update" });
	assert.equal(state.usage?.used, 41000);
});

test("session_info_update records title and unknown updates are ignored", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "session_info_update", sessionTitle: "My session" });
	assert.equal(state.title, "My session");
	const before = state.messages.length;
	state = step(state, { sessionUpdate: "some_future_update", anything: true });
	assert.equal(state.messages.length, before);
	assert.equal(state.replayed, true);
});

test("standard tool_call_update patches retain omitted fields and unwrap content", () => {
	let state = step(initialAcpProjection(), { sessionUpdate: "tool_call", toolCallId: "tc-standard", title: "Read file", kind: "read", status: "pending", rawInput: { path: "src/a.ts" } });
	state = step(state, { sessionUpdate: "tool_call_update", toolCallId: "tc-standard", status: "completed", content: [{ type: "content", content: { type: "text", text: "file body" } }] });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].meta.status, "completed");
	assert.equal(state.messages[0].meta.toolName, "Read file");
	assert.equal(state.messages[0].meta.kind, "read");
	assert.equal(state.messages[0].meta.fullText, "file body");
	assert.equal(state.messages[0].meta.args.path, "src/a.ts");
	assert.match(state.messages[0].meta.detailText, /file body/);
	state = step(state, { sessionUpdate: "tool_call_update", toolCallId: "tc-standard", title: "Read src/a.ts", locations: [] });
	assert.equal(state.messages[0].meta.status, "completed", "omitted status must not reset a completed card to running");
	assert.equal(state.messages[0].meta.toolName, "Read src/a.ts");
	assert.equal(state.messages[0].meta.fullText, "file body");
	assert.equal(state.messages[0].text, "Read src/a.ts");
	assert.equal(state.messages[0].meta.locations.length, 0);
	state = step(state, { sessionUpdate: "tool_call_update", toolCallId: "tc-standard", content: [] });
	assert.equal(state.messages[0].meta.fullText, "", "an empty replacement must clear the previous result");
	assert.doesNotMatch(state.messages[0].meta.detailText, /file body/);
});

test("failed tool patches use the existing error-card contract and retain scalar input/output", () => {
	let state = step(initialAcpProjection(), { sessionUpdate: "tool_call", toolCallId: "tc-error", title: "Run command", kind: "execute", status: "in_progress", rawInput: "git status" });
	state = step(state, { sessionUpdate: "tool_call_update", toolCallId: "tc-error", status: "failed", rawOutput: "permission denied" });
	assert.equal(state.messages[0].meta.status, "error");
	assert.equal(state.messages[0].meta.isError, true);
	assert.equal(state.messages[0].meta.args, "git status");
	assert.match(state.messages[0].meta.detailText, /permission denied/);
	state = step(state, { sessionUpdate: "tool_call_update", toolCallId: "tc-error", title: "Failed command" });
	assert.equal(state.messages[0].meta.status, "error");
	assert.match(state.messages[0].meta.detailText, /permission denied/);
});

test("standard plan entries replace todos, including an empty plan", () => {
	let state = step(initialAcpProjection(), { sessionUpdate: "plan", entries: [{ content: "Inspect", priority: "high", status: "in_progress" }] });
	assert.equal(state.todos.length, 1);
	assert.equal(state.todos[0].content, "Inspect");
	assert.equal(state.todos[0].status, "in_progress");
	state = step(state, { sessionUpdate: "plan", entries: [] });
	assert.equal(state.todos.length, 0);
});

test("tool content images attach to the card and follow the content table on later patches", () => {
	let state = step(initialAcpProjection(), {
		sessionUpdate: "tool_call",
		toolCallId: "shot",
		title: "screenshot",
		kind: "execute",
		status: "completed",
		content: [
			{ type: "content", content: { type: "text", text: "captured" } },
			{ type: "content", content: { type: "image", data: "abcd", mimeType: "image/png" } },
		],
	});
	assert.equal(state.messages[0].images?.length, 1, "image results must survive projection instead of becoming a lost placeholder");
	assert.equal(state.messages[0].images[0].data, "abcd");
	assert.ok(state.messages[0].meta.fullText.includes("captured"));
	assert.ok(state.messages[0].meta.fullText.includes("[image]"));
	state = step(state, { sessionUpdate: "tool_call_update", toolCallId: "shot", status: "completed" });
	assert.equal(state.messages[0].images?.length, 1, "a patch without content keeps the previous result images");
	state = step(state, { sessionUpdate: "tool_call_update", toolCallId: "shot", content: [{ type: "content", content: { type: "text", text: "text only" } }] });
	assert.equal(state.messages[0].images, undefined, "replacing the content table clears stale images");
});

test("history replay separates assistant turns at the next user message", () => {
	let state = step(initialAcpProjection(), { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Question one" } });
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer one" } });
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Question two" } });
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer two" } });
	assert.equal(state.messages.length, 4);
	assert.equal(state.messages[1].text, "Answer one");
	assert.equal(state.messages[1].stopReason, "stop");
	assert.equal(state.messages[3].text, "Answer two");
});

test("settleAcpTurn maps max_tokens to a length stop instead of error", () => {
	const state = step(initialAcpProjection(), { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
	assert.equal(settleAcpTurn(state, "max_tokens").messages[0].stopReason, "length");
	assert.equal(settleAcpTurn(state, "max_turn_requests").messages[0].stopReason, "length");
	assert.equal(settleAcpTurn(state, "refusal").messages[0].stopReason, "stop");
});

test("settleAcpTurn marks stop reason and clears active index", () => {
	let state = initialAcpProjection();
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
	state = settleAcpTurn(state, "cancelled");
	assert.equal(state.messages.length, 1);
	// cancelled/aborted 归一为渲染层 aborted 语义
	assert.equal(state.messages[0].stopReason, "aborted");
	assert.equal(state.activeAssistantIndex, undefined);
});

test("agent_message_chunk image blocks accumulate into assistant images (generation results survive)", () => {
	// 首个块是图片(无文本):不能因 text 为空而丢弃,必须创建带 images 的 assistant 消息
	let state = step(initialAcpProjection(), { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "img1", mimeType: "image/png" } });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].role, "assistant");
	assert.equal(state.messages[0].images.length, 1);
	assert.equal(state.messages[0].images[0].data, "img1");
	// 同回合后续文本与第二张图都归并进同一条消息
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "here you go" } });
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "img2", mimeType: "image/jpeg" } });
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].text, "here you go");
	assert.equal(state.messages[0].images.map((image) => image.data).join(","), "img1,img2");
});

test("agent_thought_chunk image blocks are dropped (thought stream is text-only)", () => {
	let state = step(initialAcpProjection(), { sessionUpdate: "agent_thought_chunk", content: { type: "image", data: "nope", mimeType: "image/png" } });
	assert.equal(state.messages.length, 0);
});

test("lastTouched reports the message indices touched by this update (materialization side channel)", () => {
	let state = initialAcpProjection();
	// user 文本/图片:新消息下标
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hi" } });
	assert.deepEqual([...state.lastTouched], [0]);
	// assistant 新建:下标
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "a" } });
	assert.deepEqual([...state.lastTouched], [1]);
	// assistant 归并:同一回合内重复指向同一条消息
	state = step(state, { sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x", mimeType: "image/png" } });
	assert.deepEqual([...state.lastTouched], [1]);
	// tool 卡新建与更新:各自报下标
	state = settleAcpTurn(state, "end_turn");
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "bash", status: "running", content: [] });
	assert.deepEqual([...state.lastTouched], [2]);
	state = step(state, { sessionUpdate: "tool_call", toolCallId: "call-1", title: "bash", status: "completed", content: [{ type: "text", text: "done" }] });
	assert.deepEqual([...state.lastTouched], [2]);
	// 与消息无关的 update:不报 touched
	state = step(state, { sessionUpdate: "session_info_update", sessionTitle: "t" });
	assert.equal(state.lastTouched, undefined);
});

/**
 * 本地 prompt 回显（2026-10 用户反馈：ACP 时间线只有 AI 回复，用户消息不见了）。
 * ACP 的 user_message_chunk 是 agent 的可选回显，OpenCode 等不发；条目必须由主进程
 * 在 prompt 派发处落下，否则渲染层的乐观气泡会被 agents:message 全量替换抹掉。
 */
test("appendAcpUserPrompt seeds the user message and a fallback title", () => {
	const state = appendAcpUserPrompt(initialAcpProjection(), "帮我修复登录页面的 bug", null, AGENT);
	assert.equal(state.messages.length, 1);
	assert.equal(state.messages[0].role, "user");
	assert.equal(state.messages[0].text, "帮我修复登录页面的 bug");
	assert.equal(state.messages[0].agentId, AGENT);
	assert.equal(state.replayed, true);
	assert.ok(state.title && state.title.length > 0, "首条 prompt 必须兜底一个标题，否则 ACP 会话标题永远不变");
	assert.deepEqual([...state.lastTouched], [0], "图片物化需要知道新条目下标");
});

test("appendAcpUserPrompt keeps image blocks and skips empty prompts", () => {
	const empty = appendAcpUserPrompt(initialAcpProjection(), "", [], AGENT);
	assert.equal(empty.messages.length, 0, "空 prompt 不落条目");
	assert.equal(empty.title, undefined, "空 prompt 不产生标题");
	const withImage = appendAcpUserPrompt(initialAcpProjection(), "看图", [{ type: "image", mimeType: "image/png", data: "abcd" }], AGENT);
	assert.equal(withImage.messages[0].images[0].mimeType, "image/png");
});

test("un-echoed prompts do not accumulate pending echo entries", () => {
	let state = appendAcpUserPrompt(initialAcpProjection(), "first", null, AGENT);
	state = appendAcpUserPrompt(state, "second", null, AGENT);
	state = appendAcpUserPrompt(state, "third", null, AGENT);
	assert.equal(state.messages.length, 3);
	assert.equal(state.localUserEchoes.length, 1, "全程不回显的 agent 不应每条 prompt 留一个永不消费的条目");
	assert.equal(state.localUserEchoes[0].text, "third");
});

test("agent echo of the seeded prompt is deduped by prefix, not appended twice", () => {
	let state = appendAcpUserPrompt(initialAcpProjection(), "hello world", null, AGENT);
	// 流式回显：分片也要能被前缀消费（否则每条分片都会变成一条新用户消息）
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } });
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "text", text: " world" } });
	assert.equal(state.messages.length, 1, "agent 回显同文不得追加第二条");
	assert.equal(state.messages[0].text, "hello world");
	assert.equal(state.localUserEchoes.length, 0, "消费完的回显条目必须出队");
});

test("user_message_chunk with different text stays a separate message", () => {
	let state = appendAcpUserPrompt(initialAcpProjection(), "my prompt", null, AGENT);
	// agent 自己注入的用户侧消息（如上下文拼接）：不能误吞
	state = step(state, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "[injected context]" } });
	assert.equal(state.messages.length, 2);
	assert.equal(state.messages[1].text, "[injected context]");
	assert.equal(state.localUserEchoes.length, 0, "不同文说明 agent 不回显，不再等待同文回显");
});

test("agent-provided title overrides the prompt fallback (last wins)", () => {
	let state = appendAcpUserPrompt(initialAcpProjection(), "first prompt here", null, AGENT);
	const fallback = state.title;
	state = step(state, { sessionUpdate: "session_info_update", sessionTitle: "Agent Title" });
	assert.equal(state.title, "Agent Title");
	// 第二条 prompt 不得把 agent 给的标题改回去
	state = appendAcpUserPrompt(state, "second prompt", null, AGENT);
	assert.equal(state.title, "Agent Title");
	assert.notEqual(fallback, "Agent Title");
});

test("rollbackAcpUserPrompt drops the seeded message only when nothing was produced", () => {
	// 派发失败（JSON-RPC 拒绝）且 agent 未产出：撤回，避免幽灵用户消息
	let failed = appendAcpUserPrompt(initialAcpProjection(), "rejected", null, AGENT);
	failed = rollbackAcpUserPrompt(failed, 0);
	assert.equal(failed.messages.length, 0);
	assert.equal(failed.localUserEchoes.length, 0);
	// agent 已回复：保留现场
	let answered = appendAcpUserPrompt(initialAcpProjection(), "answered", null, AGENT);
	answered = step(answered, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } });
	answered = rollbackAcpUserPrompt(answered, 0);
	assert.equal(answered.messages.length, 2, "已产生回复时不得抽掉用户消息");
	// agent 回显到一半（已收到 prompt，还没回完）：不得撤回
	let echoed = appendAcpUserPrompt(initialAcpProjection(), "hello world", null, AGENT);
	echoed = step(echoed, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "hello" } });
	echoed = rollbackAcpUserPrompt(echoed, 0);
	assert.equal(echoed.messages.length, 1, "agent 已开始回显时不得撤回");
	assert.equal(echoed.localUserEchoes[0].echoed, 5, "回显进度不得被回滚清掉");
	// 空 prompt（未落条目，index -1）：不动任何已有消息
	let untouched = step(initialAcpProjection(), { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old" } });
	untouched = rollbackAcpUserPrompt(untouched, -1);
	assert.equal(untouched.messages.length, 1);
});
