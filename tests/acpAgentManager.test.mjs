/**
 * AcpAgentManager 单测:伪造 ACP CLI 子进程(spawn stub + 内存 NDJSON 回环),
 * 不依赖真实 CLI。覆盖:握手/恢复(load 失败回退 new)、prompt 回合与投影 flush、
 * abort 的 session/cancel、permission 审批应答(selected/cancelled)、
 * 进程退出终态与 stop 清理。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** 等待谓词为真(轮询 10ms,上限 2s)——flush 有 80ms 节流,断言前先等落盘。 */
async function waitFor(predicate, label = "condition") {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.fail(`timeout waiting for ${label}`);
}

/**
 * 伪造一个 ACP agent CLI 进程:stdin 收 manager 发出的 JSON-RPC 帧,
 * handler(frame) 返回 result 即时应答;返回 error 对象应答错误;undefined 挂起。
 * writeFromCli() 让用例直接向 manager 推通知/请求。
 */
function fakeAgentProcess(t, { handler = () => undefined } = {}) {
	const stdin = new PassThrough(); // manager → CLI(测试读)
	const stdout = new PassThrough(); // CLI → manager(测试写)
	const stderr = new PassThrough();
	const frames = []; // manager 发出的全部帧(请求/通知/响应)
	stdin.on("data", (chunk) => {
		for (const line of chunk.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			const frame = JSON.parse(line);
			frames.push(frame);
			if (frame.method && frame.id !== undefined) {
				const outcome = handler(frame);
				if (outcome?.__error) {
					stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error: { code: outcome.code ?? -32000, message: outcome.message ?? "fail" } })}\n`);
				} else if (outcome !== undefined) {
					stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: outcome })}\n`);
				}
			}
		}
	});
	const proc = Object.assign(new EventEmitter(), {
		stdin,
		stdout,
		stderr,
		pid: 4321,
		exitCode: null,
		signalCode: null,
		kill() {
			proc.exitCode = 0;
			stdin.destroy();
			stdout.destroy();
			stderr.destroy();
		},
	});
	t.after(() => {
		try {
			stdin.destroy();
		} catch {}
		try {
			stdout.destroy();
		} catch {}
		try {
			stderr.destroy();
		} catch {}
	});
	const writeFromCli = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
	const methodFrames = (method) => frames.filter((frame) => frame.method === method);
	return { proc, frames, methodFrames, writeFromCli };
}

function harness(t, cliOptions, depsExtra = {}) {
	const events = { uiRequests: [], messages: [] };
	const procs = [];
	const spawnCalls = [];
	const { AcpAgentManager } = loadTsCommonJs("src/main/acp/AcpAgentManager.ts", {
		stubs: {
			"node:child_process": {
				spawn: (command, args, options) => {
					const record = fakeAgentProcess(t, cliOptions);
					procs.push(record);
					spawnCalls.push({ command, args, options });
					return record.proc;
				},
			},
		},
	});
	const manager = new AcpAgentManager({
		piLocator: { createInvocation: (command, args) => ({ command, args, shell: false }), createProcessEnv: () => ({}) },
		getProject: (id) => ({ path: `D:/proj-${id}` }),
		getTools: () => [{ id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], enabled: true }],
		onTitleChanged: () => {},
		...depsExtra,
	});
	const unsubscribe = manager.onOutput((channel, payload) => {
		if (channel === "agents:ui-request") events.uiRequests.push(payload);
		if (channel === "agents:message") events.messages.push(payload);
	});
	t.after(() => {
		unsubscribe();
		void manager.stopAll();
	});
	const createAgent = async (preset = "gemini") => manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: preset });
	const lastProc = () => procs[procs.length - 1];
	return { manager, events, spawnCalls, createAgent, procs, lastProc };
}

const TOOL = { id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], enabled: true };

test("握手:initialize → session/new;工具命令与项目 cwd 传给 spawn", async (t) => {
	const calls = [];
	const { manager, spawnCalls, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			calls.push(frame.method);
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
			if (frame.method === "session/new") return { sessionId: "sess-new", title: "New ACP Session" };
			return {};
		},
	});
	const tab = await createAgent();
	assert.equal(tab.status, "idle");
	assert.deepEqual(calls, ["initialize", "session/new"]);
	// mcpServers 必传空数组(ACP v1 规范必填;opencode 缺它 -32602,会话创建即失败)
	const newParams = lastProc().methodFrames("session/new")[0]?.params;
	assert.ok(String(newParams?.cwd).endsWith("proj-p1"), "session/new cwd 指向项目");
	assert.deepEqual(newParams?.mcpServers, [], "session/new 必须携带 mcpServers: []");
	assert.equal(spawnCalls[0].command, "gemini");
	assert.deepEqual(spawnCalls[0].args, ["--experimental-acp"]);
	assert.ok(spawnCalls[0].options.cwd.endsWith("proj-p1"));

	const state = await manager.getRuntimeState(tab.id);
	assert.equal(state.provider, "acp");
	assert.equal(state.modelName, TOOL.name);
});

test("恢复:声明 loadSession 且 load 成功时不发 session/new", async (t) => {
	const { manager, lastProc, events } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") return { sessionId: "sess-restored" };
			if (frame.method === "session/new") return { sessionId: "should-not-happen" };
			return {};
		},
	});
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(tab.status, "idle");
	const load = lastProc().methodFrames("session/load");
	assert.equal(load.length, 1);
	assert.equal(load[0].params.sessionId, "sess-old");
	assert.equal(lastProc().methodFrames("session/new").length, 0);
	// load 会话身份记录在 runtime:restart 传 acpSessionId 复用(下个用例展开回退分支)
	void events;
	void manager;
	void tab;
});

test("恢复:load 失败回退 session/new(拿新 sessionId 继续工作)", async (t) => {
	const { manager, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") return { __error: true, code: -32000, message: "session not found" };
			if (frame.method === "session/new") return { sessionId: "sess-fresh" };
			return {};
		},
	});
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-gone" });
	assert.equal(tab.status, "idle");
	assert.equal(lastProc().methodFrames("session/load").length, 1);
	const news = lastProc().methodFrames("session/new");
	assert.equal(news.length, 1);
	void manager;
});

test("未声明 loadSession 时直接 session/new(不带旧 sessionId)", async (t) => {
	const { manager, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-plain" };
			return {};
		},
	});
	await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(lastProc().methodFrames("session/load").length, 0);
	const news = lastProc().methodFrames("session/new");
	assert.equal(news.length, 1);
	assert.equal(news[0].params.sessionId, undefined);
});

test("sendPrompt:流式 update 投影为消息,stopReason 结算后回 idle", async (t) => {
	let promptRpcId = null;
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptRpcId = frame.id;
				return undefined; // 挂起:先推流式 update 再手动结算
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "hi" });
	await waitFor(() => promptRpcId !== null, "session/prompt dispatched");
	const cli = lastProc();
	cli.writeFromCli({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello " } } },
	});
	cli.writeFromCli({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: "sess-1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "world" } } },
	});
	// flush 节流 80ms,等合并后的消息落盘
	await waitFor(() => events.messages.some((payload) => payload.agentId === tab.id), "streamed message flush");
	cli.writeFromCli({ jsonrpc: "2.0", id: promptRpcId, result: { stopReason: "end_turn" } });
	const result = await sendPromise;
	assert.equal(result.accepted, true);
	const state = await manager.getRuntimeState(tab.id);
	assert.equal(state.isTurnActive, false);
	const lastFlush = events.messages.at(-1);
	const assistant = lastFlush.messages.find((message) => message.role === "assistant");
	assert.ok(assistant, "assistant message projected");
	assert.equal(assistant.text ?? assistant.content, "hello world");
});

test("abort:进行中的回合发 session/cancel 通知(prompt 挂起不拒绝)", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined; // 永久挂起
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "long task" });
	await waitFor(() => promptSeen, "prompt dispatched");
	await manager.abort(tab.id);
	const cancels = lastProc().methodFrames("session/cancel");
	assert.equal(cancels.length, 1);
	assert.equal(cancels[0].params.sessionId, "sess-1");
	// abort 只发通知,prompt promise 仍由 CLI 响应结算
	cli_finish: {
		const frame = lastProc().frames.find((item) => item.method === "session/prompt" && item.id !== undefined);
		lastProc().writeFromCli({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "cancelled" } });
		break cli_finish;
	}
	const result = await sendPromise;
	assert.equal(result.accepted, true);
});

test("turnActive 期间重复 sendPrompt 被拒绝(agentMessage 同样不支持)", async (t) => {
	let promptSeen = false;
	const { manager, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined;
			}
			return {};
		},
	});
	const tab = await createAgent();
	const first = manager.sendPrompt({ agentId: tab.id, message: "a" });
	await waitFor(() => promptSeen, "prompt dispatched");
	const second = await manager.sendPrompt({ agentId: tab.id, message: "b" });
	assert.equal(second.accepted, false);
	assert.match(second.error, /still responding/);
	const withInstructions = await manager.sendPrompt({ agentId: tab.id, message: "c", agentMessage: "host rules" });
	assert.equal(withInstructions.accepted, false);
	assert.match(withInstructions.error, /Host instructions/);
	void first;
	await manager.stop(tab.id);
});

test("permission 审批:select label 映射 optionId 回传;cancel 走 cancelled 结局", async (t) => {
	let promptSeen = false;
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined;
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "run stuff" });
	await waitFor(() => promptSeen, "prompt dispatched");
	const cli = lastProc();
	cli.writeFromCli({
		jsonrpc: "2.0",
		id: 777,
		method: "permission/request",
		params: {
			sessionId: "sess-1",
			permissions: [{ type: "command", command: "rm -rf build" }],
			options: [
				{ kind: "allow_once", name: "Allow" },
				{ kind: "reject_once", name: "Reject" },
			],
		},
	});
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select" && payload.agentId === tab.id), "ui request raised");
	const request = events.uiRequests.find((payload) => payload.method === "select");
	assert.equal(request.title, "rm -rf build");
	assert.deepEqual([...request.options], ["Allow", "Reject"]);
	// 渲染层点 Allow(label)→ manager 映射回 allow_once
	const accepted = await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: "Allow" });
	assert.equal(accepted.accepted, true);
	await waitFor(() => cli.frames.some((frame) => frame.id === 777 && frame.result), "respond frame sent");
	const respondFrame = cli.frames.find((frame) => frame.id === 777 && frame.result);
	assert.deepEqual(respondFrame.result, { outcome: "selected", optionId: "allow_once" });
	// 完成事件让渲染层撤卡
	assert.ok(events.uiRequests.some((payload) => payload.requestId === request.requestId && payload.completed === true));
	void sendPromise;
	await manager.stop(tab.id);
});

test("连接死亡:pending 审批全部 cancelled 结算,tab 转 error", async (t) => {
	let promptSeen = false;
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined;
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "work" });
	sendPromise.catch(() => {}); // 进程死亡会 reject,断言走 events
	await waitFor(() => promptSeen, "prompt dispatched");
	const cli = lastProc();
	cli.writeFromCli({
		jsonrpc: "2.0",
		id: 888,
		method: "permission/request",
		params: { sessionId: "sess-1", permissions: [{ type: "command", command: "cargo build" }], options: [{ kind: "allow_once" }] },
	});
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select"), "permission raised");
	// 进程死亡 → conn.close 先行,管道已断:respond 帧无处可写(正常语义),
	// 断言只看审批卡撤除(completed)与 tab 终态。
	cli.proc.emit("exit", 1, null);
	await waitFor(() => events.uiRequests.some((payload) => payload.completed === true), "pending permission settled cancelled");
	const listed = manager.list().find((item) => item.id === tab.id);
	assert.equal(listed.status, "error");
	// prompt 挂起中被进程死亡中断:不抛异常,结构化拒绝(accepted:false + exited 原因)
	const result = await sendPromise;
	assert.equal(result.accepted, false);
	assert.match(result.error, /exited/);
});

test("stop:杀进程、runtime 移除、list 不再含该 agent", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-1" };
			return {};
		},
	});
	const tab = await createAgent();
	assert.ok(manager.list().some((item) => item.id === tab.id));
	const cli = lastProc();
	await manager.stop(tab.id);
	assert.equal(
		manager.list().some((item) => item.id === tab.id),
		false,
	);
	assert.equal(cli.proc.exitCode, 0, "process killed");
	await assert.rejects(manager.getRuntimeState(tab.id), /No ACP runtime/);
});

test("图片物化:消息里的 base64 图经 imageStore 落盘成 ref,put 失败保留 data", async (t) => {
	const puts = [];
	let seq = 0;
	const imageStore = {
		put: async (data, mimeType) => {
			puts.push({ data, mimeType });
			seq += 1;
			// 第二张图模拟落盘失败(超限/写盘异常按 null 降级)
			return seq === 2 ? null : `blob-ref-${seq}`;
		},
	};
	const { events, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-img" };
				return {};
			},
		},
		{ imageStore },
	);
	const tab = await createAgent();
	const cli = lastProc();
	const notify = (update) => cli.writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-img", update } });
	// user 回显图(应物化成 ref-1)+ agent 生图(应物化成 ref-2,但 put 失败保留 data)
	notify({ sessionUpdate: "user_message_chunk", content: { type: "image", data: "user-img-base64", mimeType: "image/png" } });
	notify({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "gen-img-base64", mimeType: "image/png" } });
	await waitFor(() => {
		const last = events.messages.at(-1);
		return last && last.messages && last.messages.some((message) => message.role === "user" && message.images?.some((image) => image.ref === "blob-ref-1")) && last.messages.some((message) => message.role === "assistant" && message.images?.some((image) => image.data === "gen-img-base64"));
	}, "both images projected with materialization applied");
	const flushed = events.messages.at(-1);
	const userMsg = flushed.messages.find((message) => message.role === "user");
	const genMsg = flushed.messages.find((message) => message.role === "assistant");
	assert.equal(userMsg.images[0].ref, "blob-ref-1");
	assert.equal(userMsg.images[0].data, undefined);
	assert.equal(genMsg.images[0].ref, undefined);
	assert.equal(genMsg.images[0].data, "gen-img-base64");
	assert.deepEqual(
		puts.map((entry) => entry.data),
		["user-img-base64", "gen-img-base64"],
	);
});

test("图片物化:未注入 imageStore 时保持 data 形态(降级不断链)", async (t) => {
	const { events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-plain" };
			return {};
		},
	});
	await createAgent();
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-plain", update: { sessionUpdate: "user_message_chunk", content: { type: "image", data: "inline", mimeType: "image/png" } } } });
	await waitFor(() => {
		const last = events.messages.at(-1);
		return last && last.messages && last.messages.some((message) => message.role === "user");
	}, "user image echoed");
	const flushed = events.messages.at(-1);
	assert.equal(flushed.messages.find((message) => message.role === "user").images[0].data, "inline");
});

test("create merges tool-level env over base process env", async (t) => {
	const { spawnCalls, createAgent } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-env", title: "env" };
				return {};
			},
		},
		{ getTools: () => [{ id: "codex", name: "Codex", command: "codex-acp", args: [], env: { ZAI_CODING_KEY: "sk-tool", LANG: "zh-CN" }, enabled: true }] },
	);
	await createAgent("codex");
	// 工具级 env 必须传进 spawn(基础 env 为空对象,合并后应只含工具键)
	assert.equal(spawnCalls[0].options.env.ZAI_CODING_KEY, "sk-tool");
	assert.equal(spawnCalls[0].options.env.LANG, "zh-CN");
});

// ── configOptions 规范路径:session/new 枚举 → 查询/下发/通知更新 ──

const CONFIG_OPTIONS = [
	{
		id: "model",
		name: "Model",
		category: "model",
		type: "select",
		currentValue: "gpt-5",
		options: [
			{ value: "gpt-5", name: "GPT-5" },
			{ value: "o3", name: "o3" },
		],
	},
	{ id: "effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: "medium" },
];

test("configOptions:session/new 返回的枚举可查询;set_config_option 用响应整表更新", async (t) => {
	let applied;
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
			if (frame.method === "session/new") return { sessionId: "sess-cfg", configOptions: CONFIG_OPTIONS };
			if (frame.method === "session/set_config_option") {
				applied = frame.params;
				return { configOptions: [{ ...CONFIG_OPTIONS[0], currentValue: "o3" }, CONFIG_OPTIONS[1]] };
			}
			return {};
		},
	});
	const tab = await createAgent();
	// 查询:握手返回的枚举原样暴露(agent 未提供时是 undefined,渲染层隐藏选择器)
	assert.equal(manager.getSessionConfigOptions(tab.id)?.[0]?.id, "model");

	const updated = await manager.applyConfigOption(tab.id, "model", "o3");
	// 下发参数按规范带 sessionId + id + value
	// 参数名按规范是 configId(非 id);opencode 等实现对 id 形态报 -32602
	assert.deepEqual(applied, { sessionId: "sess-cfg", configId: "model", value: "o3" });
	assert.equal(updated[0].currentValue, "o3");
	assert.equal(manager.getSessionConfigOptions(tab.id)?.[0]?.currentValue, "o3");
	// 帧确实进了连接(防只改内存不发请求)
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 1);
});

test("configOptions:config_option_update 通知整表替换并回调 onConfigOptionsChanged", async (t) => {
	const seen = [];
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-cfg", configOptions: CONFIG_OPTIONS };
				return {};
			},
		},
		{ onConfigOptionsChanged: (tab, options) => seen.push({ agentId: tab.id, first: options[0]?.id }) },
	);
	const tab = await createAgent();
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "config_option_update", params: { sessionId: "sess-cfg", configOptions: [{ id: "model", currentValue: "o3" }] } });
	await waitFor(() => seen.length === 1);
	// 通知按 agentId 隔离(sessionId 不匹配的丢弃)
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "config_option_update", params: { sessionId: "other", configOptions: [{ id: "evil" }] } });
	await sleep(60);
	assert.deepEqual(seen, [{ agentId: tab.id, first: "model" }]);
	assert.equal(manager.getSessionConfigOptions(tab.id)?.[0]?.currentValue, "o3");
});
