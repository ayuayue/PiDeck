/** ACP 停止必须给 CLI 一个有序退出窗口（issue #475）：关 stdin → 宽限 → 才整树强杀。 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { harness } from "./helpers/acpAgentHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

function basicHandler(frame) {
	if (frame.method === "initialize") return { protocolVersion: 1, agentCapabilities: {} };
	if (frame.method === "session/new") return { sessionId: "session-1" };
	return undefined;
}

/** Windows 树杀出口的替身：spawn("taskkill", [..., pid, ...]) 时杀掉对应假进程并记账。 */
function taskkillStub(kills, findProc) {
	const killer = Object.assign(new EventEmitter(), { pid: 9999, exitCode: 0, kill() {} });
	return {
		"node:child_process": {
			spawn: (command, args) => {
				if (command === "taskkill") {
					kills.push(args);
					findProc(Number(args?.[1]))?.kill();
				}
				return killer;
			},
		},
	};
}

/** stdin 关掉后按 onStdinEnd 决定是否自行退出（模拟跑完 SessionEnd 钩子的 CLI）。 */
function fakeProc({ exitsOnStdinEnd = false } = {}) {
	const stdin = new PassThrough();
	const proc = Object.assign(new EventEmitter(), {
		stdin,
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		pid: 4321,
		exitCode: null,
		signalCode: null,
		killCalls: 0,
		kill() {
			proc.killCalls += 1;
			proc.exitCode = 0;
		},
	});
	if (exitsOnStdinEnd) {
		stdin.on("finish", () => {
			if (proc.exitCode !== null) return;
			proc.exitCode = 0;
			proc.emit("exit", 0, null);
		});
	}
	return proc;
}

test("有序停止：先关 stdin，CLI 自行退出时不做进程树强杀", async () => {
	const kills = [];
	let proc;
	const { shutdownAcpProcess } = loadTsCommonJs("src/main/acp/AcpProcessHost.ts", { stubs: taskkillStub(kills, () => proc) });
	proc = fakeProc({ exitsOnStdinEnd: true });
	await shutdownAcpProcess(proc, { platform: "win32", gracefulExitMs: 5_000 });
	assert.equal(proc.stdin.writableEnded, true, "必须先关 stdin 让 CLI 收到 EOF");
	assert.equal(kills.length, 0, "宽限内自行退出不应强杀");
	assert.equal(proc.killCalls, 0);
});

test("有序停止：宽限到点仍未退出才 taskkill /T /F", async () => {
	const kills = [];
	let proc;
	const { shutdownAcpProcess } = loadTsCommonJs("src/main/acp/AcpProcessHost.ts", { stubs: taskkillStub(kills, () => proc) });
	proc = fakeProc();
	await shutdownAcpProcess(proc, { platform: "win32", gracefulExitMs: 20 });
	assert.equal(proc.stdin.writableEnded, true, "强杀前也必须先关 stdin");
	assert.equal(kills.length, 1, "宽限结束要按进程树强杀");
	// 参数来自 VM 上下文（Array 原型不同），按文本比对而不是 deepEqual。
	assert.equal(kills[0].join(" "), "/pid 4321 /T /F");
	assert.equal(proc.killCalls, 1);
});

test("有序停止：进程已退出时既不关 stdin 也不强杀", async () => {
	const kills = [];
	let proc;
	const { shutdownAcpProcess } = loadTsCommonJs("src/main/acp/AcpProcessHost.ts", { stubs: taskkillStub(kills, () => proc) });
	proc = fakeProc();
	proc.exitCode = 0;
	await shutdownAcpProcess(proc, { platform: "win32", gracefulExitMs: 5 });
	assert.equal(proc.stdin.writableEnded, false);
	assert.equal(kills.length, 0);
});

test("非 Windows 保持原停止语义（SIGTERM 已是优雅信号，不多等宽限）", async () => {
	const kills = [];
	let proc;
	const { shutdownAcpProcess } = loadTsCommonJs("src/main/acp/AcpProcessHost.ts", { stubs: taskkillStub(kills, () => proc) });
	proc = fakeProc();
	await shutdownAcpProcess(proc, { platform: "linux", gracefulExitMs: 5_000 });
	assert.equal(proc.killCalls, 1);
	assert.equal(proc.stdin.writableEnded, false);
});

test("manager.stop 让 CLI 收到 stdin EOF，并在返回前完成进程收尾", async (t) => {
	const { manager, createAgent, lastProc } = harness(t, { handler: basicHandler }, { gracefulExitMs: 20 });
	const tab = await createAgent();
	const proc = lastProc().proc;
	assert.equal(proc.stdin.writableEnded, false);
	await manager.stop(tab.id);
	assert.equal(proc.stdin.writableEnded, true, "停止必须给 CLI 有序退出窗口（#475）");
	assert.notEqual(proc.exitCode, null, "stop 返回时进程必须已经收掉（否则退出路径会留下孤儿）");
	assert.equal(manager.list().length, 0);
});
