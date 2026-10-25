import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Web + DSH 流式链路（回归）：DSH 会话在 Web 端的两个现场症状
 *   1) 「输出很慢」——SSE 里没有正文帧，只能靠状态轮询 + 磁盘重拉（≥5s 才见字）；
 *   2) 「察觉不到结束/停止」——整轮没有 finish 帧，useChat 永远停在 streaming。
 * 成因：Web 事件路由只订 pi 的 RPC 事件流，DSH 的流式数据走自己的通道
 * （agents:text-stream / agents:thinking / agents:message），没有翻译层。
 *
 * 覆盖：通道载荷 → pi 事件 的翻译语义、路由/连接收尾语义、装配接线契约。
 */

const webServiceSource = readFileSync("src/main/web/WebServiceManager.ts", "utf8");
const webEventStreamSource = readFileSync("src/main/web/WebEventStream.ts", "utf8");
const dshManagerSource = readFileSync("src/main/dsh/DshAgentManager.ts", "utf8");
const indexSource = readFileSync("src/main/index.ts", "utf8");

const { DshChannelToPiEvents } = loadTsCommonJs("src/main/web/DshChannelToPiEvents.ts");
const { WebEventStreamRouter, PiEventToUiMessageStream } = loadTsCommonJs("src/main/web/WebEventStream.ts");

const TEXT_STREAM = "agents:text-stream";
const THINKING = "agents:thinking";
const MESSAGE = "agents:message";

/** 走完整链路：DSH 通道载荷 → pi 事件 → UIMessageStream 帧（与生产同一条路由）。 */
function collectFrames(batches) {
	const translator = new DshChannelToPiEvents();
	const adapter = new PiEventToUiMessageStream();
	const frames = [];
	for (const [channel, payload] of batches) {
		for (const event of translator.push(channel, payload)) {
			frames.push(...adapter.push(event));
		}
	}
	return frames;
}

function textDeltas(frames) {
	return frames.filter((frame) => frame.type === "text-delta").map((frame) => frame.delta);
}

/** vm 沙箱里生产模块返回的数组/对象自带外域原型，比较前先归一成宿主字面量。 */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("DSH 累积正文按增量发出，重复快照不重发 delta", () => {
	const translator = new DshChannelToPiEvents();

	const first = translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "你", done: false });
	assert.deepEqual(plain(first.map((event) => event.type)), ["message_start", "message_update"], "首帧正文必须先补 message_start，否则 AI SDK 没有可落的 UI 消息");
	assert.equal(first[1].assistantMessageEvent.type, "text_delta");
	assert.equal(first[1].assistantMessageEvent.delta, "你");

	const second = translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "你好", done: false });
	assert.equal(second.length, 1);
	assert.equal(second[0].assistantMessageEvent.delta, "好", "累积文本只发新增部分");

	// DSH 会在工具循环/收口时重复推同一份累积文本：不能重复成帧
	assert.equal(translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "你好", done: false }).length, 0);
});

test("DSH turnEnded 才收口整轮：agent_settled → finish（察觉不到结束的回归）", () => {
	const frames = collectFrames([
		[TEXT_STREAM, { agentId: "dsh:s1", text: "答案", done: false }],
		// 单条 assistant 消息说完（工具循环还会再来）：不结束整轮
		[TEXT_STREAM, { agentId: "dsh:s1", text: "答案", done: true }],
	]);
	assert.equal(
		frames.some((frame) => frame.type === "finish"),
		false,
		"中间 done 帧不能结束 Web 流",
	);

	const end = collectFrames([
		[TEXT_STREAM, { agentId: "dsh:s1", text: "答案", done: false }],
		[TEXT_STREAM, { agentId: "dsh:s1", text: "答案", done: true, turnEnded: true }],
	]);
	assert.equal(
		end.some((frame) => frame.type === "finish"),
		true,
	);
	assert.equal(end.at(-1).type, "finish");
});

test("DSH turn/start 的 reset 帧清游标但不算收口", () => {
	const translator = new DshChannelToPiEvents();
	translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "上一轮", done: true, turnEnded: true });

	const reset = translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "", done: true, reset: true });
	assert.equal(
		reset.some((event) => event.type === "agent_settled"),
		false,
		"reset 只是新回合起点，不是整轮结束",
	);
	// 新一轮的正文从零开始累积：不能与上一轮游标拼串
	const next = translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "新回", done: false });
	assert.deepEqual(plain(next.filter((event) => event.type === "message_update").map((event) => event.assistantMessageEvent.delta)), ["新回"]);
});

test("DSH 思考累积文本走 reasoning 增量，空正文收口不重发", () => {
	const translator = new DshChannelToPiEvents();
	const first = translator.push(THINKING, { agentId: "dsh:s1", id: "t1", text: "想", done: false });
	assert.equal(first[0].type, "message_start");
	assert.equal(first[1].assistantMessageEvent.type, "thinking_delta");
	assert.equal(first[1].assistantMessageEvent.delta, "想");

	const second = translator.push(THINKING, { agentId: "dsh:s1", id: "t1", text: "想法", done: false });
	assert.equal(second.length, 1);
	assert.equal(second[0].assistantMessageEvent.delta, "法");

	// abort 路径把思考正文抹空后补 done：只关块，不把内容重发一遍
	const closed = translator.push(THINKING, { agentId: "dsh:s1", id: "t1", text: "", done: true });
	assert.deepEqual(plain(closed.map((event) => event.assistantMessageEvent.type)), ["thinking_end"]);
});

test("DSH 工具卡：新卡开 input，状态转终态补 output，重复推送不重开", () => {
	const translator = new DshChannelToPiEvents();
	const toolMessage = (status, extra = {}) => ({
		agentId: "dsh:s1",
		messages: [
			{
				role: "tool",
				text: "bash: ok",
				meta: { toolCallId: "call_1", toolName: "bash", status, args: { command: "ls" }, fullText: "ok", ...extra },
			},
		],
	});

	const running = translator.push(MESSAGE, toolMessage("running"));
	assert.deepEqual(plain(running.map((event) => event.type)), ["message_start", "tool_execution_start"]);
	assert.equal(running[1].toolCallId, "call_1");

	// 同一张卡还在跑：不重发 start（会把 AI SDK 已 settle 的 part 拍回 running）
	assert.equal(translator.push(MESSAGE, toolMessage("running")).length, 0);

	const done = translator.push(MESSAGE, toolMessage("completed"));
	assert.equal(done.length, 1);
	assert.equal(done[0].type, "tool_execution_end");
	assert.equal(done[0].isError, false);
	assert.equal(done[0].result.text, "ok");
	// 终态重复推送不再发第二份 output
	assert.equal(translator.push(MESSAGE, toolMessage("completed")).length, 0);
});

test("DSH 工具卡：连接建立时的历史工具卡不重播，只接在跑的那张", () => {
	const translator = new DshChannelToPiEvents();
	const frames = translator.push(MESSAGE, {
		agentId: "dsh:s1",
		messages: [
			{ role: "user", text: "旧提问" },
			{ role: "tool", text: "old", meta: { toolCallId: "call_old", toolName: "bash", status: "completed" } },
			{ role: "tool", text: "err", meta: { toolCallId: "call_old_err", toolName: "bash", status: "error" } },
			{ role: "tool", text: "run", meta: { toolCallId: "call_live", toolName: "read", status: "running" } },
		],
	});
	assert.deepEqual(plain(frames.map((event) => event.toolCallId ?? event.type)), ["message_start", "call_live"], "首帧历史工具卡由磁盘历史负责渲染，SSE 只续上正在执行的那张");
	assert.equal(translator.push(MESSAGE, { agentId: "dsh:s1", messages: [] }).length, 0);
});

test("DSH 工具卡：中途接入时本轮已完成的卡不丢（本轮已开始 + 在最后一条用户消息之后）", () => {
	const translator = new DshChannelToPiEvents();
	// 连接先见证本轮正文（turn/start 或流式 delta），再收到携带全量历史的 messages
	translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "正在查", done: false });
	const frames = translator.push(MESSAGE, {
		agentId: "dsh:s1",
		messages: [
			{ role: "tool", text: "old", meta: { toolCallId: "call_old", toolName: "bash", status: "completed" } },
			{ role: "user", text: "本轮提问" },
			{ role: "tool", text: "ok", meta: { toolCallId: "call_now", toolName: "bash", status: "completed" } },
		],
	});
	assert.deepEqual(plain(frames.map((event) => event.toolCallId ?? event.type)), ["call_now", "call_now"]);
	assert.equal(frames[0].type, "tool_execution_start");
	assert.equal(frames[1].type, "tool_execution_end");
});

test("DSH 工具失败结果带 isError，交给适配器成 tool-output-error", () => {
	const frames = collectFrames([
		// 首帧先建立本轮上下文（历史基线过滤只在首帧生效）
		[TEXT_STREAM, { agentId: "dsh:s1", text: "跑一下", done: false }],
		[MESSAGE, { agentId: "dsh:s1", messages: [{ role: "tool", text: "boom", meta: { toolCallId: "call_err", toolName: "bash", status: "error" } }] }],
	]);
	assert.equal(
		frames.some((frame) => frame.type === "tool-output-error"),
		true,
	);
});

test("工作流全程（正文+思考+工具+收口）产出可用的 finish 序列", () => {
	const frames = collectFrames([
		[TEXT_STREAM, { agentId: "dsh:s1", text: "", done: true, reset: true }],
		[THINKING, { agentId: "dsh:s1", id: "t1", text: "查一下", done: false }],
		[MESSAGE, { agentId: "dsh:s1", messages: [{ role: "tool", text: "ls", meta: { toolCallId: "c1", toolName: "bash", status: "completed", fullText: "a\nb" } }] }],
		[TEXT_STREAM, { agentId: "dsh:s1", text: "结果见上", done: false }],
		[TEXT_STREAM, { agentId: "dsh:s1", text: "结果见上", done: true, turnEnded: true }],
	]);
	assert.deepEqual(textDeltas(frames), ["结果见上"]);
	// 收口前必须先关掉开着的块（否则 AI SDK 端块永远处于 streaming）
	const types = frames.map((frame) => frame.type);
	assert.equal(types.at(-1), "finish");
	assert.ok(types.indexOf("text-end") < types.indexOf("finish"));
	assert.ok(types.indexOf("reasoning-end") < types.indexOf("finish"));
});

test("WebEventStreamRouter 把 DSH 通道事件写到连接上并以 [DONE] 收尾", () => {
	const received = [];
	let finished = 0;
	const router = new WebEventStreamRouter(() => "session-1");
	router.add(
		"session-1",
		(wire) => {
			received.push(wire);
			return true;
		},
		() => {},
		() => {
			finished += 1;
		},
	);
	router.bindChannelSource((handler) => {
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "hi", done: false });
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "hi", done: true, turnEnded: true });
		return () => {};
	});
	// 适配器在 message_start 上发 start，首个 text_delta 上发 text-start + text-delta
	assert.match(received[0], /data: \{"type":"start"/);
	assert.match(received.join(""), /"text-delta"/);
	assert.equal(received.at(-1), "data: [DONE]\n\n");
	assert.equal(finished, 1, "/api/chat 的非 keepAlive 连接必须在 [DONE] 后显式结束响应");
	router.unbindChannelSource();
});

test("keepAlive（外部流）在 finish 后保留连接，下一轮仍能收帧", () => {
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
	router.bindChannelSource((handler) => {
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "第一轮", done: true, turnEnded: true });
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "", done: true, reset: true });
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "第二轮", done: false });
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "第二轮", done: true, turnEnded: true });
		return () => {};
	});
	const wires = received.join("");
	assert.equal(wires.split("data: [DONE]").length - 1, 2, "两轮各收一次 [DONE]，连接不关闭");
	assert.match(wires, /"delta":"第二轮"/);
	router.unbindChannelSource();
});

test("DSH 无订阅者时也累积本轮：手机中途接入整段回放，工具卡不从头计", () => {
	let handler = null;
	const late = [];
	const router = new WebEventStreamRouter(() => "session-1");
	router.bindChannelSource((next) => {
		handler = next;
		return () => {};
	});
	const toolMessage = (status, extra = {}) => ({
		agentId: "dsh:session-1",
		messages: [{ role: "tool", text: "bash: ok", meta: { toolCallId: "call_1", toolName: "bash", status, args: { command: "ls" }, fullText: "ok", ...extra } }],
	});

	// 本轮在没有任何 Web 连接时就开始（桌面端在跑）：路由层仍要累积回放源
	handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "第一段", done: false });
	handler("dsh:session-1", MESSAGE, toolMessage("running"));

	// 手机中途点进来：先整段回放本轮已产出的正文与工具卡
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
	assert.match(replayed, /"delta":"第一段"/);
	assert.match(replayed, /"type":"tool-input-available"/);
	assert.equal(replayed.split('"toolCallId":"call_1"').length - 1, 2, "回放只补 input-start/input-available，不重复计次");

	// 回放后继续吃实时增量：在跑的工具能正常收口（适配器状态与已发帧对齐）
	handler("dsh:session-1", MESSAGE, toolMessage("completed"));
	handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "第一段", done: true, turnEnded: true });
	const wires = late.join("");
	assert.match(wires, /"type":"tool-output-available"/);
	assert.equal(late.at(-1), "data: [DONE]\n\n");
	router.unbindChannelSource();
});

test("DSH 通道事件按 agentId 路由：没有连接的会话不翻译、不报错", () => {
	let handler;
	const router = new WebEventStreamRouter((agentId) => (agentId === "dsh:session-1" ? "session-1" : undefined));
	router.bindChannelSource((next) => {
		handler = next;
		return () => {};
	});
	// 没有任何连接（sessionStreams 为空）时不得抛异常
	handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "x", done: false });
	handler("dsh:ghost", TEXT_STREAM, { agentId: "dsh:ghost", text: "x", done: false });
	handler("dsh:session-1", TEXT_STREAM, null);
	const received = [];
	router.add(
		"session-1",
		(wire) => {
			received.push(wire);
			return true;
		},
		() => {},
	);
	handler("dsh:ghost", TEXT_STREAM, { agentId: "dsh:ghost", text: "leak", done: false });
	assert.equal(received.length, 0, "别的会话的通道事件不能串到本连接");
	handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "ok", done: false });
	assert.equal(received.length, 3, "start + text-start + text-delta");
	router.unbindChannelSource();
});

test("通道事件源未注入时路由退化为纯 pi 行为（fail-safe）", () => {
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
	router.bindChannelSource(undefined);
	router.bindPiSource((handler) => {
		handler("session-1", { type: "agent_settled" });
		return () => {};
	});
	assert.equal(received.at(-1), "data: [DONE]\n\n");
	router.unbindPiSource();
	router.unbindChannelSource();
});

test("DSH 三处回合收口帧都带 turnEnded（正常/迟到 turn/end/abort）", () => {
	const marks = dshManagerSource.match(/turnEnded: true/g) ?? [];
	assert.ok(marks.length >= 4, `DSH 回合收口必须带 turnEnded 标记（含 host 崩溃恢复），实际 ${marks.length} 处`);
	const aborted = dshManagerSource.slice(dshManagerSource.indexOf("async abort(agentId: string)"));
	assert.match(aborted, /turnEnded: true/, "停止按钮必须让 Web 端收到 finish，否则一直显示运行中");
});

test("index.ts 只把 DSH 网关接到 Web 通道源，避免与 pi 事件源重复推帧", () => {
	assert.match(indexSource, /subscribeAgentChannelEvents:/);
	const wiring = indexSource.slice(indexSource.indexOf("subscribeAgentChannelEvents:"));
	assert.match(wiring, /dshAgentManager\.onOutput\(/);
	// 订 compositeAgentGateway 会把 pi 的 agents:text-stream 一并翻译，pi 会话会收到两份帧
	assert.doesNotMatch(wiring.slice(0, wiring.indexOf("listProjects:")), /compositeAgentGateway/);
});

test("WebServiceManager 注册通道事件源并在停止时解绑", () => {
	assert.match(webServiceSource, /bindChannelSource\(/);
	assert.match(webServiceSource, /unbindChannelSource\(\)/);
	assert.match(webServiceSource, /subscribeAgentChannelEvents\?:/);
	// DSH 通道事件同样驱动状态推送：否则 Web 端 busy→idle 只能等 5s 兜底 tick
	const bindIndex = webServiceSource.indexOf("this.eventStreamRouter.bindChannelSource(");
	assert.ok(bindIndex > 0);
	assert.match(webServiceSource.slice(bindIndex, bindIndex + 400), /scheduleStatePush\(\)/);
});

test("通道翻译层复用同一套 UIMessageStream 适配器（协议零分支）", () => {
	assert.match(webEventStreamSource, /DshChannelToPiEvents/);
	// 每条连接一份翻译器，收口基准按会话 seed（重连后仍能识别重复收口）
	assert.match(webEventStreamSource, /channels: new DshChannelToPiEvents\(this\.closedRunTextBySession\.get\(sessionId\) \?\? null\)/);
	assert.match(webEventStreamSource, /AI SDK UIMessageStream 单个 SSE 帧/);
});

test("停止后迟到的重复收口不再开新消息（keepAlive 连接不重复上屏）", () => {
	const translator = new DshChannelToPiEvents();
	const first = translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "被停下的回答", done: false });
	assert.equal(first.at(-1).assistantMessageEvent.type, "text_delta");
	// abort 收口：带已累积全文 + turnEnded
	const abort = translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "被停下的回答", done: true, turnEnded: true });
	assert.equal(
		abort.some((event) => event.type === "agent_settled"),
		true,
	);
	// host 迟到的 turn/end 再收一次：同一份全文不能当新一轮重发
	const late = translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "被停下的回答", done: true, turnEnded: true });
	assert.equal(late.length, 0, "重复收口会造出重复/空的助手气泡");
	// 用户接着发下一轮：reset 帧清掉基准，正文照常上屏
	translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "", done: true, reset: true });
	const next = translator.push(TEXT_STREAM, { agentId: "dsh:s1", text: "被停下的回答", done: false });
	assert.equal(next.filter((event) => event.type === "message_update").length, 1, "新一轮即使文本相同也要上屏");
});

test("停止后断开重连：会话级收口基准延续，迟到的重复收口不上屏（不造重复气泡）", () => {
	const first = [];
	const reconnect = [];
	const router = new WebEventStreamRouter(() => "session-1");
	const closeFirst = router.add(
		"session-1",
		(wire) => {
			first.push(wire);
			return true;
		},
		() => {},
		undefined,
		{ keepAlive: true },
	);
	router.bindChannelSource((handler) => {
		// 第一段连接：abort 收口（正文 + turnEnded）
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "半截回答", done: false });
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "半截回答", done: true, turnEnded: true });
		return () => {};
	});
	assert.match(first.join(""), /"finish"/);

	// Web 端 stop 后外部流断开重连：新连接 = 新翻译器实例
	closeFirst();
	router.add(
		"session-1",
		(wire) => {
			reconnect.push(wire);
			return true;
		},
		() => {},
		undefined,
		{ keepAlive: true },
	);
	router.bindChannelSource((handler) => {
		// host 迟到的 turn/end 再收一次同一份全文：新连接不能把它当新一轮上屏
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "半截回答", done: true, turnEnded: true });
		// 用户接着发下一轮：reset 帧清掉基准，正文照常流
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "", done: true, reset: true });
		handler("dsh:session-1", TEXT_STREAM, { agentId: "dsh:session-1", text: "新回答", done: false });
		return () => {};
	});
	assert.doesNotMatch(reconnect.join(""), /半截回答/, "重连后重复收口不得再上屏");
	assert.match(reconnect.join(""), /新回答/);
	router.unbindChannelSource();
});
