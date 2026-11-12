import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
/**
 * Web + ACP 流式链路（回归）：ACP 会话在 Web 端的两个现场症状
 *   1) 正文/工具卡不实时出现（只能靠状态轮询 + 磁盘重拉）；
 *   2) 整轮没有 finish 帧，前端一直显示运行中。
 * 成因：SSE 事件源原来只订 DSH（pi 事件流里没有 ACP），而 ACP 的流式数据既不是
 * pi RPC 事件也不是 DSH 的累积 text-stream，而是「投影快照」（agents:message 全量
 * 替换）+ 回合终态（agents:runtime-state）。
 *
 * 覆盖：快照 → pi 事件 的翻译语义（增量、切段、工具卡、基线、回合边界）、
 * 路由/连接收尾语义、首帧不丢正文、以及装配接线契约。
 */

const webServiceSource = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
const webEventStreamSource = readFileSync("src/main/web/WebEventStream.ts", "utf8");

const indexSource = mainIpcSource;
const { AcpChannelToPiEvents } = loadTsCommonJs("src/main/web/AcpChannelToPiEvents.ts");
const { WebEventStreamRouter, PiEventToUiMessageStream } = loadTsCommonJs("src/main/web/WebEventStream.ts");

const MESSAGE = "agents:message";
const RUNTIME_STATE = "agents:runtime-state";
const AGENT = "acp:session-1";

/** vm 沙箱里生产模块返回的数组/对象自带外域原型，比较前先归一成宿主字面量。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

/** 走完整链路：ACP 通道载荷 → pi 事件 → UIMessageStream 帧（与生产同一条路由）。 */
function collectFrames(batches) {
	const translator = new AcpChannelToPiEvents();
	const adapter = new PiEventToUiMessageStream();
	const frames = [];
	for (const [channel, payload] of batches) {
		for (const event of translator.push(channel, payload)) {
			frames.push(...adapter.push(event));
		}
	}
	return frames;
}

/** 投影快照载荷（与 AcpUpdatePipeline.flushMessages 同形）。 */
function snapshot(messages) {
	return { agentId: AGENT, deckSessionId: "session-1", messages, totalLength: messages.length };
}

function user(id, text) {
	return { id, agentId: AGENT, role: "user", text, timestamp: 1 };
}

function assistant(id, text, extra = {}) {
	return { id, agentId: AGENT, role: "assistant", text, timestamp: 2, stopReason: "pending", ...extra };
}

function toolCard(callId, status, extra = {}) {
	return {
		id: `tool-${callId}`,
		agentId: AGENT,
		role: "tool",
		text: "bash",
		timestamp: 3,
		meta: { toolCallId: callId, toolName: "bash", status, args: { command: "ls" }, ...extra },
	};
}

function textDeltas(frames) {
	return frames.filter((frame) => frame.type === "text-delta").map((frame) => frame.delta);
}

test("ACP 投影快照按增量发出正文：重复快照不重发，首帧补 start", () => {
	const translator = new AcpChannelToPiEvents();
	// 首帧快照即基线：没有进行中内容 → 不产帧（历史由历史接口覆盖）
	assert.deepEqual(plain(translator.push(MESSAGE, snapshot([user("u1", "你好")]))), []);

	const first = translator.push(MESSAGE, snapshot([user("u1", "你好"), assistant("a1", "你")]));
	assert.deepEqual(plain(first.map((event) => event.type)), ["message_start", "message_update"], "首帧正文必须先补 message_start，否则 AI SDK 没有可落的 UI 消息");
	assert.equal(first[1].assistantMessageEvent.type, "text_delta");
	assert.equal(first[1].assistantMessageEvent.delta, "你");

	// 全量快照：只发新增部分
	const second = translator.push(MESSAGE, snapshot([user("u1", "你好"), assistant("a1", "你好")]));
	assert.deepEqual(plain(second.map((event) => event.assistantMessageEvent?.delta)), ["好"]);

	// 同一份快照被重复推（80ms 节流的重复 flush、plan/usage 触发的补发）：不能重复成帧
	assert.equal(translator.push(MESSAGE, snapshot([user("u1", "你好"), assistant("a1", "你好")])).length, 0);
});

test("ACP 首帧快照里进行中的段不丢正文（首帧即基线不能吞掉已产出的字）", () => {
	const translator = new AcpChannelToPiEvents();
	// 连接建立后才收到第一张快照，此时 CLI 已经吐出「你」这一段
	const frames = collectFrames([[MESSAGE, snapshot([user("u1", "你好"), assistant("a1", "你")])]]);
	assert.deepEqual(textDeltas(frames), ["你"], "进行中的段属于还没上屏的本轮内容，必须补发");
});

test("ACP 回合边界只认 runtime-state：过渡快照（无 pending、无 running 工具）不收口", () => {
	// 工具已完成、下一段正文还没来：这一刻"无 pending + 无 running"，但回合没结束
	const frames = collectFrames([
		[MESSAGE, snapshot([user("u1", "跑个命令")])],
		[RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true, isTurnActive: true } }],
		[MESSAGE, snapshot([user("u1", "跑个命令"), assistant("a1", "我先看看", { stopReason: "toolUse" })])],
		[MESSAGE, snapshot([user("u1", "跑个命令"), assistant("a1", "我先看看", { stopReason: "toolUse" }), toolCard("call_1", "running")])],
		[MESSAGE, snapshot([user("u1", "跑个命令"), assistant("a1", "我先看看", { stopReason: "toolUse" }), toolCard("call_1", "completed", { fullText: "file.txt" })])],
	]);
	assert.equal(
		frames.some((frame) => frame.type === "finish"),
		false,
		"工具循环中间态不能结束 Web 流（否则工具卡之后的正文全部丢失）",
	);

	// 权威收口：isStreaming 翻 false
	const settled = collectFrames([
		[RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } }],
		[MESSAGE, snapshot([user("u1", "跑个命令"), assistant("a1", "我先看看", { stopReason: "toolUse" })])],
		[RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: false } }],
	]);
	assert.equal(settled.at(-1).type, "finish", "回合结束必须给 finish，否则前端一直显示运行中");
});

test("ACP 发送即进运行态：runtime-state 翻 true 立刻出 start 帧", () => {
	const frames = collectFrames([[RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } }]]);
	assert.deepEqual(plain(frames.map((frame) => frame.type)), ["start"], "空白回合也要先开一条可收口的 UI 消息");
});

test("ACP 工具卡：running→completed 走 input/output 两端，重复推送不重开", () => {
	const translator = new AcpChannelToPiEvents();
	translator.push(MESSAGE, snapshot([user("u1", "跑个命令")]));

	const started = translator.push(MESSAGE, snapshot([user("u1", "跑个命令"), toolCard("call_1", "running")]));
	assert.deepEqual(plain(started.map((event) => event.type)), ["message_start", "tool_execution_start"]);
	assert.equal(started[1].toolCallId, "call_1");
	assert.deepEqual(plain(started[1].args), { command: "ls" });

	// 同一张卡还在跑：不能重复 start（时间线会出现两张一样的卡）
	assert.equal(translator.push(MESSAGE, snapshot([user("u1", "跑个命令"), toolCard("call_1", "running")])).length, 0);

	const ended = translator.push(MESSAGE, snapshot([user("u1", "跑个命令"), toolCard("call_1", "completed", { fullText: "file.txt" })]));
	assert.deepEqual(plain(ended.map((event) => event.type)), ["tool_execution_end"]);
	assert.equal(ended[0].result.text, "file.txt");
	assert.equal(ended[0].isError, false);

	// 生命周期完结：后续快照不再重发
	assert.equal(translator.push(MESSAGE, snapshot([user("u1", "跑个命令"), toolCard("call_1", "completed", { fullText: "file.txt" })])).length, 0);
});

test("ACP 工具失败标记为 error（isError / meta.isError 双来源）", () => {
	const translator = new AcpChannelToPiEvents();
	translator.push(MESSAGE, snapshot([user("u1", "跑")]));
	const ended = translator.push(MESSAGE, snapshot([user("u1", "跑"), toolCard("call_9", "error", { detailText: "boom" })]));
	const end = ended.find((event) => event.type === "tool_execution_end");
	assert.equal(end.isError, true);
	assert.equal(end.result.text, "boom", "没有全文时退回 detailText");
	assert.equal(end.result.status, "error");
});

test("ACP 一回合多段正文：段间不串行追加，第二段起开新 step", () => {
	const frames = collectFrames([
		[MESSAGE, snapshot([user("u1", "做两件事")])],
		[RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } }],
		// 第一段（工具调用前的中间回复）
		[MESSAGE, snapshot([user("u1", "做两件事"), assistant("a1", "先看一下")])],
		// 切段：旧段收成 toolUse，新段 pending（#413 投影切段语义）
		[MESSAGE, snapshot([user("u1", "做两件事"), assistant("a1", "先看一下", { stopReason: "toolUse" }), toolCard("call_1", "running")])],
		[MESSAGE, snapshot([user("u1", "做两件事"), assistant("a1", "先看一下", { stopReason: "toolUse" }), toolCard("call_1", "completed", { fullText: "ok" }), assistant("a2", "结论是")])],
	]);
	assert.deepEqual(textDeltas(frames), ["先看一下", "结论是"]);
	assert.equal(frames.filter((frame) => frame.type === "start").length, 1, "一条 UI 消息装着整轮，不拆气泡");
	assert.ok(
		frames.some((frame) => frame.type === "start-step"),
		"切段要开新 step",
	);
	// 两段之间必须关块：否则 text-delta 会拼成「先看一下结论是」而中间没有分隔
	assert.equal(frames.filter((frame) => frame.type === "text-end").length, 1);
});

test("ACP 迟到 chunk 并回已收口段：重开块继续画，不丢内容", () => {
	const frames = collectFrames([
		[MESSAGE, snapshot([user("u1", "问")])],
		[RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } }],
		[MESSAGE, snapshot([user("u1", "问"), assistant("a1", "答", { stopReason: "toolUse" })])],
		// trailingAssistantIndex：同一段又长了一点（还没轮到新段）
		[MESSAGE, snapshot([user("u1", "问"), assistant("a1", "答案", { stopReason: "toolUse" })])],
	]);
	assert.deepEqual(textDeltas(frames), ["答", "案"]);
});

test("ACP 思考内容走 reasoning 增量，不混进正文", () => {
	const frames = collectFrames([
		[MESSAGE, snapshot([user("u1", "想一下")])],
		[RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } }],
		[MESSAGE, snapshot([user("u1", "想一下"), assistant("a1", "", { thinking: "沉思" })])],
		[MESSAGE, snapshot([user("u1", "想一下"), assistant("a1", "", { thinking: "沉思完毕" })])],
	]);
	assert.deepEqual(
		frames.filter((frame) => frame.type === "reasoning-delta").map((frame) => frame.delta),
		["沉思", "完毕"],
	);
	assert.deepEqual(textDeltas(frames), [], "思考不能落进正文块");
});

test("ACP 历史（上一个用户消息之前）与已结算内容不进增量", () => {
	const translator = new AcpChannelToPiEvents();
	// 上一轮已经结束，本次状态才创建：整段历史都已由历史接口覆盖
	const history = [user("u0", "上一轮"), assistant("a0", "上一轮的回答", { stopReason: "stop" }), toolCard("call_0", "completed", { fullText: "old" }), user("u1", "这一轮")];
	assert.deepEqual(plain(translator.push(MESSAGE, snapshot(history))), [], "历史不能当增量重画");

	// 本轮进行中的段照常发（基线不预置进行中的段）
	const next = translator.push(MESSAGE, snapshot([...history, assistant("a1", "新的")]));
	assert.deepEqual(plain(next.map((event) => event.type)), ["message_start", "message_update"]);
	// 上一条历史 assistant 段没被当成新段重发
	assert.equal(next[0].message.id, "a1");
});

test("ACP 无关通道/畸形载荷不抛异常、不产帧", () => {
	const translator = new AcpChannelToPiEvents();
	assert.deepEqual(plain(translator.push("agents:text-stream", { text: "x" })), []);
	assert.deepEqual(plain(translator.push(MESSAGE, null)), []);
	assert.deepEqual(plain(translator.push(MESSAGE, { messages: "nope" })), []);
	assert.deepEqual(plain(translator.push(RUNTIME_STATE, {})), []);
	// 畸形载荷不能把基线/游标搞坏：随后的合法快照照常翻译
	const after = translator.push(MESSAGE, snapshot([user("u1", "hi"), assistant("a1", "嘿")]));
	assert.deepEqual(plain(after.map((event) => event.type)), ["message_start", "message_update"]);
	assert.equal(after[1].assistantMessageEvent.delta, "嘿");
});

test("ACP keepAlive 连接：一轮结束换新适配器，下一轮照常上屏", () => {
	const received = [];
	const router = new WebEventStreamRouter(() => "session-1");
	router.add(
		"session-1",
		(wire) => {
			received.push(wire);
			return true;
		},
		() => {},
		undefined,
		{ keepAlive: true },
	);
	let handler = null;
	router.bindAcpChannelSource((next) => {
		handler = next;
		return () => {};
	});

	// 第一轮
	handler(AGENT, RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } });
	handler(AGENT, MESSAGE, snapshot([user("u1", "第一问"), assistant("a1", "第一答")]));
	handler(AGENT, MESSAGE, snapshot([user("u1", "第一问"), assistant("a1", "第一答", { stopReason: "stop" })]));
	handler(AGENT, RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: false } });
	assert.match(received.join(""), /"finish"/);
	assert.equal(received.at(-1), "data: [DONE]\n\n", "keepAlive 连接每轮收一次 [DONE] 但不关闭");

	// 第二轮（同一连接，换新适配器）
	received.length = 0;
	handler(AGENT, RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } });
	handler(AGENT, MESSAGE, snapshot([user("u1", "第一问"), assistant("a1", "第一答", { stopReason: "stop" }), user("u2", "第二问"), assistant("a2", "第二答")]));
	const second = received.join("");
	assert.match(second, /"type":"start"/, "新一轮要重新发 start（客户端在新 start 上重置合并器）");
	assert.match(second, /第二答/);
	assert.doesNotMatch(second, /第一答/, "上一轮正文不能随快照重发");
	router.unbindAcpChannelSource();
});

test("ACP 无订阅者时也累积回放源：手机中途接入能看到本轮前半段", () => {
	let handler = null;
	const late = [];
	const router = new WebEventStreamRouter(() => "session-1");
	router.bindAcpChannelSource((next) => {
		handler = next;
		return () => {};
	});
	// 手机还没连上时，桌面端这一轮已经在跑
	handler(AGENT, RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } });
	handler(AGENT, MESSAGE, snapshot([user("u1", "长任务"), assistant("a1", "先看目录")]));

	router.add(
		"session-1",
		(wire) => {
			late.push(wire);
			return true;
		},
		() => {},
		undefined,
		{ keepAlive: true },
	);
	const replayed = late.join("");
	assert.match(replayed, /"type":"start"/);
	assert.match(replayed, /先看目录/, "中途接入要整段回放本轮已产出的正文");

	// 回放后继续吃实时增量（新段照常开 step）
	handler(AGENT, MESSAGE, snapshot([user("u1", "长任务"), assistant("a1", "先看目录"), toolCard("call_1", "running")]));
	assert.match(late.join(""), /"type":"tool-input-available"/);
	router.unbindAcpChannelSource();
});

test("ACP 通道事件按 agentId 路由：别的会话与没有连接的会话不串台、不报错", () => {
	let handler;
	const router = new WebEventStreamRouter((agentId) => (agentId === AGENT ? "session-1" : undefined));
	router.bindAcpChannelSource((next) => {
		handler = next;
		return () => {};
	});
	// 没有任何连接时不得抛异常
	handler(AGENT, RUNTIME_STATE, { agentId: AGENT, state: { isStreaming: true } });
	handler(AGENT, MESSAGE, snapshot([user("u1", "x")]));
	handler("acp:ghost", RUNTIME_STATE, { agentId: "acp:ghost", state: { isStreaming: true } });
	handler(AGENT, MESSAGE, null);

	const received = [];
	router.add(
		"session-1",
		(wire) => {
			received.push(wire);
			return true;
		},
		() => {},
	);
	handler("acp:ghost", MESSAGE, snapshot([user("u1", "leak"), assistant("a1", "leak")]));
	assert.equal(received.length, 0, "别的会话的通道事件不能串到本连接");
	handler(AGENT, MESSAGE, snapshot([user("u1", "x"), assistant("a1", "ok")]));
	assert.ok(received.length > 0);
	router.unbindAcpChannelSource();
});

test("ACP 事件源未注入时退化为纯 pi 行为（fail-safe，不抛不订阅）", () => {
	const received = [];
	const router = new WebEventStreamRouter(() => "session-1");
	router.add(
		"session-1",
		(wire) => {
			received.push(wire);
			return true;
		},
		() => {},
	);
	router.bindAcpChannelSource(undefined);
	router.bindPiSource((handler) => {
		handler("session-1", { type: "agent_settled" });
		return () => {};
	});
	assert.equal(received.at(-1), "data: [DONE]\n\n");
	router.unbindAcpChannelSource();
	router.unbindPiSource();
});

test("index.ts 把 ACP manager 接到 Web 的 ACP 事件源（不订 compositeAgentGateway）", () => {
	assert.match(indexSource, /subscribeAcpChannelEvents:/);
	const wiring = indexSource.slice(indexSource.indexOf("subscribeAcpChannelEvents:"));
	assert.match(wiring.slice(0, 600), /acpAgentManager\?\.onOutput\(/, "必须只订 ACP 网关，订 composite 会与 pi 事件源重复推帧");
	assert.doesNotMatch(wiring.slice(0, 600), /compositeAgentGateway/);
	// ACP 工具清单只下发 id/name（command/args/env 可能含凭据）
	const tools = indexSource.slice(indexSource.indexOf("listAcpTools:"));
	assert.match(tools.slice(0, 600), /acpEnabled !== true/);
	assert.match(tools.slice(0, 600), /\.enabled/);
	assert.doesNotMatch(tools.slice(0, 600), /command|args|env/, "工具的可执行参数不能下发到浏览器");
});

test("WebServiceManager 注册 ACP 事件源、停止时解绑、并把工具清单塞进 /api/state", () => {
	assert.match(webServiceSource, /subscribeAcpChannelEvents\?:/);
	assert.match(webServiceSource, /listAcpTools\?:/);
	assert.match(webServiceSource, /bindAcpChannelSource\(/);
	assert.match(webServiceSource, /unbindAcpChannelSource\(\)/);
	const bindIndex = webServiceSource.indexOf("this.eventStreamRouter.bindAcpChannelSource(");
	assert.ok(bindIndex > 0);
	// ACP 通道事件同样驱动状态推送：否则 busy→idle 只能等 5s 兜底 tick
	assert.match(webServiceSource.slice(bindIndex, bindIndex + 400), /scheduleStatePush\(\)/);
	assert.match(webServiceSource, /acpTools: this\.deps\.listAcpTools\?\.\(\) \?\? \[\]/);
});

test("WebEventStream 复用同一个适配器：ACP 翻译器只是事件来源，协议零分支", () => {
	assert.match(webEventStreamSource, /AcpChannelToPiEvents/);
	assert.match(webEventStreamSource, /acpChannels: new AcpChannelToPiEvents\(\)/);
	assert.match(webEventStreamSource, /state\.acpChannels\.push\(channel, payload\)/);
});

test("建会话链路把 acpToolId 透传到 catalog（Web 建 ACP 草稿不退化）", () => {
	// 主进程 wrapper：白名单 + ACP 不写模型/思考偏好（模型由 agent CLI 自持）
	const draft = indexSource.slice(indexSource.indexOf("createSessionDraft: async (input) => {"));
	assert.match(draft.slice(0, 1800), /input\.backend === "acp"/);
	assert.match(draft.slice(0, 1800), /acpToolId/);
	assert.match(draft.slice(0, 1800), /thinkingLevel: acp \? undefined : input\.thinkingLevel/);
	// ACP 草稿不预热 pi standby（与 dsh 同分支）
	assert.match(draft.slice(0, 2200), /draft\.backend !== "dsh" && draft\.backend !== "acp"/);
});
