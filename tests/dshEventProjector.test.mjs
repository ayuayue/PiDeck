import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { projectDshEvent } = loadTsCommonJs("src/main/dsh/dshEventProjector.ts");

const AGENT = "dsh:session-test";

/** 构造 SessionEvent：{ type, seq, time, data }（与 DSH 实测形状一致）。 */
const event = (type, seq, data = {}) => ({ type, seq, time: 1700000000000 + seq, data });

test("user/message 投影为 user 消息（内容块 text 提取）", () => {
	const p = projectDshEvent(undefined, event("user/message", 1, {
		content: [{ type: "text", text: "你好" }],
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:1");
	assert.equal(p.messages[0].agentId, AGENT);
	assert.equal(p.messages[0].role, "user");
	assert.equal(p.messages[0].text, "你好");
	assert.equal(p.messages[0].timestamp, 1700000000001);
	assert.equal(p.messagesChanged, true);
	assert.equal(p.turnEnded, false);
});

test("journal 尾部重放（follow snapshot）：同 seq 事件二次投影不产生重复消息", () => {
	// 回归（2026-09-12）：attach/fork 已投影过历史，follow 流打开时 host 又推一份
	// journal 尾部 snapshot；append 位点不去重会产出同 id 消息，渲染层按 message.id
	// 作 React key → duplicate-key 告警、user 气泡显示两遍（实测 dsh:9/91/100 成对）。
	const e1 = event("user/message", 9, { content: [{ type: "text", text: "第一条" }] });
	const e2 = event("user/message", 91, { content: [{ type: "text", text: "第二条" }] });
	// 首轮：attach 历史重放
	let p = projectDshEvent(undefined, e1, AGENT);
	p = projectDshEvent(p, e2, AGENT);
	assert.equal(p.messages.length, 2);
	// 二轮：follow snapshot 重放同一段 journal
	p = projectDshEvent(p, e1, AGENT);
	p = projectDshEvent(p, e2, AGENT);
	assert.equal(p.messages.length, 2, "同 id 不得重复入列");
	assert.equal(p.messages[0].id, "dsh:9");
	assert.equal(p.messages[1].id, "dsh:91");
	// tool/call 同理（重放不叠加第二张工具卡）
	let q = projectDshEvent(undefined, event("tool/call", 12, { toolName: "pwsh", callId: "c1", arguments: "{}" }), AGENT);
	q = projectDshEvent(q, event("tool/call", 12, { toolName: "pwsh", callId: "c1", arguments: "{}" }), AGENT);
	assert.equal(q.messages.length, 1, "tool 卡片同 id 只入列一次");
});

test("user/message source.kind=user（带 rpcId）正常投影", () => {
	const p = projectDshEvent(undefined, event("user/message", 2, {
		content: [{ type: "text", text: "真实消息" }],
		source: { kind: "user", rpcId: "rpc-1" },
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "user");
	assert.equal(p.messages[0].text, "真实消息");
});

test("user/message 工作区上下文注入（source.kind=agent-instructions）不投影", () => {
	// DSH 会把 AGENTS.md / runtime context / skills 清单作为 user/message 注入会话，
	// 投影器必须按 source.kind 过滤，否则时间线出现「发一条消息冒出多条用户消息」。
	const p = projectDshEvent(undefined, event("user/message", 3, {
		content: [{ type: "text", text: "<system-reminder>AGENTS.md 内容…" }],
		source: { kind: "agent-instructions", form: "instructions", baseline: true },
	}), AGENT);
	assert.equal(p.messages.length, 0);
	assert.equal(p.messagesChanged, false);
	assert.equal(p.stateChanged, false);
});

test("user/message 其他系统注入（source.kind=plugin）不投影", () => {
	const p = projectDshEvent(undefined, event("user/message", 4, {
		content: [{ type: "text", text: "插件注入" }],
		source: { kind: "plugin", plugin: "dsh-something" },
	}), AGENT);
	assert.equal(p.messages.length, 0);
	assert.equal(p.messagesChanged, false);
});

test("user/message 无 source 字段（旧会话迁移数据）保守投影", () => {
	// pre-react-loop steering/message 迁移出的 user/message 没有 source，
	// 不能因为字段缺失把真实用户消息丢掉。
	const p = projectDshEvent(undefined, event("user/message", 5, {
		content: [{ type: "text", text: "迁移消息" }],
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "user");
	assert.equal(p.messages[0].text, "迁移消息");
});

test("user/message 内联 base64 图片直接投影为 images", () => {
	const p = projectDshEvent(undefined, event("user/message", 6, {
		content: [
			{ type: "text", text: "看图" },
			{ type: "image", mediaType: "image/png", data: "aGVsbG8=" },
		],
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].images?.length, 1);
	assert.equal(p.messages[0].images?.[0].type, "image");
	assert.equal(p.messages[0].images?.[0].mimeType, "image/png");
	assert.equal(p.messages[0].images?.[0].data, "aGVsbG8=");
	assert.equal(p.messages[0].meta?.dshImageRefs, undefined);
});

test("user/message DSH canonical attachment ref 投影为 meta.dshImageRefs 等待回填", () => {
	const p = projectDshEvent(undefined, event("user/message", 7, {
		content: [
			{ type: "text", text: "看图" },
			{ type: "image", attachment: { attachmentId: "att-123", mediaType: "image/png", bytes: 5, width: 1, height: 1 } },
		],
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].images, undefined);
	assert.equal(p.messages[0].meta?.dshImageRefs?.length, 1);
	assert.equal(p.messages[0].meta?.dshImageRefs?.[0].attachmentId, "att-123");
	assert.equal(p.messages[0].meta?.dshImageRefs?.[0].mediaType, "image/png");
});

test("assistant/chunk text-delta 累积进 pending 并给出 deltaText 信号（首次增量创建流式骨架）", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "收到" },
	}), AGENT);
	assert.equal(p.pendingAssistantText, "收到");
	assert.equal(p.deltaText, "收到");
	assert.equal(p.isStreaming, true);
	assert.equal(p.stateChanged, true);
	// 首次增量创建空文本骨架消息（渲染层 interim-answer 挂载点），id = dsh:<delta seq>
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:3");
	assert.equal(p.messages[0].role, "assistant");
	assert.equal(p.messages[0].text, "");
	assert.equal(p.messages[0].stopReason, "pending");
	// 思考开始时间 = 首个增量时间（思考块耗时 endedAt - startedAt）
	assert.equal(p.messages[0].thinkingStartedAt, 1700000000003);
	assert.equal(p.messagesChanged, true);
	p = projectDshEvent(p, event("assistant/chunk", 4, {
		chunk: { type: "text-delta", index: 0, text: "。" },
	}), AGENT);
	assert.equal(p.pendingAssistantText, "收到。");
	assert.equal(p.messages.length, 1, "后续增量不再重复创建骨架");
	assert.equal(p.messagesChanged, false);
});

test("assistant/chunk reasoning-delta 累积思考并给 deltaReasoning 信号", () => {
	const p = projectDshEvent(undefined, event("assistant/chunk", 3, {
		chunk: { type: "reasoning-delta", index: 0, text: "思考中" },
	}), AGENT);
	assert.equal(p.pendingAssistantThinking, "思考中");
	assert.equal(p.deltaReasoning, "思考中");
	assert.equal(p.messages.length, 1, "reasoning 增量同样创建骨架");
	assert.equal(p.messages[0].id, "dsh:3");
});

test("assistant/message 以终态内容块为准更新流式骨架（同 id 不 remount）", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "旧" },
	}), AGENT);
	p = projectDshEvent(p, event("assistant/message", 5, {
		message: {
			content: [
				{ type: "reasoning", reasoning: "内部推理" },
				{ type: "text", text: "今天是星期五。" },
			],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "assistant");
	// 骨架 id（首个 delta 的 seq）保持不变：渲染层 Live→History 不 remount
	assert.equal(p.messages[0].id, "dsh:3");
	assert.equal(p.messages[0].text, "今天是星期五。");
	assert.equal(p.messages[0].thinking, "内部推理");
	assert.equal(p.messages[0].stopReason, "stop");
	// 思考耗时边界：startedAt 保留骨架创建时间（seq 3），endedAt = 终态事件时间（seq 5）
	assert.equal(p.messages[0].thinkingStartedAt, 1700000000003);
	assert.equal(p.messages[0].thinkingEndedAt, 1700000000005);
	assert.equal(p.pendingAssistantText, "");
	assert.equal(p.isStreaming, false);
});

test("assistant/message 无流式骨架时按终态正常 push（历史重放路径）", () => {
	const p = projectDshEvent(undefined, event("assistant/message", 5, {
		message: {
			content: [
				{ type: "reasoning", reasoning: "内部推理" },
				{ type: "text", text: "完整回答" },
			],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:5");
	assert.equal(p.messages[0].text, "完整回答");
	assert.equal(p.messages[0].thinking, "内部推理");
});

test("assistant/message 只有 tool-call 块（无正文无思考）不落空气泡", () => {
	// 模型直接发起工具调用时，assistant/message 的 content 只含 tool-call 块：
	// 落一条空文本 assistant 消息会让时间线出现空白气泡，终态由 tool/call 卡片承接。
	const p = projectDshEvent(undefined, event("assistant/message", 5, {
		message: {
			content: [
				{ type: "tool-call", id: "call-1", name: "pwsh", arguments: { command: "Get-Location" } },
			],
		},
	}), AGENT);
	assert.equal(p.messages.length, 0, "纯工具调用不产生 assistant 消息");
	assert.equal(p.pendingAssistantText, "");
	assert.equal(p.pendingAssistantThinking, "");
	assert.equal(p.isStreaming, false);
	assert.equal(p.stateChanged, true);
});

test("assistant/message 工具调用但有流式思考：更新骨架保留 thinking（不丢已渲染内容）", () => {
	// 模型思考后发起工具调用：reasoning-delta 已流式渲染（骨架存在），
	// 终态 content 只含 tool-call 块——必须更新骨架而不是丢弃，
	// 否则时间线上已显示的 Live 思考在终态被清掉。
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "reasoning-delta", index: 0, text: "我先查一下" },
	}), AGENT);
	p = projectDshEvent(p, event("assistant/message", 5, {
		message: {
			content: [
				{ type: "tool-call", id: "call-1", name: "pwsh", arguments: { command: "Get-Location" } },
			],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1, "有流式思考的工具回合保留骨架");
	assert.equal(p.messages[0].id, "dsh:3");
	assert.equal(p.messages[0].text, "");
	// 终态 content 无 reasoning 块：用流式累积兜底（finalThinking = pendingAssistantThinking）
	assert.equal(p.messages[0].thinking, "我先查一下");
	assert.equal(p.pendingAssistantThinking, "");
});

test("text-chunks 打包行：正文增量累积 + 骨架（id 取 seq0）", () => {
	// DSH 持久化把长 run 的 text-delta 打包成 text-chunks 行（{type, seq0, time0, data:{texts}}），
	// mux 与 history 都可能出现——投影器必须消费，否则中间回答不渲染。
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, { type: "text-chunks", seq0: 10, time0: 1700000000010, data: {
		turn: 1, step: 1, index: 0, dt: [0, 1], texts: ["发现", "关键", "线索"],
	} }, AGENT);
	assert.equal(p.pendingAssistantText, "发现关键线索");
	assert.equal(p.deltaText, "发现关键线索");
	assert.equal(p.isStreaming, true);
	assert.equal(p.stateChanged, true);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:10", "骨架 id 取打包行 seq0");
	p = projectDshEvent(p, { type: "text-chunks", seq0: 13, time0: 1700000000013, data: {
		turn: 1, step: 1, index: 0, dt: [], texts: ["了。"],
	} }, AGENT);
	assert.equal(p.pendingAssistantText, "发现关键线索了。");
	assert.equal(p.messages.length, 1, "后续打包行不重复创建骨架");
});

test("reasoning-chunks 打包行：思考增量累积（不重复打包行）", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, { type: "reasoning-chunks", seq0: 20, time0: 1700000000020, data: {
		turn: 1, step: 1, index: 0, dt: [1], texts: ["Let me", " think"],
	} }, AGENT);
	assert.equal(p.pendingAssistantThinking, "Let me think");
	assert.equal(p.deltaReasoning, "Let me think");
	assert.equal(p.messages[0].id, "dsh:20");
	// 终态更新骨架：thinking 以终态 content 为准，缺失时用流式累积兜底
	p = projectDshEvent(p, event("assistant/message", 25, {
		message: { content: [{ type: "text", text: "最终回答" }] },
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:20");
	assert.equal(p.messages[0].text, "最终回答");
	assert.equal(p.messages[0].thinking, "Let me think");
});

test("text-chunks 非字符串成员被过滤（防御脏数据）", () => {
	const p = projectDshEvent(undefined, { type: "text-chunks", seq0: 30, time0: 0, data: {
		turn: 1, step: 1, index: 0, dt: [], texts: ["好", 42, null],
	} }, AGENT);
	assert.equal(p.pendingAssistantText, "好");
	assert.equal(p.deltaText, "好");
});

test("turn/start 清掉上一轮 executingTool，避免状态条粘在工具调用中", () => {
	let p = projectDshEvent(undefined, event("tool/call", 6, {
		toolName: "pwsh",
		callId: "call-1",
	}), AGENT);
	assert.equal(p.executingTool, "pwsh");
	p = projectDshEvent(p, event("turn/start", 8), AGENT);
	assert.equal(p.executingTool, undefined);
	assert.equal(p.isStreaming, true);
});

test("tool/call 与 tool/result 投影工具消息（结果拼到工具行）", () => {
	let p = projectDshEvent(undefined, event("tool/call", 6, {
		toolName: "pwsh",
		callId: "call-1",
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "tool");
	assert.equal(p.messages[0].text, "pwsh");
	assert.equal(p.executingTool, "pwsh");
	// status=running 驱动工具卡片旋转动画（getToolStatus 读取 meta.status）
	assert.equal(p.messages[0].meta?.status, "running");

	p = projectDshEvent(p, event("tool/result", 7, {
		message: {
			content: [{ type: "text", text: "C:\\work" }],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.match(p.messages[0].text, /pwsh: C:/);
	// 结果到达：摘掉 running，卡片动画停止（无 running 即 done）
	assert.equal(p.messages[0].meta?.status, "done");
	// 工具耗时 = result 时间 - call 时间（渲染层工具卡片 formatDuration）
	assert.equal(p.messages[0].meta?.durationMs, 1);
	assert.equal(p.executingTool, undefined);
	// 与 PI 同一套 detailText，时间线展开区不再 JSON.stringify 整份 meta
	assert.match(p.messages[0].meta?.detailText ?? "", /工具：pwsh/);
	assert.match(p.messages[0].meta?.detailText ?? "", /状态：完成/);
	assert.match(p.messages[0].meta?.detailText ?? "", /结果：/);
	assert.match(p.messages[0].meta?.detailText ?? "", /C:\\work/);
});

test("并行工具结果按 callId 精确收口（乱序到达不串卡）", () => {
	let p = projectDshEvent(undefined, event("tool/call", 10, {
		toolName: "read",
		callId: "a",
		arguments: "{}",
	}), AGENT);
	p = projectDshEvent(p, event("tool/call", 11, {
		toolName: "read",
		callId: "b",
		arguments: "{}",
	}), AGENT);
	p = projectDshEvent(p, event("tool/call", 12, {
		toolName: "read",
		callId: "c",
		arguments: "{}",
	}), AGENT);
	assert.equal(p.messages.length, 3);
	assert.equal(p.activeToolCalls.size, 3);
	assert.equal(p.executingTool, "read");

	// 先回 c：只能把 c 卡置 done，a/b 仍 running，且不会把结果挂到错误的卡上
	p = projectDshEvent(p, event("tool/result", 13, {
		message: {
			source: { kind: "tool", callId: "c" },
			content: [{ type: "text", text: "C result" }],
		},
	}), AGENT);
	assert.equal(p.messages[0].meta?.status, "running");
	assert.equal(p.messages[1].meta?.status, "running");
	assert.equal(p.messages[2].meta?.status, "done");
	assert.match(p.messages[2].text, /read: C result/);
	assert.equal(p.activeToolCalls.size, 2);

	// 回 a：只有 a 卡收口
	p = projectDshEvent(p, event("tool/result", 14, {
		message: {
			source: { kind: "tool", callId: "a" },
			content: [{ type: "text", text: "A result" }],
		},
	}), AGENT);
	assert.equal(p.messages[0].meta?.status, "done");
	assert.match(p.messages[0].text, /read: A result/);
	assert.equal(p.messages[1].meta?.status, "running");
	assert.equal(p.activeToolCalls.size, 1);

	// 回 b：全部 done，活跃集合清空，状态条不再显示工具执行中
	p = projectDshEvent(p, event("tool/result", 15, {
		message: {
			source: { kind: "tool", callId: "b" },
			content: [{ type: "text", text: "B result" }],
		},
	}), AGENT);
	assert.equal(p.messages.every((m) => m.meta?.status === "done"), true);
	assert.equal(p.activeToolCalls.size, 0);
	assert.equal(p.executingTool, undefined);
});

test("turn/start 清空并行工具集合（上一轮残留不污染新回合）", () => {
	let p = projectDshEvent(undefined, event("tool/call", 10, {
		toolName: "read",
		callId: "a",
		arguments: "{}",
	}), AGENT);
	p = projectDshEvent(p, event("tool/call", 11, {
		toolName: "read",
		callId: "b",
		arguments: "{}",
	}), AGENT);
	assert.equal(p.activeToolCalls.size, 2);
	p = projectDshEvent(p, event("turn/start", 12), AGENT);
	assert.equal(p.activeToolCalls.size, 0);
	assert.equal(p.executingTool, undefined);
});

test("turn/end 兜底清掉未收到 result 的 running 工具卡", () => {
	let p = projectDshEvent(undefined, event("tool/call", 10, {
		toolName: "read",
		callId: "a",
		arguments: "{}",
	}), AGENT);
	assert.equal(p.messages[0].meta?.status, "running");
	p = projectDshEvent(p, event("turn/end", 11, { reason: { kind: "completed" } }), AGENT);
	assert.equal(p.messages[0].meta?.status, "done");
	assert.equal(p.activeToolCalls.size, 0);
	assert.equal(p.executingTool, undefined);
});


test("tool/result 带参数时 detailText 含参数段（PI 同款分节）", () => {
	let p = projectDshEvent(undefined, event("tool/call", 6, {
		toolName: "read",
		callId: "call-1",
		arguments: JSON.stringify({ file_path: "F:/PiDeck/src/a.ts", offset: 1, limit: 50 }),
	}), AGENT);
	p = projectDshEvent(p, event("tool/result", 7, {
		message: {
			source: { kind: "tool", callId: "call-1" },
			content: [{ type: "text", text: "export function foo() {}" }],
		},
	}), AGENT);
	const detail = p.messages[0].meta?.detailText ?? "";
	assert.match(detail, /工具：read/);
	assert.match(detail, /参数：/);
	assert.match(detail, /"file_path": "F:\/PiDeck\/src\/a\.ts"/);
	assert.match(detail, /结果：/);
	assert.match(detail, /export function foo\(\) \{\}/);
	assert.equal(p.messages[0].meta?.truncated, undefined);
});

test("tool/call 的 arguments（JSON 字符串）解析进 meta.args，host view 透传进 meta.view", () => {
	// DSH 的 tool/call.arguments 是 JSON 字符串（host 侧 presentCall 也 JSON.parse 后消费）；
	// PiDeck 工具卡片的副标题（command/path/pattern/query/url）、详情与 diff 都读 meta.args。
	let p = projectDshEvent(undefined, event("tool/call", 6, {
		toolName: "pwsh",
		callId: "call-1",
		arguments: JSON.stringify({
			command: "Get-Location",
			description: "查看当前目录",
			workdir: "C:\\work",
		}),
	}), AGENT, { for: "call", view: { card: "terminal", title: "Get-Location", description: "查看当前目录" } });
	assert.equal(p.messages.length, 1);
	// loadTsCommonJs 在独立 realm 执行 TS：JSON.parse 产物的原型属于该 realm，
	// deepStrictEqual 跨 realm 恒失败，逐字段断言（行为等价）。
	const args = p.messages[0].meta?.args;
	assert.equal(args?.command, "Get-Location");
	assert.equal(args?.description, "查看当前目录");
	assert.equal(args?.workdir, "C:\\work");
	assert.equal(p.messages[0].meta?.view?.for, "call");
	assert.equal(p.messages[0].meta?.view?.view?.card, "terminal");
});

test("tool/call 的 arguments 非法 JSON 时保留原始字符串（渲染层 parseToolArgs 双兼容）", () => {
	const p = projectDshEvent(undefined, event("tool/call", 6, {
		toolName: "pwsh",
		callId: "call-1",
		arguments: "{not-json",
	}), AGENT);
	assert.equal(p.messages[0].meta?.args, "{not-json");
});

test("turn/end 正常结束：清 pending、置 turnEnded、无错误消息（骨架保留为已流式内容）", () => {
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "答" },
	}), AGENT);
	p = projectDshEvent(p, event("turn/end", 8, { reason: { kind: "completed" } }), AGENT);
	assert.equal(p.turnEnded, true);
	assert.equal(p.isStreaming, false);
	assert.equal(p.pendingAssistantText, "");
	// 骨架是已入列的 assistant 消息：无 assistant/message 终态时保留已流式内容
	// （渲染层按 stopReason=pending 回退判为最终回答，中断回答不丢失）
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].text, "答");
});

test("turn/end 错误结束：追加 error 消息（如 MISSING_CREDENTIAL）", () => {
	const p = projectDshEvent(undefined, event("turn/end", 8, {
		reason: { kind: "error", error: { message: "no API key" } },
	}), AGENT);
	assert.equal(p.turnEnded, true);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].role, "error");
	assert.equal(p.messages[0].text, "no API key");
});

test("request/context 记录模型路由", () => {
	const p = projectDshEvent(undefined, event("request/context", 9, {
		provider: "opencode-go",
		model: "deepseek-v4-flash",
	}), AGENT);
	assert.equal(p.model?.provider, "opencode-go");
	assert.equal(p.model?.model, "deepseek-v4-flash");
	assert.equal(p.stateChanged, true);
});

test("request/context 携带 contextWindow 时记录路由容量（圆环窗口兜底源）", () => {
	const p = projectDshEvent(undefined, event("request/context", 11, {
		provider: "deepseek",
		model: "deepseek-chat",
		contextWindow: 64_000,
	}), AGENT);
	assert.equal(p.contextWindow, 64_000);
	assert.equal(p.stateChanged, true);
	// 同值重复：窗口保持（模型路由本身仍会置 stateChanged，窗口不重复记账）
	const again = projectDshEvent(p, event("request/context", 12, {
		provider: "deepseek",
		model: "deepseek-chat",
		contextWindow: 64_000,
	}), AGENT);
	assert.equal(again.contextWindow, 64_000);
	// 缺失 contextWindow 不覆盖已有值
	const missing = projectDshEvent(p, event("request/context", 13, {
		provider: "deepseek",
		model: "deepseek-chat",
	}), AGENT);
	assert.equal(missing.contextWindow, 64_000);
});

test("无关事件不产生任何信号", () => {
	const p = projectDshEvent(undefined, event("session/title", 10, { title: "t" }), AGENT);
	assert.equal(p.messagesChanged, false);
	assert.equal(p.stateChanged, false);
	assert.equal(p.turnEnded, false);
	assert.equal(p.deltaText, undefined);
});

test("permission/preset 事件折叠权限预设（last wins）", () => {
	// 会话创建时 host pin 默认预设（workspace-write）
	let p = projectDshEvent(undefined, event("permission/preset", 1, { preset: "workspace-write" }), AGENT);
	assert.equal(p.permissionPreset, "workspace-write");
	assert.equal(p.stateChanged, true);
	// /permission read-only 切换
	p = projectDshEvent(p, event("permission/preset", 2, { preset: "read-only" }), AGENT);
	assert.equal(p.permissionPreset, "read-only");
	assert.equal(p.stateChanged, true);
	// 同值重复事件不产生状态信号（渲染层避免无谓刷新）
	p = projectDshEvent(p, event("permission/preset", 3, { preset: "read-only" }), AGENT);
	assert.equal(p.stateChanged, false);
	// 空值/非字符串安全忽略
	p = projectDshEvent(p, event("permission/preset", 4, { preset: 42 }), AGENT);
	assert.equal(p.permissionPreset, "read-only");
	assert.equal(p.stateChanged, false);
});

test("plan/mode 事件折叠 plan 状态（last wins，缺省关闭）", () => {
	let p = projectDshEvent(undefined, event("user/message", 1, {
		content: [{ type: "text", text: "hi" }],
		source: { kind: "user", rpcId: "rpc-1" },
	}), AGENT);
	assert.equal(p.planModeActive, false, "无 plan/mode 事件时缺省关闭");
	// /plan 生效
	p = projectDshEvent(p, event("plan/mode", 2, { active: true }), AGENT);
	assert.equal(p.planModeActive, true);
	assert.equal(p.stateChanged, true);
	// /plan off
	p = projectDshEvent(p, event("plan/mode", 3, { active: false }), AGENT);
	assert.equal(p.planModeActive, false);
	// 同值重复不产生信号
	p = projectDshEvent(p, event("plan/mode", 4, { active: false }), AGENT);
	assert.equal(p.stateChanged, false);
});

test("permission/preset 与 plan/mode 不影响消息/回合信号", () => {
	let p = projectDshEvent(undefined, event("permission/preset", 1, { preset: "read-only" }), AGENT);
	p = projectDshEvent(p, event("plan/mode", 2, { active: true }), AGENT);
	assert.equal(p.messagesChanged, false);
	assert.equal(p.turnEnded, false);
	assert.equal(p.messages.length, 0);
});

test("assistant/message 携带 usage：投影进 projection.usage + 消息 meta.usage（无骨架 push 路径）", () => {
	// G16：adapter 报告 token 用量时 assistant/message 携带 usage；轨迹账本按消息展示。
	const p = projectDshEvent(undefined, event("assistant/message", 5, {
		message: {
			content: [{ type: "text", text: "完整回答" }],
			usage: { inputTokens: 120, outputTokens: 45, cacheReadTokens: 300, cacheWriteTokens: 12 },
		},
	}), AGENT);
	assert.equal(p.usage?.inputTokens, 120);
	assert.equal(p.usage?.outputTokens, 45);
	assert.equal(p.usage?.cacheReadTokens, 300);
	assert.equal(p.usage?.cacheWriteTokens, 12);
	assert.equal(p.messages[0].id, "dsh:5");
	assert.equal(p.messages[0].meta?.usage?.inputTokens, 120);
	assert.equal(p.messages[0].meta?.usage?.outputTokens, 45);
	assert.equal(p.messages[0].meta?.usage?.cacheReadTokens, 300);
	assert.equal(p.messages[0].meta?.usage?.cacheWriteTokens, 12);
});

test("assistant/message usage 更新流式骨架：保留已有 meta 并写入 usage", () => {
	// 骨架路径（reasoning/text delta 已渲染）更新原位消息：meta 合并而非覆盖
	// （骨架可能已带工具视图等 meta，usage 只是增量字段）。
	let p = projectDshEvent(undefined, event("turn/start", 2), AGENT);
	p = projectDshEvent(p, event("assistant/chunk", 3, {
		chunk: { type: "text-delta", index: 0, text: "旧" },
	}), AGENT);
	p = projectDshEvent(p, event("assistant/message", 5, {
		message: {
			content: [{ type: "text", text: "终态" }],
			usage: { inputTokens: 88, outputTokens: 7 },
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.equal(p.messages[0].id, "dsh:3", "骨架 id 保持（不 remount）");
	assert.equal(p.messages[0].meta?.usage?.inputTokens, 88);
	assert.equal(p.messages[0].meta?.usage?.outputTokens, 7);
	assert.equal(p.usage?.inputTokens, 88);
});

test("assistant/message usage 缺失/全零：不写 meta.usage、不覆盖已有 projection.usage", () => {
	// adapter 未报告 usage 时字段缺省：消息 meta 无 usage 键，projection.usage 保持旧值
	// （latest wins 语义：只有新值到达才更新，避免「无报告」把上一回合用量清掉）。
	let p = projectDshEvent(undefined, event("assistant/message", 5, {
		message: {
			content: [{ type: "text", text: "第一轮" }],
			usage: { inputTokens: 50, outputTokens: 10 },
		},
	}), AGENT);
	assert.equal(p.messages[0].meta?.usage?.inputTokens, 50);
	p = projectDshEvent(p, event("assistant/message", 9, {
		message: { content: [{ type: "text", text: "第二轮" }] },
	}), AGENT);
	assert.equal(p.messages[1].meta?.usage, undefined, "无 usage 的消息不写 meta.usage");
	assert.equal(p.usage?.inputTokens, 50, "无新报告不覆盖旧值");
	// 全零 usage 视为未报告
	p = projectDshEvent(p, event("assistant/message", 12, {
		message: {
			content: [{ type: "text", text: "第三轮" }],
			usage: { inputTokens: 0, outputTokens: 0 },
		},
	}), AGENT);
	assert.equal(p.messages[2].meta?.usage, undefined);
	assert.equal(p.usage?.inputTokens, 50);
});

test("request/header 折叠系统提示（EpochHeader.system，last wins）", () => {
	// DSH 系统提示由 harness 在请求时组装（persona + sections），request/header 事件
	// 携带完整文本（dsh-web 轨迹同源）；同一会话多次请求头取最后一次。
	let p = projectDshEvent(undefined, event("request/header", 3, {
		header: { system: "你是 PiDeck 的 DSH 代理。\n## 准则\n…" },
		reason: { kind: "steer", step: 1 },
	}), AGENT);
	assert.equal(p.systemPrompt, "你是 PiDeck 的 DSH 代理。\n## 准则\n…");
	assert.equal(p.stateChanged, true);
	p = projectDshEvent(p, event("request/header", 7, {
		header: { system: "更新后的系统提示" },
	}), AGENT);
	assert.equal(p.systemPrompt, "更新后的系统提示");
	// 同值重复不产生信号
	p = projectDshEvent(p, event("request/header", 8, {
		header: { system: "更新后的系统提示" },
	}), AGENT);
	assert.equal(p.stateChanged, false);
	// 无 system 字段 / 非对象 header：不覆盖已有值
	p = projectDshEvent(p, event("request/header", 9, { header: { system: 42 } }), AGENT);
	assert.equal(p.systemPrompt, "更新后的系统提示");
	p = projectDshEvent(p, event("request/header", 10, { header: "raw" }), AGENT);
	assert.equal(p.systemPrompt, "更新后的系统提示");
	// request/header 不产生消息信号
	assert.equal(p.messagesChanged, false);
	assert.equal(p.turnEnded, false);
});

test("todo/write 折叠为当前计划（整表 last-wins，不进消息时间线）", () => {
	let p = projectDshEvent(undefined, event("todo/write", 10, {
		todos: [
			{ content: "定位根因", status: "completed" },
			{ content: "补齐接线", status: "in_progress" },
			{ content: "验证恢复", status: "pending" },
		],
	}), AGENT);
	// vm 跨 realm 对象与测试字面量 prototype 不同，deepStrictEqual 需 JSON 往返归一
	assert.deepEqual(JSON.parse(JSON.stringify(p.todos)), [
		{ content: "定位根因", status: "completed" },
		{ content: "补齐接线", status: "in_progress" },
		{ content: "验证恢复", status: "pending" },
	]);
	assert.equal(p.stateChanged, true);
	assert.equal(p.messages.length, 0, "todo/write 不投影消息（避免与工具卡重复）");

	// 整表替换：第二次写入覆盖上一次（last-wins）
	p = projectDshEvent(p, event("todo/write", 12, {
		todos: [{ content: "只剩一项", status: "pending" }],
	}), AGENT);
	assert.deepEqual(JSON.parse(JSON.stringify(p.todos)), [{ content: "只剩一项", status: "pending" }]);

	// 同值重复写入不产生 stateChanged 信号（避免无谓 emitRuntimeState）
	p = projectDshEvent(p, event("todo/write", 13, {
		todos: [{ content: "只剩一项", status: "pending" }],
	}), AGENT);
	assert.equal(p.stateChanged, false);
});

test("todo/write 非法数据保持原值（whole-value：脏数据不清计划也不渲染半截）", () => {
	let p = projectDshEvent(undefined, event("todo/write", 10, {
		todos: [{ content: "有效项", status: "pending" }],
	}), AGENT);
	assert.deepEqual(JSON.parse(JSON.stringify(p.todos)), [{ content: "有效项", status: "pending" }]);
	// 空 content / 非法 status / 非对象项：整表判非法，保持旧计划
	for (const bad of [
		[{ content: "", status: "pending" }],
		[{ content: "好", status: "wat" }],
		["not-an-object"],
	]) {
		p = projectDshEvent(p, event("todo/write", 11, { todos: bad }), AGENT);
		assert.deepEqual(JSON.parse(JSON.stringify(p.todos)), [{ content: "有效项", status: "pending" }], "非法整表不得覆盖");
		assert.equal(p.stateChanged, false);
	}
	// 非数组值同样忽略
	p = projectDshEvent(p, event("todo/write", 12, { todos: { content: "x", status: "pending" } }), AGENT);
	assert.deepEqual(JSON.parse(JSON.stringify(p.todos)), [{ content: "有效项", status: "pending" }]);
});

test("turn/start 清空上一轮计划（standing plan：turn/end 保留，下一轮开始清）", () => {
	let p = projectDshEvent(undefined, event("todo/write", 5, {
		todos: [{ content: "写测试", status: "in_progress" }],
	}), AGENT);
	assert.deepEqual(JSON.parse(JSON.stringify(p.todos)), [{ content: "写测试", status: "in_progress" }]);
	// turn/end 保留刚完成的清单
	p = projectDshEvent(p, event("turn/end", 6, { reason: { kind: "stop" } }), AGENT);
	assert.deepEqual(JSON.parse(JSON.stringify(p.todos)), [{ content: "写测试", status: "in_progress" }]);
	// 下一轮 turn/start：计划清空（null = 显式清空，与官方 projection 单元一致）
	p = projectDshEvent(p, event("turn/start", 7), AGENT);
	assert.equal(p.todos, null);
	assert.equal(p.stateChanged, true);

	// 从未写入（undefined）的 turn/start 不引入「已清空」信号，保持能力未到达语义
	const fresh = projectDshEvent(undefined, event("turn/start", 1), AGENT);
	assert.equal(fresh.todos, undefined);
	assert.equal(fresh.stateChanged, true);
});


test("assistant/message 终态图片不会覆盖/丢失", () => {
let p = projectDshEvent(undefined, event("assistant/chunk", 1, {
chunk: { type: "text-delta", text: "回答" },
}), AGENT);
p = projectDshEvent(p, event("assistant/message", 2, {
message: {
content: [
{ type: "text", text: "回答" },
{ type: "image", attachment: { attachmentId: "att-assistant", mediaType: "image/png" } },
],
},
}), AGENT);
assert.equal(p.messages[0].images, undefined, "canonical ref 先保留在 meta，等待附件回填");
assert.equal(p.messages[0].meta.dshImageRefs[0].attachmentId, "att-assistant");

const direct = projectDshEvent(undefined, event("assistant/message", 3, {
message: { content: [{ type: "image", mediaType: "image/png", data: "aGVsbG8=" }] },
}), AGENT);
assert.equal(direct.messages[0].images[0].data, "aGVsbG8=");
});

// ── 0.1.5 形状回归：工具结果块 + 实时助手流 ──
// 背景：0.1.5 起工具结果消息体是 [{type:"tool-result", toolCallId, content, isError}]
// （见 dsh-llm createToolResultMessage），文本嵌在内层 content 里；只认 text 块的提取
// 会得到空串——工具卡因此「只有调用、没有结果」。

test("tool/result：0.1.5 tool-result 包装块仍能提取结果文本", () => {
	let p = projectDshEvent(undefined, event("tool/call", 21, { toolName: "fs_read", callId: "c-1", arguments: '{"path":"a.txt"}' }), AGENT);
	p = projectDshEvent(p, event("tool/result", 22, {
		message: {
			source: { kind: "tool", callId: "c-1" },
			content: [{
				type: "tool-result",
				toolCallId: "c-1",
				isError: false,
				content: [{ type: "text", text: "file contents here" }],
			}],
		},
	}), AGENT);
	assert.equal(p.messages.length, 1);
	assert.match(p.messages[0].meta?.detailText ?? "", /file contents here/);
	assert.equal(p.messages[0].meta?.status, "done");
});

test("tool/result：tool-result 的 content 为字符串时同样可提取", () => {
	let p = projectDshEvent(undefined, event("tool/call", 23, { toolName: "pwsh", callId: "c-2" }), AGENT);
	p = projectDshEvent(p, event("tool/result", 24, {
		message: {
			source: { kind: "tool", callId: "c-2" },
			content: [{ type: "tool-result", toolCallId: "c-2", content: "plain string result", isError: false }],
		},
	}), AGENT);
	assert.match(p.messages[0].meta?.detailText ?? "", /plain string result/);
});

test("assistant/live-chunk：实时思考/正文增量累积到骨架（liveId 稳定，多次 delta 同一消息）", () => {
	let p = projectDshEvent(undefined, event("assistant/live-chunk", 0, {
		liveId: "dsh:live:attempt-1",
		chunk: { type: "reasoning-delta", text: "先想" },
	}), AGENT);
	assert.equal(p.pendingAssistantId, "dsh:live:attempt-1");
	assert.equal(p.pendingAssistantThinking, "先想");
	assert.equal(p.deltaReasoning, "先想");
	assert.equal(p.isStreaming, true);

	p = projectDshEvent(p, event("assistant/live-chunk", 0, {
		liveId: "dsh:live:attempt-1",
		chunk: { type: "reasoning-delta", text: "一下" },
	}), AGENT);
	assert.equal(p.pendingAssistantThinking, "先想一下");

	p = projectDshEvent(p, event("assistant/live-chunk", 0, {
		liveId: "dsh:live:attempt-1",
		chunk: { type: "text-delta", text: "答案" },
	}), AGENT);
	assert.equal(p.pendingAssistantText, "答案");
	assert.equal(p.deltaText, "答案");
	// 骨架消息挂载后，终态 assistant/message 按 pendingAssistantId 原地更新（不 remount）。
	assert.equal(p.pendingAssistantId, "dsh:live:attempt-1");
});

test("assistant/live-chunk：非 delta 块（工具调用等）不产生骨架", () => {
	const p = projectDshEvent(undefined, event("assistant/live-chunk", 0, {
		liveId: "dsh:live:attempt-2",
		chunk: { type: "tool-call-delta", id: "x" },
	}), AGENT);
	assert.equal(p.pendingAssistantId, undefined);
	assert.equal(p.isStreaming, false);
});
