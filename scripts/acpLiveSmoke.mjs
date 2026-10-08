/**
 * ACP 真实联调 smoke(手动运行,不进 CI):
 *   node scripts/acpLiveSmoke.mjs [command args...]   默认 `opencode acp`
 * 完整链路:initialize → session/new → session/prompt(文本+1x1 测试图)
 * 校验点:握手能力协商、update 流投影成 ChatMessage、stopReason 结算、图片块随 prompt 送达不炸。
 * 依赖本机已登录的目标 CLI(opencode 等);失败打印错误定位。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { loadTsCommonJs } from "../tests/helpers/loadTsCommonJs.mjs";

const { AcpConnection } = loadTsCommonJs("src/main/acp/AcpConnection.ts");
const { projectAcpSessionUpdate, settleAcpTurn, acpPromptBlocks } = loadTsCommonJs("src/main/acp/acpEventProjector.ts");
const { PiLocator } = loadTsCommonJs("src/main/pi/PiLocator.ts");

const command = process.argv[2] ?? "opencode";
// ACP_SMOKE_ENV_JSON: '{"ZAI_CODING_KEY":"sk-..."}' — 验证工具级 env 注入链(与 AcpAgentManager.create 的合并语义一致)
const ACP_SMOKE_ENV_JSON = process.env.ACP_SMOKE_ENV_JSON;
const args = process.argv.slice(3).length > 0 ? process.argv.slice(3) : ["acp"];
const cwd = mkdtempSync(join(tmpdir(), "acp-smoke-"));
console.log(`[smoke] spawn: ${command} ${args.join(" ")} (cwd=${cwd})`);

// spawn 收口在 manager(piLocator.createInvocation 解析 Windows .cmd 垫片),smoke 复用同一解析
const locator = new PiLocator();
const invocation = locator.createInvocation(command, args);
console.log(`[smoke] invocation: ${invocation.command} ${invocation.args.join(" ")} (shell=${invocation.shell === true})`);
const toolEnv = ACP_SMOKE_ENV_JSON ? (JSON.parse(ACP_SMOKE_ENV_JSON) ?? {}) : {};
const proc = spawn(invocation.command, invocation.args, { cwd, env: { ...process.env, ...toolEnv }, stdio: ["pipe", "pipe", "pipe"], shell: invocation.shell === true, windowsHide: true });
let stderrTail = "";
proc.stderr?.on("data", (chunk) => {
	const text = chunk.toString();
	stderrTail = (stderrTail + text).slice(-2000);
	process.stderr.write(`[cli-stderr] ${text}`);
});
proc.on("error", (error) => fail(`spawn error: ${error.message}`));

const conn = new AcpConnection(proc.stdin, proc.stdout);
const updates = [];
let projection = { messages: [], lastTouched: [], title: undefined };
let settled = false;

conn.on("notification", (n) => {
	if (n.method !== "session/update") return;
	updates.push(n.params.update);
	try {
		projection = projectAcpSessionUpdate(projection, n.params.update, "smoke-tab");
	} catch (error) {
		console.log(`[smoke] projector error: ${error.message}`);
	}
});
conn.on("closed", (error) => {
	console.log(`[smoke] closed: ${error?.message ?? "clean"}`);
	if (!settled) process.exit(2);
});

const fail = (msg) => {
	console.error(`[smoke] FAIL: ${msg}`);
	if (stderrTail.trim().length > 0) console.error(`[cli-stderr tail]\n${stderrTail}`);
	try {
		conn.close();
	} catch {}
	try {
		proc.kill();
	} catch {}
	rmSync(cwd, { recursive: true, force: true });
	process.exit(1);
};
try {
	const init = await conn.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false } });
	console.log(`[smoke] initialize ok: agent=${init.agentInfo?.name} caps=${JSON.stringify(init.agentCapabilities)}`);

	// 本机 opencode 默认 model 为空会导致 UnknownError,显式指定可用模型(ds-2api/deepseek-chat-search)
	const newSession = await conn.request("session/new", { cwd, mcpServers: [], model: process.env.ACP_SMOKE_MODEL ?? "ds-2api/deepseek-chat-search" });
	console.log(`[smoke] session/new ok: ${newSession.sessionId} (stopReason=${newSession.stopReason})`);

	// 1x1 红色 PNG(base64),验证图片块能随 prompt 送达且不炸
	const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeklEQVR4nO3PUQkAIBTAwBfNKPYvoSH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWPHYB68rxeKnuGVEAAAAASUVORK5CYII=";
	const withImage = process.env.ACP_SMOKE_IMAGE !== "0";
	const prompt = acpPromptBlocks("回复两个词:收到图片", withImage ? [{ type: "image", mimeType: "image/png", data: pngBase64 }] : []);
	console.log(`[smoke] session/prompt sending: ${prompt.length} blocks`);

	const result = await conn.request("session/prompt", { sessionId: newSession.sessionId, prompt }, 10 * 60_000);
	console.log(`[smoke] prompt settled: stopReason=${result?.stopReason}`);
	settled = true;
	// 真实 CLI 可能 result 帧先于末批 update 到达(manager 的 updateChain 语义),smoke 等一小窗口再读
	await new Promise((resolve) => setTimeout(resolve, 3000));

	projection = settleAcpTurn(projection, result?.stopReason ?? "end_turn");
	console.log(`[smoke] updates=${updates.length} messages=${projection.messages.length}`);
	for (const u of updates) console.log(`  [update] ${JSON.stringify(u).slice(0, 400)}`);
	for (const m of projection.messages) {
		console.log(`  [${m.role}] text=${(m.text ?? "").slice(0, 120).replace(/\n/g, "⏎")} images=${m.images?.length ?? 0}`);
	}
	const imageMessages = projection.messages.filter((m) => (m.images?.length ?? 0) > 0);
	console.log(`[smoke] image-bearing messages: ${imageMessages.length}`);
	conn.close();
	proc.kill();
	// Windows 下 CLI 子进程可能短暂占用临时目录,清不掉就留给系统临时回收,不影响结果判定
	try {
		rmSync(cwd, { recursive: true, force: true });
	} catch {}
	console.log("[smoke] PASS");
} catch (error) {
	fail(error.stack ?? error.message);
}
