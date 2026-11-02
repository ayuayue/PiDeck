/** In-memory ACP CLI: exercise the production transport and manager without launching an external agent. */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { loadTsCommonJs } from "./loadTsCommonJs.mjs";

export async function waitFor(predicate, label = "condition") {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.fail(`timeout waiting for ${label}`);
}

function fakeAgentProcess(t, { handler = () => undefined } = {}) {
	const stdin = new PassThrough();
	const stdout = new PassThrough();
	const stderr = new PassThrough();
	const frames = [];
	const writeFromCli = (obj) => stdout.write(`${JSON.stringify(obj)}\n`);
	stdin.on("data", (chunk) => {
		for (const line of chunk.toString("utf8").split("\n")) {
			if (!line.trim()) continue;
			const frame = JSON.parse(line);
			frames.push(frame);
			if (frame.method && frame.id !== undefined) {
				const outcome = handler(frame, { writeFromCli });
				if (outcome?.__error) {
					writeFromCli({ jsonrpc: "2.0", id: frame.id, error: { code: outcome.code ?? -32000, message: outcome.message ?? "fail" } });
				} else if (outcome !== undefined) {
					writeFromCli({ jsonrpc: "2.0", id: frame.id, result: outcome });
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
		stdin.destroy();
		stdout.destroy();
		stderr.destroy();
	});
	return { proc, frames, writeFromCli, methodFrames: (method) => frames.filter((frame) => frame.method === method) };
}

export function harness(t, cliOptions, depsExtra = {}) {
	const events = { uiRequests: [], messages: [], runtimeStates: [] };
	const procs = [];
	const spawnCalls = [];
	const { AcpAgentManager } = loadTsCommonJs("src/main/acp/AcpAgentManager.ts", {
		stubs: {
			"node:child_process": {
				spawn: (command, args, options) => {
					// Windows 树杀出口:同步模拟 taskkill(匹配 pid 且未退出的 fake 进程),
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
		// 有序停止宽限：生产默认 1.5s（等 CLI 自己跑 SessionEnd），单测用毫秒级避免每个
		// 会话停止都多等一个宽限窗口；需要验证宽限行为的用例在 depsExtra 里覆盖。
		gracefulExitMs: 5,
		...depsExtra,
	});
	const unsubscribe = manager.onOutput((channel, payload) => {
		if (channel === "agents:ui-request") events.uiRequests.push(payload);
		if (channel === "agents:message") events.messages.push(payload);
		if (channel === "agents:runtime-state") events.runtimeStates.push(payload);
	});
	t.after(async () => {
		unsubscribe();
		await manager.stopAll();
	});
	const createAgent = async (preset = "gemini") => manager.create({ projectId: "p1", title: "t", deckSessionId: "deck-1", backend: "acp", agentPreset: preset });
	return { manager, events, spawnCalls, createAgent, procs, lastProc: () => procs[procs.length - 1] };
}

export function sessionUpdate(writeFromCli, sessionId, update) {
	writeFromCli({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
}
