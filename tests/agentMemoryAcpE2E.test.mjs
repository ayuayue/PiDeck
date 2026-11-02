/**
 * ACP 记忆挂载的真进程端到端守卫。
 *
 * 单测里已验证 `buildAcpMcpServers` 的形状，那只能证明「我们算对了」。真正的风险在
 * 进程边界：agent 收到 `{name, command, args, env}` 之后要能用它起一个 MCP 服务器并列出工具。
 * 这里用一个假 ACP agent（tests/fixtures/acpMemoryStub.mjs，真子进程 + 真 NDJSON stdio）
 * 收下 session/new，照真实 CLI 的做法把服务器拉起来做 initialize + tools/list。
 *
 * 为什么不用真的 codex-acp：那需要模型凭据与网络，还会真的花额度；而这里要证明的
 * 只是「挂载描述在真进程里可执行」。ADR 里写明这条边界。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AcpConnection } = loadTsCommonJs("src/main/acp/AcpConnection.ts");
const { performAcpHandshake } = loadTsCommonJs("src/main/acp/AcpHandshake.ts");
const { buildAcpMcpServers, buildAgentMemoryMount, AGENT_MEMORY_SERVER_NAME } = loadTsCommonJs("src/main/agentMemory/agentMemoryMounts.ts");

const STUB = join(process.cwd(), "tests", "fixtures", "acpMemoryStub.mjs");
const SERVER = join(process.cwd(), "resources", "agent-memory", "server.mjs");

/** 握手只需要 runtime 的几个字段；这里给最小替身，不构造完整 AcpAgentManager。 */
function stubRuntime(conn) {
	return {
		conn,
		tab: { id: "tab-1", name: "ACP", tool: { name: "stub" } },
		tool: { name: "stub" },
		status: "ready",
		reloading: false,
		acpSessionId: "",
		projection: { messages: [], status: "idle" },
		updateChain: Promise.resolve(),
	};
}

test("ACP 真进程：session/new 的 mcpServers 能被 agent 起成 MCP 服务器并列出记忆工具", async (t) => {
	const memoryDir = mkdtempSync(join(tmpdir(), "pideck-acp-memory-"));
	const outFile = join(memoryDir, "stub-received.json");
	const proc = spawn(process.execPath, [STUB], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ACP_STUB_OUT: outFile, NODE_NO_WARNINGS: "1" },
		windowsHide: true,
	});
	t.after(() => proc.kill());
	const conn = new AcpConnection(proc.stdin, proc.stdout);
	t.after(() => conn.close());

	const mount = buildAgentMemoryMount({
		execPath: process.execPath,
		scriptPath: SERVER,
		memoryDir,
		sources: [],
		cwd: "C:\\work\\demo",
	});
	const runtime = stubRuntime(conn);
	await performAcpHandshake(runtime, undefined, "C:\\work\\demo", new Promise(() => {}), {
		handshakeTimeoutMs: 30_000,
		seedMessages: () => [],
		onNotification: () => undefined,
		mcpServers: () => buildAcpMcpServers(mount),
	});

	assert.equal(runtime.acpSessionId, "sess-memory-stub");
	const received = JSON.parse(readFileSync(outFile, "utf8"));
	assert.equal(received.method, "session/new");
	assert.equal(received.mcpServers.length, 1);
	assert.equal(received.mcpServers[0].name, AGENT_MEMORY_SERVER_NAME);
	// env 必须随挂载一起过去：服务器只认环境变量，缺一个就会拒绝启动或搜不到会话。
	// 线上形状是 ACP 的 EnvVariable[]（`{name, value}`），不是对象；这里解码后再断言。
	const envPairs = received.mcpServers[0].env;
	assert.ok(Array.isArray(envPairs), "env 必须是数组（对象会被真实 agent 拒成 -32602）");
	const env = Object.fromEntries(envPairs.map((item) => [item.name, item.value]));
	assert.ok(env.PIDECK_AGENT_MEMORY_DIR, "缺少记忆根目录，服务器会拒绝启动");
	assert.equal(env.PIDECK_AGENT_MEMORY_CWD, "C:\\work\\demo");

	const summary = received.summary[0];
	assert.equal(summary.error, "", `服务器启动失败：${summary.error}`);
	assert.deepEqual([...summary.tools].sort(), ["memory_add", "memory_get", "memory_remove", "memory_replace", "memory_search", "memory_status", "session_search"]);
});

test("ACP 真进程：开关关闭时 mcpServers 传空数组（ACP v1 该字段必填，不能省）", async (t) => {
	const memoryDir = mkdtempSync(join(tmpdir(), "pideck-acp-memory-off-"));
	const outFile = join(memoryDir, "stub-received.json");
	const proc = spawn(process.execPath, [STUB], {
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ACP_STUB_OUT: outFile, NODE_NO_WARNINGS: "1" },
		windowsHide: true,
	});
	t.after(() => proc.kill());
	const conn = new AcpConnection(proc.stdin, proc.stdout);
	t.after(() => conn.close());

	const runtime = stubRuntime(conn);
	await performAcpHandshake(runtime, undefined, "C:\\work\\demo", new Promise(() => {}), {
		handshakeTimeoutMs: 30_000,
		seedMessages: () => [],
		onNotification: () => undefined,
		mcpServers: () => [],
	});

	const received = JSON.parse(readFileSync(outFile, "utf8"));
	assert.deepEqual(received.mcpServers, [], "关闭时必须显式传 []：opencode 的 zod 缺字段会直接 -32602");
});
