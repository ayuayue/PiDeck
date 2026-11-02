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
function fakeAgentProcess(t, { handler = () => undefined, spawnError = undefined } = {}) {
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
				// 第二参数 { writeFromCli }:用例可在应答前先推通知(模拟 ACP 规范的 load 重放时序)
				const outcome = handler(frame, { writeFromCli: (obj) => stdout.write(`${JSON.stringify(obj)}\n`) });
				if (outcome?.__error) {
					// data 原样透传：agent 的拒绝细节（如 unknown permission_mode）只写在这里
					const error = { code: outcome.code ?? -32000, message: outcome.message ?? "fail", ...(outcome.data !== undefined ? { data: outcome.data } : {}) };
					stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, error })}\n`);
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
	// ENOENT 等 spawn 失败在 spawn 返回后异步经 error 事件抛出（与真 Node 一致）。
	if (spawnError) setImmediate(() => proc.emit("error", spawnError));
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
	const events = { uiRequests: [], messages: [], runtimeStates: [] };
	const procs = [];
	const spawnCalls = [];
	const { AcpAgentManager } = loadTsCommonJs("src/main/acp/AcpAgentManager.ts", {
		stubs: {
			"node:child_process": {
				spawn: (command, args, options) => {
					// Windows 树杀出口:同步模拟 taskkill /pid <pid> /T /F(找到匹配 fake 进程并 kill),
					// 不计入 spawnCalls(那里只记 agent CLI 的 spawn,索引有断言)。
					if (command === "taskkill") {
						const pid = Number(args?.[1]);
						const target = procs.find((record) => record.proc.pid === pid && record.proc.exitCode === null);
						target?.proc.kill();
						return Object.assign(new EventEmitter(), { pid: 9999, exitCode: 0, kill() {} });
					}
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
		isEnabled: () => true,
		onTitleChanged: () => {},
		...depsExtra,
	});
	const unsubscribe = manager.onOutput((channel, payload) => {
		if (channel === "agents:ui-request") events.uiRequests.push(payload);
		if (channel === "agents:message") events.messages.push(payload);
		if (channel === "agents:runtime-state") events.runtimeStates.push(payload);
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

test("总开关运行时判定:关闭时拒绝 spawn,打开后同一实例立即可用(不必重启应用)", async (t) => {
	let enabled = false;
	const { createAgent, spawnCalls, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-1" };
				return {};
			},
		},
		{ isEnabled: () => enabled },
	);
	// 开关在 create 边界实时判定：关闭时既不起进程，也覆盖「从历史恢复 ACP 会话」这条不经过后端下拉的路径
	await assert.rejects(() => createAgent(), /ACP backend is disabled/);
	assert.equal(spawnCalls.length, 0, "关闭时不得 spawn 任何 CLI");
	// 设置页打开开关后同一 manager 实例立即生效（网关启动时已常驻注册，开关不需要重启）
	enabled = true;
	const tab = await createAgent();
	assert.equal(tab.backend, "acp");
	assert.equal(spawnCalls.length, 1, "打开后立即允许 spawn");
	assert.equal(lastProc().methodFrames("initialize").length, 1, "新进程完成握手");
});

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

test("新建:tab.sessionId 必须回填 agent 侧会话 id(coordinator buildAttachPatch 据此把 acpSessionId 落 catalog;缺失则重开历史会话永远 session/new 新建、历史丢失)", async (t) => {
	const { createAgent, manager } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-fresh" };
			return {};
		},
	});
	const fresh = await createAgent();
	assert.equal(manager.list().find((tab) => tab.id === fresh.id)?.sessionId, "sess-fresh", "session/new 后 tab.sessionId = agent 侧会话 id");
});

test("恢复:load 成功后 tab.sessionId 同样回填(load 回来的会话 id 才是 catalog 要持久化的身份)", async (t) => {
	const { manager } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") return { sessionId: "sess-restored" };
			if (frame.method === "session/new") return { sessionId: "should-not-happen" };
			return {};
		},
	});
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(manager.list().find((item) => item.id === tab.id)?.sessionId, "sess-restored");
});

test("恢复:load 重放的 session/update(ACP 规范:agent 先重放历史再回 load 响应)不得被 sessionId 过滤丢弃", async (t) => {
	const { manager, events } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") {
				// 模拟规范行为:先推全部历史重放,再应答 session/load
				writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-old", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text: "earlier question" } } } });
				writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-old", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "earlier answer" } } } });
				return { sessionId: "sess-old" };
			}
			if (frame.method === "session/new") return { sessionId: "should-not-happen" };
			return {};
		},
	});
	const tab = await manager.create({ projectId: "p1", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	await waitFor(() => {
		const flushed = events.messages.filter((payload) => payload.agentId === tab.id);
		return flushed.length > 0 && flushed.at(-1).messages.length >= 2;
	}, "load 重放历史投影为消息");
	const messages = manager.getMessages(tab.id);
	assert.equal(messages.filter((message) => message.role === "user").at(-1)?.text, "earlier question", "重放的用户消息保留");
	assert.equal(messages.filter((message) => message.role === "assistant").at(-1)?.text, "earlier answer", "重放的助手消息保留");
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

test("abort 升级:首次 cancel 后 CLI 无响应,宽限超时强杀进程并按 unknown 结算", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-esc" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					return undefined; // 永久挂起:模拟 CLI wedged(opencode 流错误实测)
				}
				return {};
			},
		},
		{ abortEscalationMs: 50 },
	);
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "hang" });
	await waitFor(() => promptSeen, "prompt dispatched");
	await manager.abort(tab.id);
	// 宽限内 CLI 不回包:升级定时器强杀进程(win32 走 taskkill 桩,其余平台 proc.kill)
	await waitFor(() => lastProc().proc.exitCode === 0, "escalated force kill");
	const result = await sendPromise;
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "unknown", "强杀后 CLI 是否已处理不可知,不回填草稿");
	assert.equal(result.i18nKey, "acp.abortForceStopped");
	assert.equal(result.i18nParams?.tool, "Gemini CLI");
	assert.equal(manager.list().length, 0, "runtime 已随强杀移除");
});

test("abort 在回合已结算但 status 残留 running 时收回 idle，而不是静默 no-op", async (t) => {
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-stale" };
			return {};
		},
	});
	const tab = await createAgent();
	// 模拟迟到的 status 快照：回合早已结束（turnActive=false），渲染层却仍显示 running。
	const runtime = manager.runtimes.get(tab.id);
	runtime.status = "running";
	runtime.tab.status = "running";
	runtime.turnActive = false;
	const before = events.runtimeStates.length;
	await manager.abort(tab.id);
	assert.equal(manager.list().find((item) => item.id === tab.id)?.status, "idle", "停止按钮必须能把残留 running 收回 idle");
	assert.ok(events.runtimeStates.length > before, "应推送一次 runtime-state 让渲染层收口");
	assert.equal(events.runtimeStates.at(-1).state.isTurnActive, false);
	assert.equal(lastProc().methodFrames("session/cancel").length, 0, "没有活动回合时不应向 CLI 发 cancel");
});

test("abort 升级:二次停止立即强杀,不等宽限", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-esc2" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					return undefined;
				}
				return {};
			},
		},
		{ abortEscalationMs: 60_000 },
	);
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "hang" });
	await waitFor(() => promptSeen, "prompt dispatched");
	await manager.abort(tab.id);
	await manager.abort(tab.id); // 二次停止 → abort_repeat 立即强杀
	await waitFor(() => lastProc().proc.exitCode === 0, "immediate force kill");
	const result = await sendPromise;
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "unknown");
	assert.equal(result.i18nKey, "acp.abortForceStopped");
});

test("stall 看门狗:全静默超阈值先补 cancel 再强杀", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-stall" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					return undefined;
				}
				return {};
			},
		},
		{ promptStallTimeoutMs: 80, abortEscalationMs: 50 },
	);
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "silent hang" });
	await waitFor(() => promptSeen, "prompt dispatched");
	// 不 abort:看门狗自行发现全静默 → cancel(reason stall) → 升级强杀
	await waitFor(() => lastProc().proc.exitCode === 0, "stall force kill");
	const stallCancels = lastProc()
		.methodFrames("session/cancel")
		.filter((frame) => frame.params?.reason === "stall");
	assert.equal(stallCancels.length, 1, "强杀前先补发一次 stall cancel");
	const result = await sendPromise;
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "acp.stallForceStopped");
	assert.equal(result.delivery, "unknown");
});

test("stall 看门狗:cancel 后 CLI 收口但全程无输出 → 按空白回合拒收(OpenCode 1.15.4 /event 竞态实测形态)", async (t) => {
	let promptSeen = false;
	const { manager, events, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-stall-blank" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					return undefined; // 挂起:收到 stall cancel 后才收口,且不回任何 session/update
				}
				return {};
			},
		},
		{ promptStallTimeoutMs: 80 },
	);
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "blank turn" });
	await waitFor(() => promptSeen, "prompt dispatched");
	await waitFor(() => lastProc().methodFrames("session/cancel").length === 1, "stall cancel sent");
	// CLI 响应 cancel 在宽限内回包(生产日志:dispatchMs≈90170,accepted:true 即此形态)
	const frame = lastProc().frames.find((item) => item.method === "session/prompt" && item.id !== undefined);
	lastProc().writeFromCli({ jsonrpc: "2.0", id: frame.id, result: { stopReason: "cancelled" } });
	const result = await sendPromise;
	assert.equal(result.accepted, false, "看门狗代发 cancel 收口的空白回合不得谎报成功");
	assert.equal(result.delivery, "rejected");
	assert.equal(result.i18nKey, "acp.emptyTurn");
	assert.equal(events.messages.at(-1).messages.length, 0, "孤立用户消息已撤回");
});

test("stall 看门狗:挂起审批期间不判静默(等待用户是合法状态)", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc, events } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-perm" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					return undefined;
				}
				return {};
			},
		},
		{ promptStallTimeoutMs: 60 },
	);
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "need approval" });
	await waitFor(() => promptSeen, "prompt dispatched");
	// CLI 发起权限请求:回合进入等待用户状态(参数结构必须合法,否则立即回 cancelled 不挂起)
	lastProc().writeFromCli({
		jsonrpc: "2.0",
		id: 999,
		method: "session/request_permission",
		params: {
			sessionId: "sess-perm",
			toolCall: { toolCallId: "call-1", title: "Run command" },
			options: [
				{ optionId: "allow", name: "Allow", kind: "allow_once" },
				{ optionId: "reject", name: "Reject", kind: "reject_once" },
			],
		},
	});
	await waitFor(() => events.uiRequests.length > 0, "permission surfaced");
	await sleep(300); // 远超 stall 阈值:审批挂起期间不得触发看门狗
	assert.equal(lastProc().proc.exitCode, null, "等待审批不得强杀进程");
	assert.equal(lastProc().methodFrames("session/cancel").length, 0, "不得补发 stall cancel");
	assert.equal(manager.list()[0].status, "running");
	// 用户取消审批 → 权限按 cancelled 回包;回合仍由 CLI 侧收口(挂起由 t.after 的 stopAll 结算)
	const pendingRequest = events.uiRequests.find((payload) => payload.method === "select");
	const respond = await manager.sendUIResponse(tab.id, pendingRequest.requestId, { cancelled: true });
	assert.equal(respond.accepted, true);
	await waitFor(() => lastProc().frames.some((frame) => frame.id === 999 && frame.result?.outcome?.outcome === "cancelled"), "permission answered");
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
	// 拒收携带本地化描述符：渲染层 translateI18nDescriptor 据此弹本地化 toast 而非英文原文。
	assert.equal(second.i18nKey, "acp.turnBusy");
	assert.equal(second.i18nParams?.tool, TOOL.name);
	const withInstructions = await manager.sendPrompt({ agentId: tab.id, message: "c", agentMessage: "host rules" });
	assert.equal(withInstructions.accepted, false);
	assert.match(withInstructions.error, /Host instructions/);
	assert.equal(withInstructions.i18nKey, "acp.hostInstructionsUnsupported");
	void first;
	await manager.stop(tab.id);
});

test("图片能力门控:agent 未声明 promptCapabilities.image 时带图发送被拒收并本地化;声明后放行且图块进发件帧", async (t) => {
	let lastPrompt;
	const mk = (capabilities) =>
		harness(t, {
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: capabilities };
				if (frame.method === "session/new") return { sessionId: "sess-img-cap" };
				if (frame.method === "session/prompt") {
					lastPrompt = frame.params;
					// 正常 agent 会回输出;空白回合守卫会拒收无输出的成功结算,这里补一条 chunk
					writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-img-cap", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } } });
					return { stopReason: "end_turn" };
				}
				return {};
			},
		});
	const images = [{ type: "image", mimeType: "image/png", data: "aW1n" }];
	// 未声明图片能力:拒收(turn 未启,草稿回填由渲染层完成)
	const denied = mk({ loadSession: false });
	const deniedTab = await denied.createAgent();
	const deniedResult = await denied.manager.sendPrompt({ agentId: deniedTab.id, message: "带图", images });
	assert.equal(deniedResult.accepted, false);
	assert.equal(deniedResult.delivery, "rejected");
	assert.equal(deniedResult.i18nKey, "acp.imagesNotSupported");
	assert.equal(deniedResult.i18nParams?.tool, TOOL.name);
	assert.equal(lastPrompt, undefined, "拒收不得发出 session/prompt 帧");
	// 声明图片能力:放行,prompt 帧携带 image 块(规范 content 顺序:文本后图)
	const allowed = mk({ promptCapabilities: { image: true } });
	const allowedTab = await allowed.createAgent();
	const allowedResult = await allowed.manager.sendPrompt({ agentId: allowedTab.id, message: "带图", images });
	assert.equal(allowedResult.accepted, true);
	assert.deepEqual(lastPrompt.prompt, [
		{ type: "text", text: "带图" },
		{ type: "image", data: "aW1n", mimeType: "image/png" },
	]);
});

test("AUTH_REQUIRED(回合期):-32000 拒收携带登录引导描述符(debugDetails 保留 RPC 原文)", async (t) => {
	const { manager, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-auth" };
			if (frame.method === "session/prompt") return { __error: true, code: -32000, message: "Authentication required" };
			return {};
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "rejected");
	assert.equal(result.i18nKey, "acp.authRequired");
	assert.equal(result.i18nParams?.tool, TOOL.name);
	assert.equal(result.debugDetails, "ACP RPC error -32000: Authentication required", "RPC 原文必须留在 debugDetails 供排查");
});

test("usage_update 通知映射进 runtime.state 上下文仪表(used/size→contextTokens/Window/Percent,cost→cost)", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-usage" };
			return {};
		},
	});
	const tab = await createAgent();
	lastProc().writeFromCli({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: "sess-usage", update: { sessionUpdate: "usage_update", used: 25528, size: 1_000_000, cost: { amount: 0.42, currency: "USD" } } },
	});
	await waitFor(async () => (await manager.getRuntimeState(tab.id)).contextTokens === 25528, "usage 投影进 runtime.state");
	const state = await manager.getRuntimeState(tab.id);
	assert.equal(state.contextTokens, 25528);
	assert.equal(state.contextWindow, 1_000_000);
	assert.equal(state.contextPercent, 2.6);
	assert.equal(state.cost, 0.42);
	assert.equal(state.provider, "acp");
});

test("工具被删/禁用:create 直接拒且标 i18nKey acp.toolMissing（老会话绑定还在不报错 id）", async (t) => {
	const { createAgent, manager } = harness(t, {
		handler: () => ({}),
	});
	const failure = await manager.create({ projectId: "p1", backend: "acp", agentPreset: "tool-gone" }).catch((error) => error);
	assert.match(failure.message, /not found or disabled/);
	assert.equal(failure.i18nKey, "acp.toolMissing");
	assert.equal(failure.i18nParams?.tool, "tool-gone");
	void createAgent;
});

test("CLI 未安装(spawn ENOENT):create 抛出 acp.toolNotInstalled 描述符（带完整命令行供安装引导）", async (t) => {
	const { createAgent, manager } = harness(t, {
		spawnError: Object.assign(new Error("spawn gemini ENOENT"), { code: "ENOENT" }),
		// 挂起 initialize：等 spawn 的 error 事件决定握手结局（真实 CLI 起不来就是应答绝不返回）。
		handler: () => undefined,
	});
	const failure = await createAgent().catch((error) => error);
	assert.equal(failure.i18nKey, "acp.toolNotInstalled");
	assert.equal(failure.i18nParams?.tool, TOOL.name);
	assert.equal(failure.i18nParams?.command, "gemini --experimental-acp");
	assert.equal(failure.debugDetails, "spawn gemini ENOENT");
	assert.equal(manager.list().length, 0);
});

test("握手超时(initialize 挂起):create 抛出 acp.startupTimeout 描述符（中性重试引导）", async (t) => {
	const { createAgent, manager } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return undefined; // 永不应答
				if (frame.method === "session/new") return { sessionId: "never" };
				return {};
			},
		},
		{ handshakeTimeoutMs: 40 },
	);
	const failure = await createAgent().catch((error) => error);
	assert.equal(failure.i18nKey, "acp.startupTimeout");
	assert.equal(failure.i18nParams?.tool, TOOL.name);
	assert.match(failure.debugDetails, /timed out after 40ms: initialize/);
	assert.equal(manager.list().length, 0);
});

test("AUTH_REQUIRED(首启):session/new 返回 -32000 时 create 抛出带描述符的错误(coordinator 透传为登录引导 toast)", async (t) => {
	const { createAgent, manager } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { __error: true, code: -32000, message: "Authentication required" };
			return {};
		},
	});
	const failure = await createAgent().catch((error) => error);
	assert.ok(failure instanceof Error);
	assert.match(failure.message, /Authentication required/);
	assert.equal(failure.i18nKey, "acp.authRequired");
	assert.equal(failure.i18nParams?.tool, TOOL.name);
	assert.equal(manager.list().length, 0, "首启失败不留进程垃圾");
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
		method: "session/request_permission",
		params: {
			sessionId: "sess-1",
			toolCall: { toolCallId: "shell-1", title: "git status", rawInput: { command: "git status" } },
			options: [
				{ optionId: "allow-command", kind: "allow_once", name: "Allow" },
				{ optionId: "reject-command", kind: "reject_once", name: "Reject" },
			],
		},
	});
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select" && payload.agentId === tab.id), "ui request raised");
	const request = events.uiRequests.find((payload) => payload.method === "select");
	assert.equal(request.title, "git status");
	assert.deepEqual([...request.options], ["Allow", "Reject"]);
	// 渲染层点 Allow(label)→ manager 映射回原 optionId（不是 kind）
	const accepted = await manager.sendUIResponse(tab.id, request.requestId, { type: "select", value: "Allow" });
	assert.equal(accepted.accepted, true);
	await waitFor(() => cli.frames.some((frame) => frame.id === 777 && frame.result), "respond frame sent");
	const respondFrame = cli.frames.find((frame) => frame.id === 777 && frame.result);
	assert.deepEqual(respondFrame.result, { outcome: { outcome: "selected", optionId: "allow-command" } });
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
		method: "session/request_permission",
		params: { sessionId: "sess-1", toolCall: { toolCallId: "shell-2", title: "cargo build" }, options: [{ optionId: "allow-build", name: "Allow", kind: "allow_once" }] },
	});
	await waitFor(() => events.uiRequests.some((payload) => payload.method === "select"), "permission raised");
	// exit 之后仍可能有 stdout 尾帧；Node 在 stdio 关闭后才发 close。
	// 断言只看审批卡撤除(completed)与 tab 终态，已断管不要求送出回包。
	cli.proc.emit("exit", 1, null);
	cli.proc.emit("close", 1, null);
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

test("stop 后 readMessagesByAcpSessionId 回退内存快照:重入会话时间线不空白", async (t) => {
	let promptSeen = false;
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-snap" };
			if (frame.method === "session/prompt") {
				promptSeen = true;
				return undefined; // 挂起:只验证种子消息快照,回合由 t.after stopAll 结算
			}
			return {};
		},
	});
	const tab = await createAgent();
	void manager.sendPrompt({ agentId: tab.id, message: "keep this" });
	await waitFor(() => promptSeen, "prompt dispatched");
	await waitFor(() => (events.messages.at(-1)?.messages ?? []).some((entry) => entry.role === "user"), "user bubble flushed");
	await manager.stop(tab.id);
	// runtime 已删:快照回退,重入时 session/load 前也有内容可显
	const snapshot = manager.readMessagesByAcpSessionId("sess-snap");
	assert.ok(snapshot.length >= 1, "snapshot non-empty after stop");
	assert.equal(snapshot.at(-1).role, "user");
	assert.equal(manager.readMessagesByAcpSessionId("sess-unknown").length, 0, "未见过的会话仍为空(跨 Realm 数组不能 deepEqual)");
});

test("恢复:load 失败回退 session/new 时投影播种快照,空投影不得抹掉已显示历史", async (t) => {
	// 焦点预热(2026-10-14)让「选中历史会话即激活」成为常态:load 失败的 CLI 回退
	// session/new 后,create() 末尾的全量 flush 若带空投影,渲染层已显示的快照历史
	// 会被整段抹掉。回退分支必须用 messageSnapshots 播种投影。
	let failLoad = false;
	let promptCount = 0;
	const { manager, events } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
			if (frame.method === "session/load") {
				if (failLoad) return { __error: true, code: -32000, message: "session not found" };
				return { sessionId: "sess-seed" };
			}
			if (frame.method === "session/new") return { sessionId: "sess-seed-fresh" };
			if (frame.method === "session/prompt") {
				promptCount += 1;
				writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-seed", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer-${promptCount}` } } } });
				return { stopReason: "end_turn" };
			}
			return {};
		},
	});
	// 第一段:真实回合落两条消息(user seed + assistant),stop 后进快照。
	const first = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-seed", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-seed" });
	await manager.sendPrompt({ agentId: first.id, message: "keep" });
	await waitFor(() => (events.messages.at(-1)?.messages ?? []).some((entry) => entry.role === "assistant"), "assistant flushed");
	await manager.stop(first.id);
	// 第二段:同一 acpSessionId 但 load 失败(CLI 侧会话已丢)回退 session/new。
	failLoad = true;
	const second = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-seed", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-seed" });
	assert.equal(second.status, "idle");
	// create() 末尾 flushMessages(runtime, true) 必须带出播种消息,而不是空数组。
	await waitFor(() => {
		const last = events.messages.at(-1);
		return last?.agentId === second.id && (last.messages ?? []).some((entry) => entry.role === "assistant");
	}, "seeded history flushed after session/new fallback");
	const restored = manager.readMessagesByAcpSessionId("sess-seed");
	assert.ok(restored.some((entry) => entry.role === "user") && restored.some((entry) => entry.role === "assistant"), "回退后可读消息含 user+assistant");
});

test("恢复:CLI 无 loadSession 能力时同样播种快照,session/new 不得抹掉已显示历史", async (t) => {
	// 与 load 失败回退同一道理:无 loadSession 能力的 CLI 重新激活(重启按钮/焦点预热)
	// 只能 session/new,若空投影直达 create() 末尾的全量 flush,已显示的快照历史会被
	// 整段抹掉。restart() 传 acpSessionId + 握手播种分支必须保住显示连续性。
	let promptCount = 0;
	let sessionId = "sess-noload";
	const { manager, events } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
			if (frame.method === "session/load") throw new Error("must not call session/load without loadSession capability");
			if (frame.method === "session/new") {
				// 两次 create 各新建一个 agent 侧会话:首次 sess-noload,重启后 sess-noload-2。
				sessionId = sessionId === "sess-noload" ? "sess-noload-2" : "sess-noload";
				return { sessionId };
			}
			if (frame.method === "session/prompt") {
				promptCount += 1;
				writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer-${promptCount}` } } } });
				return { stopReason: "end_turn" };
			}
			return {};
		},
	});
	const first = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-noload", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-noload" });
	await manager.sendPrompt({ agentId: first.id, message: "keep" });
	await waitFor(() => (events.messages.at(-1)?.messages ?? []).some((entry) => entry.role === "assistant"), "assistant flushed");
	// restart():stop 旧 runtime 后重建。acpSessionId 必须透传,新会话投影播种快照。
	const second = await manager.restart(first.id);
	assert.equal(second.status, "idle");
	assert.equal(manager.getAgentInfo(second.id).capabilities.loadSession, false);
	await waitFor(() => {
		const last = events.messages.at(-1);
		return last?.agentId === second.id && (last.messages ?? []).some((entry) => entry.role === "assistant");
	}, "seeded history flushed after session/new for no-load CLI");
	const restored = manager.readMessagesByAcpSessionId("sess-noload-2");
	assert.ok(restored.some((entry) => entry.role === "user") && restored.some((entry) => entry.role === "assistant"), "新会话可读消息含 user+assistant(播种自快照)");
});

test("快照上限不截断正常长会话:60 条消息 stop 后仍完整可读(2026-10-14 丢史回归)", async (t) => {
	// 一个带工具调用的回合 assistant/tool 条目就能上双位数;旧上限 16 会把关闭
	// 重开后的历史截到只剩最后一小段(ACP CLI 不支持 loadSession 重放时无第二数据源)。
	// 投影里连续同型 chunk 会并回一条消息,所以用 30 个回合(每回合 user+assistant 各一)攒 60 条。
	const TURNS = 30;
	let promptCount = 0;
	const { manager, events, createAgent } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-long" };
			if (frame.method === "session/prompt") {
				promptCount += 1;
				writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-long", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `answer-${promptCount}` } } } });
				return { stopReason: "end_turn" };
			}
			return {};
		},
	});
	const tab = await createAgent();
	for (let i = 0; i < TURNS; i += 1) {
		const result = await manager.sendPrompt({ agentId: tab.id, message: `msg-${i}` });
		assert.equal(result.accepted, true, `turn ${i} settles with output`);
	}
	assert.equal(promptCount, TURNS);
	await waitFor(() => (events.messages.at(-1)?.messages ?? []).length >= TURNS * 2, "all turns flushed");
	await manager.stop(tab.id);
	// 每回合 user 1 + assistant 1 = 60 条;旧上限 16 必红。
	const snapshot = manager.readMessagesByAcpSessionId("sess-long");
	assert.ok(snapshot.length >= TURNS * 2, `snapshot keeps full conversation (snapshot=${snapshot.length}, expected>=${TURNS * 2})`);
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

test("configOptions:boolean 项写入必须带 agent 声明的 type（CodeBuddy 2.178.1 否则 -32602）", async (t) => {
	// issue #451：{configId, value} 会被服务端按 string 分支校验，boolean 值直接
	// "Invalid input: expected string, received boolean"；带 type:"boolean" 才走 boolean 分支。
	const booleanOption = { id: "multitask", name: "Multitask", type: "boolean", currentValue: false };
	let applied;
	const { manager, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
			if (frame.method === "session/new") return { sessionId: "sess-bool", configOptions: [booleanOption] };
			if (frame.method === "session/set_config_option") {
				applied = frame.params;
				return { configOptions: [{ ...booleanOption, currentValue: true }] };
			}
			return {};
		},
	});
	const tab = await createAgent();
	const updated = await manager.applyConfigOption(tab.id, "multitask", true);
	assert.deepEqual(applied, { sessionId: "sess-bool", configId: "multitask", type: "boolean", value: true });
	assert.equal(updated[0].currentValue, true);
});

test("configOptions:拒绝时把 error.data.details 拼进错误文案（渲染层提示要用它）", async (t) => {
	// Qoder CLI 把 "Bypass Permissions"(yolo) 列进 configOptions，但 set_config_option 回
	// -32603 且原因只写在 data.details；IPC 只透传 message，不拼进去用户只看到 "Internal error"。
	const { manager, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
			if (frame.method === "session/new") return { sessionId: "sess-cfg", configOptions: CONFIG_OPTIONS };
			if (frame.method === "session/set_config_option") return { __error: true, code: -32603, message: "Internal error", data: { details: "unknown permission_mode: yolo" } };
			return {};
		},
	});
	const tab = await createAgent();
	await assert.rejects(
		() => manager.applyConfigOption(tab.id, "mode", "yolo"),
		(error) => {
			assert.match(error.message, /ACP RPC error -32603: Internal error/, "原始 RPC 文案保留");
			assert.match(error.message, /unknown permission_mode: yolo/, "agent 的拒绝细节必须带到渲染层");
			return true;
		},
	);
});

test("configOptions:工具级 bypassPermissions 在新会话握手后自动切到 bypass 档", async (t) => {
	// Claude 适配器不读启动参数（初始模式只取 settings.json 的 defaultMode），只能握手后下发；
	// Qoder 适配器则直接拒绝该值——所以这条是「尽力而为」，失败不阻断开会话。
	const modeOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "default",
		options: [
			{ value: "default", name: "Manual" },
			{ value: "bypassPermissions", name: "Bypass permissions" },
		],
	};
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-bypass", configOptions: [modeOption] };
				if (frame.method === "session/set_config_option") return { configOptions: [{ ...modeOption, currentValue: frame.params.value }] };
				return {};
			},
		},
		{ getTools: () => [{ id: "gemini", name: "Gemini CLI", command: "gemini", args: ["--experimental-acp"], enabled: true, bypassPermissions: true }] },
	);
	const tab = await createAgent();
	const frames = lastProc().methodFrames("session/set_config_option");
	assert.equal(frames.length, 1, "开了开关必须下发一次配置切换");
	assert.equal(JSON.stringify(frames[0]?.params), JSON.stringify({ sessionId: "sess-bypass", configId: "mode", value: "bypassPermissions" }));
	assert.equal(manager.getSessionConfigOptions(tab.id)?.[0]?.currentValue, "bypassPermissions");
});

test("configOptions:不开 bypassPermissions 时不得自动下发（默认权限不动）", async (t) => {
	const modeOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "default",
		options: [
			{ value: "default", name: "Manual" },
			{ value: "bypassPermissions", name: "Bypass permissions" },
		],
	};
	const { createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
			if (frame.method === "session/new") return { sessionId: "sess-plain", configOptions: [modeOption] };
			return {};
		},
	});
	await createAgent();
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 0, "没开开关就不该动权限模式");
});

test("configOptions:启动参数已定档 bypass 时，记忆里的旧模式不得覆盖（Qoder --permission-mode）", async (t) => {
	// 现场：Qoder CLI 只能靠 `--permission-mode bypass_permissions` 定档，运行期回写 yolo 一律
	// -32603 unknown permission_mode。此前重放记忆里的 mode=auto 会把会话降回 Auto，随后补设
	// bypass 又必然失败；而重开会话（session/load 不重放）却正常。本用例钉住：模式已经是
	// bypass 时既不得重放旧值，也不得再发一次注定被拒的下发；其他选项照旧重放。
	const modeOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "yolo",
		options: [
			{ value: "default", name: "Default" },
			{ value: "auto", name: "Auto" },
			{ value: "yolo", name: "Bypass Permissions" },
		],
	};
	const effortOption = {
		id: "effort",
		name: "Reasoning effort",
		category: "thought_level",
		type: "select",
		currentValue: "medium",
		options: [
			{ value: "medium", name: "Medium" },
			{ value: "high", name: "High" },
		],
	};
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-qoder", configOptions: [modeOption, effortOption] };
				if (frame.method === "session/set_config_option") {
					if (frame.params.value === "yolo") return { __error: true, code: -32603, message: "Internal error", data: { details: "unknown permission_mode: yolo" } };
					const next = [modeOption, effortOption].map((option) => (option.id === frame.params.configId ? { ...option, currentValue: frame.params.value } : option));
					return { configOptions: next };
				}
				return {};
			},
		},
		{
			getTools: () => [{ id: "qoder", name: "Qoder CLI", command: "qodercli", args: ["--acp", "--permission-mode", "bypass_permissions"], enabled: true, bypassPermissions: true }],
			getToolConfigDefaults: () => ({ mode: "auto", effort: "high" }),
		},
	);
	const tab = await createAgent("qoder");
	const frames = lastProc().methodFrames("session/set_config_option");
	assert.equal(JSON.stringify(frames.map((frame) => frame.params)), JSON.stringify([{ sessionId: "sess-qoder", configId: "effort", value: "high" }]), "只重放非模式项；模式既不得降回 auto，也不得再试确定被拒的 yolo");
	const options = manager.getSessionConfigOptions(tab.id) ?? [];
	assert.equal(options.find((option) => option.id === "mode")?.currentValue, "yolo", "新会话必须保持在启动参数定下的 bypass 档");
	assert.equal(options.find((option) => option.id === "effort")?.currentValue, "high", "记忆重放不得被模式锁定连带跳过");
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

// ── 工具级配置记忆:用户切换写回 → 新建会话重放;load 恢复不覆盖 ──

test("configOptions:新建会话重放思考档,模型与失效项不重放,重放不反向写记忆", async (t) => {
	const applied = [];
	const remembered = [];
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-mem", configOptions: CONFIG_OPTIONS };
				if (frame.method === "session/set_config_option") {
					applied.push(frame.params);
					return { configOptions: CONFIG_OPTIONS.map((option) => (option.id === frame.params.configId ? { ...option, currentValue: frame.params.value } : option)) };
				}
				return {};
			},
		},
		{
			getToolConfigDefaults: () => ({ model: "o3", effort: "high", removed: "x" }),
			rememberConfigOption: (toolId, optionId, value) => remembered.push({ toolId, optionId, value }),
		},
	);
	const tab = await createAgent();
	// 只重放 effort:model 不在记忆范围,removed 已不在当前枚举
	assert.deepEqual(applied, [{ sessionId: "sess-mem", configId: "effort", value: "high" }]);
	assert.equal(manager.getSessionConfigOptions(tab.id)?.[1]?.currentValue, "high");
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 1);
	// 重放是恢复历史选择,不能反过来再写一次设置
	assert.deepEqual(remembered, []);
});

test("configOptions:历史会话恢复(session/load)后仍按工具开关补回 bypass 权限档", async (t) => {
	// 现场：agent 不持久化权限模式，session/load 回来的是新进程默认档（auto）；若恢复路径不补，
	// 用户明明开了「Bypass 权限」，历史会话却一重开就掉回 auto。只在当前档位不是 bypass 时下发。
	const modeOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "auto",
		options: [
			{ value: "auto", name: "Auto" },
			{ value: "fullAccess", name: "Full access" },
		],
	};
	const { manager, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				if (frame.method === "session/load") return { sessionId: "sess-old", configOptions: [modeOption] };
				if (frame.method === "session/set_config_option") return { configOptions: [{ ...modeOption, currentValue: frame.params.value }] };
				return {};
			},
		},
		{ getTools: () => [{ id: "codebuddy", name: "CodeBuddy", command: "codebuddy", args: ["--acp"], enabled: true, bypassPermissions: true }] },
	);
	const tab = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: "codebuddy", acpSessionId: "sess-old" });
	assert.equal(lastProc().methodFrames("session/new").length, 0, "load 成功不得回退新建");
	const frames = lastProc().methodFrames("session/set_config_option");
	assert.equal(JSON.stringify(frames.map((frame) => frame.params)), JSON.stringify([{ sessionId: "sess-old", configId: "mode", value: "fullAccess" }]));
	assert.equal(manager.getSessionConfigOptions(tab.id)?.find((option) => option.id === "mode")?.currentValue, "fullAccess");
});

test("configOptions:历史会话恢复时，记忆里的 bypass 档同样补回（工具开关未开）", async (t) => {
	// 用户没勾工具级开关，但是在会话里手动选过 bypass：set_config_option 成功后写进记忆，
	// 恢复历史会话时 agent 回 auto，必须按记忆补回，否则「上次选过 full/bypass」的历史会话重开就丢。
	const modeOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "auto",
		options: [
			{ value: "auto", name: "Auto" },
			{ value: "bypassPermissions", name: "Bypass permissions" },
		],
	};
	const { manager, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				if (frame.method === "session/load") return { sessionId: "sess-old", configOptions: [modeOption] };
				if (frame.method === "session/set_config_option") return { configOptions: [{ ...modeOption, currentValue: frame.params.value }] };
				return {};
			},
		},
		{ getToolConfigDefaults: () => ({ mode: "bypassPermissions" }) },
	);
	const tab = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	const frames = lastProc().methodFrames("session/set_config_option");
	assert.equal(JSON.stringify(frames.map((frame) => frame.params)), JSON.stringify([{ sessionId: "sess-old", configId: "mode", value: "bypassPermissions" }]));
	assert.equal(manager.getSessionConfigOptions(tab.id)?.find((option) => option.id === "mode")?.currentValue, "bypassPermissions");
});

test("configOptions:历史会话恢复时，记忆里的非 bypass 模式不得覆盖 agent 恢复出的模式", async (t) => {
	const modeOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "plan",
		options: [
			{ value: "plan", name: "Plan" },
			{ value: "auto", name: "Auto" },
			{ value: "bypassPermissions", name: "Bypass permissions" },
		],
	};
	const { manager, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				if (frame.method === "session/load") return { sessionId: "sess-old", configOptions: [modeOption] };
				return {};
			},
		},
		{ getToolConfigDefaults: () => ({ mode: "auto", effort: "high" }) },
	);
	const tab = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 0, "恢复会话既不降级模式，也不全量重放");
	assert.equal(manager.getSessionConfigOptions(tab.id)?.find((option) => option.id === "mode")?.currentValue, "plan");
});

test("configOptions:历史会话恢复出的已是更强 bypass 档时，不按记忆降级", async (t) => {
	// CodeBuddy 的 fullAccess 强于 Claude 的 bypassPermissions：agent 已恢复 fullAccess 时，
	// 记忆里的弱档不得把它覆盖回 bypassPermissions。
	const modeOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "fullAccess",
		options: [
			{ value: "auto", name: "Auto" },
			{ value: "bypassPermissions", name: "Bypass permissions" },
			{ value: "fullAccess", name: "Full access" },
		],
	};
	const { manager, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				if (frame.method === "session/load") return { sessionId: "sess-old", configOptions: [modeOption] };
				return {};
			},
		},
		{ getToolConfigDefaults: () => ({ mode: "bypassPermissions" }) },
	);
	const tab = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 0, "已是更强 bypass 档时不得下发");
	assert.equal(manager.getSessionConfigOptions(tab.id)?.find((option) => option.id === "mode")?.currentValue, "fullAccess");
});

test("configOptions:历史会话已由启动参数定档 bypass 时，恢复不再下发（Qoder 拒绝运行期写）", async (t) => {
	const modeOption = {
		id: "mode",
		name: "Mode",
		category: "mode",
		type: "select",
		currentValue: "yolo",
		options: [
			{ value: "auto", name: "Auto" },
			{ value: "yolo", name: "Bypass Permissions" },
		],
	};
	const { manager, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				if (frame.method === "session/load") return { sessionId: "sess-old", configOptions: [modeOption] };
				return {};
			},
		},
		{
			getTools: () => [{ id: "qoder", name: "Qoder CLI", command: "qodercli", args: ["--acp", "--permission-mode", "bypass_permissions"], enabled: true, bypassPermissions: true }],
			getToolConfigDefaults: () => ({ mode: "auto" }),
		},
	);
	const tab = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: "qoder", acpSessionId: "sess-old" });
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 0, "已定档 bypass：既不得重放旧模式，也不得再试注定被拒的下发");
	assert.equal(manager.getSessionConfigOptions(tab.id)?.find((option) => option.id === "mode")?.currentValue, "yolo");
});

test("configOptions:session/load 恢复的会话不重放工具记忆", async (t) => {
	const { manager, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				if (frame.method === "session/load") return { configOptions: CONFIG_OPTIONS };
				if (frame.method === "session/new") return { sessionId: "sess-new", configOptions: CONFIG_OPTIONS };
				return {};
			},
		},
		{ getToolConfigDefaults: () => ({ effort: "high" }) },
	);
	await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-old" });
	assert.equal(lastProc().methodFrames("session/set_config_option").length, 0);
	assert.equal(lastProc().methodFrames("session/new").length, 0);
});

test("configOptions:用户切换思考档后写回记忆,模型切换不写", async (t) => {
	const remembered = [];
	const { manager, createAgent } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-mem2", configOptions: CONFIG_OPTIONS };
				if (frame.method === "session/set_config_option") {
					return { configOptions: CONFIG_OPTIONS.map((option) => (option.id === frame.params.configId ? { ...option, currentValue: frame.params.value } : option)) };
				}
				return {};
			},
		},
		{ rememberConfigOption: (toolId, optionId, value) => remembered.push({ toolId, optionId, value }) },
	);
	const tab = await createAgent();
	await manager.applyConfigOption(tab.id, "effort", "high");
	await manager.applyConfigOption(tab.id, "model", "o3");
	assert.deepEqual(remembered, [{ toolId: "gemini", optionId: "effort", value: "high" }]);
});

test("session/prompt 超时后补发 session/cancel：agent 侧旧回合必须收口，否则后续 prompt 永久排队", async (t) => {
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-timeout" };
				// session/prompt 永不应答：模拟 opencode 回合卡死（客户端超时 ≠ agent 侧回合结束）
				return undefined;
			},
		},
		{ promptTurnTimeoutMs: 40 },
	);
	const tab = await createAgent();
	const first = await manager.sendPrompt({ agentId: tab.id, message: "hello" });
	assert.equal(first.accepted, false);
	assert.match(first.error, /ACP request timed out after 40ms: session\/prompt/);
	// 回合超时带本地化描述符（#431）：人性化时长 + 配置键指引，原文留 debugDetails
	assert.equal(first.i18nKey, "acp.turnTimeout");
	assert.equal(first.i18nParams.tool, "Gemini CLI");
	assert.equal(first.i18nParams.minutes, "<1");
	assert.match(first.debugDetails, /ACP request timed out after 40ms: session\/prompt/);
	// 超时后必须补发 cancel，让 agent 收口旧回合（reason 固定 turn_timeout）
	await waitFor(() => lastProc().methodFrames("session/cancel").length === 1);
	const cancel = lastProc().methodFrames("session/cancel")[0];
	assert.equal(cancel.params.sessionId, "sess-timeout");
	assert.equal(cancel.params.reason, "turn_timeout");
	// 取消补发后 turnActive 已清：新 prompt 不再被「still responding」拒绝，能重新进入发送路径
	const second = await manager.sendPrompt({ agentId: tab.id, message: "again" });
	assert.equal(second.accepted, false);
	assert.match(second.error, /ACP request timed out after 40ms: session\/prompt/);
	assert.equal(lastProc().methodFrames("session/cancel").length, 2);
});

test("session/prompt 非超时拒绝（JSON-RPC 错误）不补发 session/cancel", async (t) => {
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-rpc" };
				if (frame.method === "session/prompt") return { __error: true, code: -32002, message: "turn in progress" };
				return {};
			},
		},
		{ promptTurnTimeoutMs: 5000 },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, false);
	assert.match(result.error, /turn in progress/);
	// 拒绝是 agent 即时应答：回合已在 agent 侧结束，再发 cancel 反而可能打断下一回合
	await sleep(120);
	assert.equal(lastProc().methodFrames("session/cancel").length, 0);
});

/**
 * 用户消息主进程侧落库（2026-10 用户反馈：ACP 时间线只有 AI 回复，用户消息不见了）。
 * ACP 的 user_message_chunk 是 agent 的可选回显，OpenCode 等根本不发；而 agents:message
 * 是全量替换语义，渲染层的乐观气泡会被第一次 flush 抹掉。
 */
test("sendPrompt:agent 成功结算但全程无输出时不得谎报成功或留下孤立用户消息", async (t) => {
	const { manager, events, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-silent-success" };
			if (frame.method === "session/prompt") return { stopReason: "end_turn" };
			return {};
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "不会得到回复" });
	assert.equal(result.accepted, false, "没有任何 assistant/tool 输出不能算发送成功");
	assert.equal(result.delivery, "rejected", "回合已确定结束且无产出，回填草稿可安全重发");
	assert.equal(result.i18nKey, "acp.emptyTurn");
	assert.equal(events.messages.at(-1).messages.length, 0, "空白回合必须撤回孤立用户消息，便于草稿回填重试");
});

test("空白回合:debugDetails 带出 CLI stderr / 非标准通知 / update 统计(限流等根因可见)", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-blank-diag" };
			if (frame.method === "session/prompt") {
				// 协议外通道报错：CLI 常把限流/登录失败塞在这里，而不是 session/update
				writeFromCli({ jsonrpc: "2.0", method: "session/error", params: { message: "quota exceeded" } });
				return { stopReason: "end_turn" };
			}
			return {};
		},
	});
	const tab = await createAgent();
	lastProc().proc.stderr.write("Error: account quota exceeded\n");
	await sleep(30);
	const result = await manager.sendPrompt({ agentId: tab.id, message: "不会得到回复" });
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "acp.emptyTurn");
	const details = result.debugDetails ?? "";
	assert.match(details, /account quota exceeded/, "CLI stderr 里的根因必须进 debugDetails");
	assert.match(details, /stopReason=end_turn/);
	assert.match(details, /updates=none/);
	assert.match(details, /session\/error/, "协议外通知同样要留下痕迹");
});

test("空白回合:非标准 update 类型在诊断里可见(区分「没发」与「发了我们没消费」)", async (t) => {
	const { manager, createAgent } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-blank-unknown" };
			if (frame.method === "session/prompt") {
				writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-blank-unknown", update: { sessionUpdate: "agent_message", text: "hi" } } });
				return { stopReason: "end_turn" };
			}
			return {};
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "不会得到回复" });
	assert.equal(result.i18nKey, "acp.emptyTurn");
	assert.match(result.debugDetails ?? "", /updates=agent_message/);
});

test("sendPrompt:agent 不回显 user chunk 时用户消息仍进投影,首条 prompt 兜底标题写回 catalog", async (t) => {
	const titles = [];
	const { manager, events, createAgent } = harness(
		t,
		{
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-echo" };
				if (frame.method === "session/prompt") {
					writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-echo", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "已收到" } } } });
					return { stopReason: "end_turn" }; // 不回显 user_message_chunk，但有正常 assistant 输出
				}
				return {};
			},
		},
		{ onTitleChanged: (deckSessionId, title) => titles.push({ deckSessionId, title }) },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "修复登录页面的 bug" });
	assert.equal(result.accepted, true);
	const flushed = events.messages.at(-1);
	const user = flushed.messages.find((message) => message.role === "user");
	assert.ok(user, "用户消息必须由主进程落进投影，不依赖 agent 回显");
	assert.equal(user.text, "修复登录页面的 bug");
	assert.equal(flushed.totalLength, flushed.messages.length);
	assert.deepEqual(titles, [{ deckSessionId: "deck-1", title: "修复登录页面的 bug" }], "首条 prompt 兜底标题必须写回 catalog（ACP 无本地会话文件）");
	// 第二条 prompt 不得把标题改掉（agent 后续给的标题仍可覆盖，见投影器单测）
	await manager.sendPrompt({ agentId: tab.id, message: "第二个问题" });
	assert.equal(titles.length, 1);
	assert.equal(events.messages.at(-1).messages.filter((message) => message.role === "user").length, 2);
});

test("sendPrompt 派发失败:撤回刚落的用户条目（不留没有回复的幽灵消息）", async (t) => {
	const { manager, events, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-fail" };
			if (frame.method === "session/prompt") return { __error: { code: -32000, message: "Authentication required" } };
			return {};
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "会被拒绝的消息" });
	assert.equal(result.accepted, false);
	const flushed = events.messages.at(-1);
	assert.equal(flushed.messages.filter((message) => message.role === "user").length, 0, "派发失败且 agent 未产出时必须撤回");
});

test("stall 看门狗:在途工具调用期间不判静默(等待工具是合法状态),工具收口后恢复判静默", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-tool-stall" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					// 长命令形态(npm install/构建/测试):tool_call 开始后到 completed 之间无任何流式输出
					writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-tool-stall", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", status: "pending" } } });
					return undefined;
				}
				return {};
			},
		},
		{ promptStallTimeoutMs: 80, abortEscalationMs: 50 },
	);
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "long running tool" });
	await waitFor(() => promptSeen, "prompt dispatched");
	await sleep(260); // 全静默远超阈值:在途工具调用豁免,不得 cancel/强杀
	assert.equal(lastProc().methodFrames("session/cancel").length, 0, "在途工具调用期间不得发 stall cancel");
	assert.equal(lastProc().proc.exitCode, null, "在途工具调用期间不得强杀进程");
	// 工具收口(终态出集)后全静默:静默基准已随 update 刷新,阈值重新起算,看门狗恢复开火
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-tool-stall", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
	await waitFor(() => lastProc().proc.exitCode === 0, "tool completed then stall force kill");
	const stallCancels = lastProc()
		.methodFrames("session/cancel")
		.filter((frame) => frame.params?.reason === "stall");
	assert.equal(stallCancels.length, 1, "工具收口后的新静默仍要被看门狗抓到");
	const result = await sendPromise;
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "acp.stallForceStopped");
});

test("stall 看门狗:省略 status 的 tool_call_update(工具流式输出)不清除在途豁免", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-tool-content" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-tool-content", update: { sessionUpdate: "tool_call", toolCallId: "tc-1", status: "in_progress" } } });
					return undefined;
				}
				return {};
			},
		},
		{ promptStallTimeoutMs: 80, abortEscalationMs: 50 },
	);
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "npm install" });
	await waitFor(() => promptSeen, "prompt dispatched");
	// 只带 content、省略 status 的补丁帧（ACP 规范：除 toolCallId 外字段全可选，工具流式输出就是这样）。
	// 它不代表工具收口，不得清除在途豁免。
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-tool-content", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", content: [{ type: "content", content: { type: "text", text: "added 120 packages" } }] } } });
	await sleep(260); // 补丁帧之后全静默：豁免必须还在，不得 cancel/强杀
	assert.equal(lastProc().methodFrames("session/cancel").length, 0, "省略 status 的 tool_call_update 不得清除在途豁免");
	assert.equal(lastProc().proc.exitCode, null, "省略 status 的 tool_call_update 后不得强杀进程");
	// 显式终态才出集：静默重新起算，看门狗恢复开火。
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-tool-content", update: { sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed" } } });
	await waitFor(() => lastProc().proc.exitCode === 0, "terminal status then stall force kill");
	const result = await sendPromise;
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "acp.stallForceStopped");
});

test("stall 看门狗:settings 读口实时生效(readAcpTimeoutSettings,变更后新回合即用,无需重启)", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-stall-settings" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					return undefined;
				}
				return {};
			},
		},
		// 不注入静态测试字段,只给 settings 读口:证明布防路径真的走到 settings 口径
		{ readAcpTimeoutSettings: () => ({ promptStallTimeoutMs: 80 }) },
	);
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "silent hang" });
	await waitFor(() => promptSeen, "prompt dispatched");
	await waitFor(
		() =>
			lastProc()
				.methodFrames("session/cancel")
				.some((frame) => frame.params?.reason === "stall"),
		"stall cancel via settings",
	);
	const result = await sendPromise;
	assert.equal(result.accepted, false);
	assert.equal(result.i18nKey, "acp.stallForceStopped");
});

test("session/prompt 兑底超时:settings 读口生效(readAcpTimeoutSettings.promptTurnTimeoutMs)", async (t) => {
	let promptSeen = false;
	const { manager, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-turn-timeout-settings" };
				if (frame.method === "session/prompt") {
					promptSeen = true;
					return undefined;
				}
				return {};
			},
		},
		{ readAcpTimeoutSettings: () => ({ promptTurnTimeoutMs: 40 }) },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hang" });
	await waitFor(() => promptSeen, "prompt dispatched");
	assert.equal(result.accepted, false);
	assert.match(result.error, /ACP request timed out after 40ms: session\/prompt/);
	// settings 读口路径同样要带描述符：否则用户只看到「600000ms」这种搜不出配置键的裸文本（#431）
	assert.equal(result.i18nKey, "acp.turnTimeout");
	assert.equal(result.i18nParams.minutes, "<1");
	await waitFor(() => lastProc().methodFrames("session/cancel").length === 1);
	assert.equal(lastProc().methodFrames("session/cancel")[0].params.reason, "turn_timeout");
});

test("回合超时文案:时长按分钟人性化 + 只认超时错误(其余错误不挂描述符)", () => {
	// loadTsCommonJs 每次调用是独立模块注册表（vm 独立 realm），跨调用 instanceof 必失配：
	// 这里用 stubs 把 ./AcpConnection 替成同注册表内的类，专注测「时长格式化与键选择」。
	// 真实 AcpTimeoutError 的身份匹配由上面的 manager 级用例（含 i18nKey/minutes 断言）覆盖。
	class StubAcpTimeoutError extends Error {
		constructor(method, timeoutMs) {
			super(`ACP request timed out after ${timeoutMs}ms: ${method}`);
			this.name = "AcpTimeoutError";
			this.method = method;
			this.timeoutMs = timeoutMs;
		}
	}
	class StubAcpRpcError extends Error {}
	const { formatTurnTimeoutMinutes, promptTurnTimeoutDescriptor, startupTimeoutDescriptor } = loadTsCommonJs("src/main/acp/acpFailureDescriptors.ts", {
		stubs: { "./AcpConnection": { AcpTimeoutError: StubAcpTimeoutError, AcpRpcError: StubAcpRpcError } },
	});
	const tool = { id: "cb", name: "CodeBuddy", command: "codebuddy", args: [], enabled: true };

	// 默认 10min / 自定义整分钟 / 亚分钟 / 非整分钟
	assert.equal(formatTurnTimeoutMinutes(600_000), "10");
	assert.equal(formatTurnTimeoutMinutes(3_600_000), "60");
	assert.equal(formatTurnTimeoutMinutes(40), "<1");
	assert.equal(formatTurnTimeoutMinutes(90_000), "1.5");

	// 逐字段断言：对象来自 vm 独立 realm，deepEqual 会因 prototype 不同而失配
	const descriptor = promptTurnTimeoutDescriptor(new StubAcpTimeoutError("session/prompt", 600_000), tool);
	assert.equal(descriptor.i18nKey, "acp.turnTimeout");
	assert.equal(descriptor.i18nParams.tool, "CodeBuddy");
	assert.equal(descriptor.i18nParams.minutes, "10");
	// debugDetails 保留原文（ms 与 method）：本地化文案是概括，排查要靠它
	assert.equal(descriptor.debugDetails, "ACP request timed out after 600000ms: session/prompt");

	// 非超时错误不挂回合超时描述符；create 阶段的握手超时仍归 acp.startupTimeout，两键互不串
	assert.equal(promptTurnTimeoutDescriptor(new Error("boom"), tool), undefined);
	assert.equal(startupTimeoutDescriptor(new StubAcpTimeoutError("initialize", 60_000), tool).i18nKey, "acp.startupTimeout");
});

// ── #415 MVP：deck 侧归档（userData/acp-sessions）接线 ─────────────────────────
// 归档的三件事必须在 manager 生命周期里正确定位：
// 1) create 带 acpSessionId 且内存快照为空 → 握手**之前**回灌快照（seedMessages 读它）；
// 2) 回合结算后落盘（拿 settle 后的投影），不是 80ms flush；
// 3) IPC/Web 读口 miss 时回退归档（同步读口保持只覆盖内存）。

/** 建一个临时 userData 根 + 归档实例（真实 fs，不 mock）。 */
async function tempArchiveHarness(t) {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { AcpSessionArchive } = loadTsCommonJs("src/main/acp/AcpSessionArchive.ts");
	const root = await mkdtemp(join(tmpdir(), "pideck-acp-archive-wiring-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	return new AcpSessionArchive({ userDataDir: root });
}

/** 上一代进程留下的归档消息（重启后内存快照为空，只有它在）。 */
function archivedMessages(texts) {
	return texts.map((text, index) => ({
		id: `acp:archived-${index + 1}`,
		agentId: "acp:previous-process",
		role: index === 0 ? "user" : "assistant",
		text,
		timestamp: 1_700_000_000_000 + index,
	}));
}

test("归档恢复:create 带 acpSessionId 且内存快照为空时从归档回灌(握手 seedMessages 之前)", async (t) => {
	const archive = await tempArchiveHarness(t);
	await archive.save("sess-archived", archivedMessages(["持久化的提问", "持久化的回答"]));
	// 记录 create 期间的归档写入：握手（load 重放/回灌）完成后要立刻留一份副本，不等回合结算。
	const persistedDuringCreate = [];
	const archiveSpy = {
		read: (id) => archive.read(id),
		enqueueSave: (id, messages) => {
			persistedDuringCreate.push((messages ?? []).map((entry) => entry.text).join("|"));
			return archive.enqueueSave(id, messages);
		},
	};
	const { manager, events } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-archived" };
				return {};
			},
		},
		{ archive: archiveSpy },
	);
	const tab = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-archived", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-archived" });
	assert.equal(tab.status, "idle");
	// 回灌若晚于握手，seedMessages 读到空数组，create 末尾的全量 flush 就只有空投影。
	// 这里断言 create 返回时时间线已经带着归档历史（无 loadSession 能力的 CLI 只能播种）。
	const flushed = events.messages.at(-1);
	assert.equal(flushed?.agentId, tab.id);
	assert.equal((flushed.messages ?? []).map((entry) => entry.text).join("|"), "持久化的提问|持久化的回答");
	// 内存快照同源（重入会话不再空白）
	assert.equal(manager.readMessagesByAcpSessionId("sess-archived").length, 2);
	assert.equal((await manager.readMessagesWithArchive("sess-archived")).length, 2);
	// create 末尾的持久化：写的是回灌后的投影（不是空投影，也不是内存快照的旧引用）
	assert.equal(persistedDuringCreate.at(-1), "持久化的提问|持久化的回答", "create 完成即留归档副本");
});

test("回合结算后落盘:归档文件出现,内容 = settle 后的投影消息", async (t) => {
	const archive = await tempArchiveHarness(t);
	const { manager, events, createAgent } = harness(
		t,
		{
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-persist" };
				if (frame.method === "session/prompt") {
					writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-persist", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "存进归档的回答" } } } });
					return { stopReason: "end_turn" };
				}
				return {};
			},
		},
		{ archive },
	);
	const tab = await createAgent();
	// 新会话 create 时投影为空（归档里也没有它）：空快照不得凭空造一份空归档
	assert.equal((await archive.read("sess-persist")).length, 0, "空投影不在 create 时写盘");
	const result = await manager.sendPrompt({ agentId: tab.id, message: "写进归档的提问" });
	assert.equal(result.accepted, true);
	await waitFor(() => (events.messages.at(-1)?.messages ?? []).length >= 2, "turn flushed");
	// 结算点写盘是 await 的：sendPrompt 返回时归档文件已经在盘上（崩在下一回合前也不丢）
	const persisted = await archive.read("sess-persist");
	assert.ok(persisted.length >= 2, `归档应含 user+assistant（实际 ${persisted.length}）`);
	assert.equal(persisted.filter((entry) => entry.role === "user")[0]?.text, "写进归档的提问");
	assert.equal(persisted.filter((entry) => entry.role === "assistant").at(-1)?.text, "存进归档的回答");
	// 归档内容必须与投影逐条对齐（写的是 settle 后的投影，不是中间态）
	const projected = manager.readMessages(tab.id);
	assert.equal(persisted.map((entry) => entry.id).join(","), projected.map((entry) => entry.id).join(","));
	// 异步读口内存优先：runtime 在场时不需要碰磁盘
	assert.equal((await manager.readMessagesWithArchive("sess-persist")).map((entry) => entry.id).join(","), projected.map((entry) => entry.id).join(","));
});

test("异步读口 readMessagesWithArchive:内存 miss 时回退归档(同步读口只覆盖内存)", async (t) => {
	const archive = await tempArchiveHarness(t);
	await archive.save("sess-disk-only", archivedMessages(["只有磁盘上有的提问", "只有磁盘上有的回答"]));
	const { manager } = harness(t, { handler: () => undefined }, { archive });
	// 同步读口是既有内存契约：没有 runtime/快照就是空（历史用例按同步断言）
	assert.equal(manager.readMessagesByAcpSessionId("sess-disk-only").length, 0);
	// 异步读口（sessionIpc/Web 的读路径）回退归档
	const restored = await manager.readMessagesWithArchive("sess-disk-only");
	assert.equal(restored.map((entry) => entry.text).join("|"), "只有磁盘上有的提问|只有磁盘上有的回答");
	// 未归档过的会话仍是空，不抛
	assert.equal((await manager.readMessagesWithArchive("sess-never")).length, 0);
});

test("归档回灌不按 400 条内存快照裁剪:重开长会话拿到完整归档(时间线/分页/会话内查找都不被截断)", async (t) => {
	const archive = await tempArchiveHarness(t);
	// 500 条 > MESSAGE_SNAPSHOT_LIMIT(400)：走 set() 回灌会丢掉前 100 条
	const longHistory = archivedMessages(Array.from({ length: 500 }, (_, index) => `历史消息 ${index + 1}`));
	await archive.save("sess-long", longHistory);
	const { manager } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: { loadSession: false } };
				if (frame.method === "session/new") return { sessionId: "sess-long" };
				return {};
			},
		},
		{ archive },
	);
	const tab = await manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-long", backend: "acp", agentPreset: "gemini", acpSessionId: "sess-long" });
	const projected = manager.readMessages(tab.id);
	assert.equal(projected.length, 500, "回灌必须完整（不能被 400 条流式上限裁掉前 100 条）");
	assert.equal(projected[0].text, "历史消息 1");
	assert.equal(projected.at(-1).text, "历史消息 500");
	// runtime 在场时异步读口走投影，同样是完整历史
	assert.equal((await manager.readMessagesWithArchive("sess-long")).length, 500);
	// stop 之后 runtime 消失：异步读口要拿归档（完整）而不是 ≤400 条的内存快照
	await manager.stop(tab.id);
	assert.equal(manager.readMessagesByAcpSessionId("sess-long").length, 400, "同步读口仍然是内存快照契约（≤400）");
	assert.equal((await manager.readMessagesWithArchive("sess-long")).length, 500, "异步读口归档优先：分页与会话内查找要能看到完整历史");
});

test("成功收口触发 onAgentSettled；用户停止不触发", async (t) => {
	let promptRpcId = null;
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-settle" };
			if (frame.method === "session/prompt") {
				promptRpcId = frame.id;
				return undefined;
			}
			return {};
		},
	});
	const settled = [];
	manager.onAgentSettled((info) => settled.push(info));
	const tab = await createAgent();

	// 正常回合：有输出 + end_turn → 触发一次
	const first = manager.sendPrompt({ agentId: tab.id, message: "hi" });
	await waitFor(() => promptRpcId !== null, "prompt dispatched");
	lastProc().writeFromCli({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: "sess-settle", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } },
	});
	lastProc().writeFromCli({ jsonrpc: "2.0", id: promptRpcId, result: { stopReason: "end_turn" } });
	assert.equal((await first).accepted, true);
	// 标题由首条用户消息派生（applyProjectionTitle），完成信号带的是当时的真实标题
	assert.equal(settled.length, 1);
	assert.equal(settled[0].agentId, tab.id);
	assert.equal(settled[0].title, "hi");

	// 用户停止：本轮收口但不算完成（与 pi 的 agent_settled 语义一致）
	promptRpcId = null;
	const second = manager.sendPrompt({ agentId: tab.id, message: "again" });
	await waitFor(() => promptRpcId !== null, "second prompt dispatched");
	lastProc().writeFromCli({
		jsonrpc: "2.0",
		method: "session/update",
		params: { sessionId: "sess-settle", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } },
	});
	await manager.abort(tab.id);
	lastProc().writeFromCli({ jsonrpc: "2.0", id: promptRpcId, result: { stopReason: "cancelled" } });
	assert.equal((await second).accepted, true);
	assert.equal(settled.length, 1, "用户停止不得触发完成信号");
});

test("Ask 通知：每轮只提醒一次，未弹出（开关关着）不占用去重位", async (t) => {
	const asks = [];
	let shown = false;
	const { manager, createAgent } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-ask" };
				if (frame.method === "session/prompt") return { stopReason: "end_turn" };
				return {};
			},
		},
		{
			notify: {
				askPending: (input) => {
					asks.push(input);
					return shown;
				},
			},
		},
	);
	const tab = await createAgent();
	// 开关关着（askPending 返回 false）：不占去重位，用户中途打开开关仍能收到当前提问
	manager.notifyAskPending(tab.id, "deck-1", "标题", "问题 1");
	manager.notifyAskPending(tab.id, "deck-1", "标题", "问题 2");
	assert.equal(asks.length, 2);
	// 开关打开后同一轮只提醒一次
	shown = true;
	manager.notifyAskPending(tab.id, "deck-1", "标题", "问题 3");
	manager.notifyAskPending(tab.id, "deck-1", "标题", "问题 4");
	assert.equal(asks.length, 3);
	// 新回合开始：去重复位（空回合被拒不影响复位）
	await manager.sendPrompt({ agentId: tab.id, message: "next" });
	manager.notifyAskPending(tab.id, "deck-1", "标题", "问题 5");
	assert.equal(asks.length, 4);
});

test("用量:session/prompt 的 usage 与本地计时进 runtime 状态（ACP 圆环面板数据源）", async (t) => {
	// Qoder 实测形态：响应 usage 只有 input/output（没有缓存拆分），
	// 因此 token 与 TPS 必须有值，缓存/命中率必须整组缺省（不能是假 0）。
	let promptRpcId = null;
	const { manager, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-usage" };
			if (frame.method === "session/prompt") {
				promptRpcId = frame.id;
				return undefined; // 先推流式 chunk，再手动结算（模拟真实 CLI）
			}
			return {};
		},
	});
	const tab = await createAgent();
	const sendPromise = manager.sendPrompt({ agentId: tab.id, message: "hi" });
	await waitFor(() => promptRpcId !== null, "session/prompt dispatched");
	lastProc().writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "sess-usage", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hello" } } } });
	// 留出解码窗口（>0）再结算，TPS 才有意义。
	await sleep(30);
	lastProc().writeFromCli({ jsonrpc: "2.0", id: promptRpcId, result: { stopReason: "end_turn", usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 } } });
	const result = await sendPromise;
	assert.equal(result.accepted, true);
	const state = await manager.getRuntimeState(tab.id);
	assert.equal(state.inputTokens, 120);
	assert.equal(state.outputTokens, 40);
	assert.equal(state.cacheRead, undefined, "未上报缓存时不能显示 0");
	assert.equal(state.cacheHitPercent, undefined);
	assert.equal(typeof state.ttftMs, "number", "首个正文 chunk 到达即有 TTFT");
	assert.ok(state.totalMs >= 30, "总耗时覆盖整个回合");
	assert.ok(state.tps > 0, "有 output tokens 与解码窗口即算 TPS");
	assert.ok(state.sessionTps > 0, "会话平均 TPS 同步累计");
});

test("自动重试:本回合无产出 + 瞬时故障 → 重发同一 prompt,重试卡收敛为成功", async (t) => {
	let attempts = 0;
	const { manager, events, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-retry" };
				if (frame.method === "session/prompt") {
					attempts += 1;
					// 首次失败：网关/undici 断连在 pi 的白名单里认不出，ACP 里则是这一层兜住的
					if (attempts === 1) return { __error: true, code: -32603, message: "upstream request failed: read ECONNRESET" };
					writeFromCli({
						jsonrpc: "2.0",
						method: "session/update",
						params: { sessionId: "sess-retry", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
					});
					return { stopReason: "end_turn" };
				}
				return {};
			},
		},
		// 退避基数取下限 200ms（生产默认 2s）：用例仍走真实 awaitRetryDelay 路径，只是等得短
		{ readAcpTurnRetrySettings: () => ({ baseDelayMs: 200, maxRetries: 2 }) },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, true, "瞬时故障后应自动重试成功");
	assert.equal(attempts, 2, "第一次失败后应重发一次");
	const prompts = lastProc().methodFrames("session/prompt");
	assert.equal(prompts.length, 2);
	assert.deepEqual(prompts[1].params.prompt, prompts[0].params.prompt, "重发必须是同一个 prompt");
	await waitFor(() => (events.messages.at(-1)?.messages ?? []).some((message) => message.meta?.i18nKey === "diagnostic.retrySucceeded"), "retry card settled");
	const messages = events.messages.at(-1).messages;
	assert.equal(messages.filter((message) => message.role === "user").length, 1, "重发不得重复落用户气泡");
	const retryCards = messages.filter((message) => String(message.meta?.i18nKey ?? "").startsWith("diagnostic.retry"));
	assert.equal(retryCards.length, 1, "同一回合只保留一张重试卡（原地推进）");
	assert.equal(retryCards[0].meta.status, "success");
	assert.equal(retryCards[0].meta.attempt, 1);
	assert.equal(messages.filter((message) => message.role === "assistant").length, 1, "只留成功那次尝试的回复");
});

test("自动重试:本回合已产出内容时失败不重发(避免 agent 重复执行工具)", async (t) => {
	let attempts = 0;
	const { manager, createAgent } = harness(t, {
		handler: (frame, { writeFromCli }) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-output" };
			if (frame.method === "session/prompt") {
				attempts += 1;
				writeFromCli({
					jsonrpc: "2.0",
					method: "session/update",
					params: { sessionId: "sess-output", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } } },
				});
				return { __error: true, code: -32603, message: "read ECONNRESET" };
			}
			return {};
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "unknown", "已有产出：是否被处理不可知，不回填草稿");
	assert.equal(attempts, 1, "有产出就不允许重发");
});

test("自动重试:鉴权失败是硬终局,不浪费重试", async (t) => {
	let attempts = 0;
	const { manager, createAgent } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-auth" };
			if (frame.method === "session/prompt") {
				attempts += 1;
				return { __error: true, code: -32603, message: "401 Unauthorized: invalid api key" };
			}
			return {};
		},
	});
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, false);
	assert.equal(attempts, 1);
});

test("自动重试:已发出审批请求的工具回合算「已开动」，失败不重发", async (t) => {
	const { manager, events, createAgent, lastProc } = harness(t, {
		handler: (frame) => {
			if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
			if (frame.method === "session/new") return { sessionId: "sess-perm-retry" };
			if (frame.method === "session/prompt") return undefined; // 挂起：审批中途失败
			return {};
		},
	});
	const tab = await createAgent();
	const sending = manager.sendPrompt({ agentId: tab.id, message: "run the tool" });
	await waitFor(() => lastProc().methodFrames("session/prompt").length === 1, "prompt dispatched");
	lastProc().writeFromCli({
		jsonrpc: "2.0",
		id: "approval-retry",
		method: "session/request_permission",
		params: { sessionId: "sess-perm-retry", toolCall: { toolCallId: "call" }, options: [{ optionId: "once", name: "Allow", kind: "allow_once" }] },
	});
	await waitFor(() => events.uiRequests.some((event) => event.method === "select"), "permission surfaced");
	const promptFrame = lastProc().methodFrames("session/prompt")[0];
	lastProc().writeFromCli({ jsonrpc: "2.0", id: promptFrame.id, error: { code: -32603, message: "read ECONNRESET" } });
	const result = await sending;
	assert.equal(result.accepted, false);
	assert.equal(lastProc().methodFrames("session/prompt").length, 1, "CLI 已在等审批（可能已在执行工具），重发会重复执行");
});

test("自动重试:重试用尽后卡片收口为失败态，用户气泡撤回但卡片保留", async (t) => {
	let attempts = 0;
	const { manager, events, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
				if (frame.method === "session/new") return { sessionId: "sess-exhausted" };
				if (frame.method === "session/prompt") {
					attempts += 1;
					return { __error: true, code: -32603, message: "read ECONNRESET" };
				}
				return {};
			},
		},
		{ readAcpTurnRetrySettings: () => ({ maxRetries: 1, baseDelayMs: 200 }) },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, false);
	assert.equal(result.delivery, "rejected", "全程无产出：可以安全回填草稿");
	assert.equal(attempts, 2, "首次 + 一次重试");
	assert.equal(lastProc().methodFrames("session/prompt").length, 2);
	const messages = events.messages.at(-1).messages;
	const retryCards = messages.filter((message) => String(message.meta?.i18nKey ?? "").startsWith("diagnostic.retry"));
	assert.equal(retryCards.length, 1, "卡片保留下来（用户要知道重试过）");
	assert.equal(retryCards[0].meta.status, "error");
	assert.equal(retryCards[0].meta.attempt, 1);
	assert.equal(messages.filter((message) => message.role === "user").length, 0, "孤立用户气泡已撤回，卡片不受影响");
});

test("断线重连:进程死亡 + 本回合无动静 → 原地重连(同一 agentId)、用原 session 续历史并重派同一 prompt", async (t) => {
	let promptCalls = 0;
	let initializeCalls = 0;
	const { manager, events, createAgent, lastProc, procs } = harness(
		t,
		{
			handler: (frame, { writeFromCli }) => {
				if (frame.method === "initialize") {
					initializeCalls += 1;
					// 断线重连靠 loadSession 续 agent 侧历史，能力必须声明
					return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				}
				if (frame.method === "session/load") return {};
				if (frame.method === "session/new") return { sessionId: "sess-live" };
				if (frame.method === "session/prompt") {
					promptCalls += 1;
					if (promptCalls === 1) {
						// 派发后进程立刻死掉（CLI 崩溃/网关掐连接）：这一帧永远不会有响应
						setImmediate(() => {
							const cli = lastProc();
							cli.proc.emit("exit", 1, null);
							cli.proc.emit("close", 1, null);
						});
						return undefined;
					}
					writeFromCli({
						jsonrpc: "2.0",
						method: "session/update",
						params: { sessionId: "sess-live", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "recovered" } } },
					});
					return { stopReason: "end_turn" };
				}
				return {};
			},
		},
		{ readAcpTurnRetrySettings: () => ({ baseDelayMs: 200, maxRetries: 2 }) },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "long task" });
	assert.equal(result.accepted, true, "重连成功后应重派并完成回合");
	assert.equal(promptCalls, 2, "第一次派发随进程死亡，重连后重派一次");
	assert.equal(initializeCalls, 2, "重连要重新握手一次");
	assert.equal(procs.length, 2, "重连换进程，但不换会话身份");
	const listed = manager.list();
	assert.equal(listed.length, 1, "原地重连：不得多出一个 agent");
	assert.equal(listed[0].id, tab.id, "agentId 保持不变（catalog/会话绑定不需要迁移）");
	const respawned = lastProc();
	assert.equal(respawned.methodFrames("session/load").length, 1, "重连要用原 acpSessionId 走 session/load");
	assert.equal(respawned.methodFrames("session/load")[0].params.sessionId, "sess-live");
	const prompts = respawned.methodFrames("session/prompt");
	assert.equal(prompts.length, 1);
	assert.equal(prompts[0].params.sessionId, "sess-live", "重派必须落在同一个 agent 侧会话上");
	await waitFor(() => (events.messages.at(-1)?.messages ?? []).some((message) => message.meta?.i18nKey === "diagnostic.retrySucceeded"), "retry card settled");
	const messages = events.messages.at(-1).messages;
	assert.equal(messages.filter((message) => message.role === "user").length, 1, "重连不得重复落用户气泡");
	const retryCards = messages.filter((message) => String(message.meta?.i18nKey ?? "").startsWith("diagnostic.retry"));
	assert.equal(retryCards.length, 1, "同一回合只保留一张重试卡");
	assert.equal(retryCards[0].meta.status, "success");
});

test("断线重连:重连握手失败 → 按原失败收口，历史投影还原、气泡撤回、卡片留失败态", async (t) => {
	let promptCalls = 0;
	let initializeCalls = 0;
	const { manager, events, createAgent, lastProc } = harness(
		t,
		{
			handler: (frame) => {
				if (frame.method === "initialize") {
					initializeCalls += 1;
					// 重连那次握手直接报不兼容，模拟 CLI 起不来 / 版本不对
					if (initializeCalls > 1) return { protocolVersion: 999, agentCapabilities: {} };
					return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
				}
				if (frame.method === "session/load") return {};
				if (frame.method === "session/new") return { sessionId: "sess-dead" };
				if (frame.method === "session/prompt") {
					promptCalls += 1;
					if (promptCalls === 1) {
						setImmediate(() => {
							const cli = lastProc();
							cli.proc.emit("exit", 1, null);
							cli.proc.emit("close", 1, null);
						});
						return undefined;
					}
					return { stopReason: "end_turn" };
				}
				return {};
			},
		},
		{ readAcpTurnRetrySettings: () => ({ baseDelayMs: 200, maxRetries: 2 }) },
	);
	const tab = await createAgent();
	const result = await manager.sendPrompt({ agentId: tab.id, message: "hi" });
	assert.equal(result.accepted, false);
	assert.equal(initializeCalls, 2, "尝试过一次重连握手");
	assert.equal(promptCalls, 1, "重连失败不得再派发");
	const messages = events.messages.at(-1).messages;
	assert.equal(messages.filter((message) => message.role === "user").length, 0, "失败回合的用户气泡已撤回");
	const retryCards = messages.filter((message) => String(message.meta?.i18nKey ?? "").startsWith("diagnostic.retry"));
	assert.equal(retryCards.length, 1, "重试卡保留并收口为失败");
	assert.equal(retryCards[0].meta.status, "error");
});
