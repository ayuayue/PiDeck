/**
 * ACP CLI 子进程宿主：spawn 接线与进程树击杀（Windows taskkill 垫片还原见 PiLocator）。
 *
 * 从 AcpAgentManager 抽出的协作者：manager 只保留 runtime 级清理（flush/看门狗/
 * conn.close），进程生命周期细节集中在此。
 * 安全约束（AGENTS.md）：spawn 必须挂 error 监听；taskkill 等外部命令兜底 proc.kill()。
 * env 叠加：工具级 env（如 codex-acp 的 ZAI_CODING_KEY）叠在基础 env 之上，
 * 值可能含密钥——绝不进日志。
 */
import { spawn } from "node:child_process";
import type { AcpToolConfig } from "../../shared/types/acp";
import type { PiLocator } from "../pi/PiLocator";
import { AcpConnection } from "./AcpConnection";

export type AcpSpawnedProcess = {
	proc: import("node:child_process").ChildProcess;
	conn: AcpConnection;
	/** spawn 失败/被杀的拒绝信号（proc error 事件）；create 的握手期与它 race。 */
	spawnFailure: Promise<never>;
};

export type AcpProcessHostDeps = {
	piLocator: PiLocator;
	logger?: { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };
};

/**
 * 启动 ACP CLI 子进程并接好 stdio 接线：
 * - stdin/stdout → AcpConnection（NDJSON JSON-RPC）；
 * - stderr → 主进程日志（CLI 诊断日志不上时间线）；
 * - proc error → conn.close 结算（未处理 error 事件会崩主进程，硬规则）；
 * - close（非 exit：Node 的 exit 早于 stdout 排空，close 才能收口末批消息）→ conn.finish。
 */
export function spawnAcpProcess(tool: AcpToolConfig, cwd: string, deps: AcpProcessHostDeps): AcpSpawnedProcess {
	const invocation = deps.piLocator.createInvocation(tool.command, tool.args);
	// 工具级 env 叠加在基础进程 env 之上；值可能含密钥，绝不进日志。
	const env = { ...deps.piLocator.createProcessEnv(), ...(tool.env ?? {}) };
	deps.logger?.info("acp", "Spawning ACP agent", { tool: tool.name, command: invocation.command, args: invocation.args });
	// ACP 规范:client 透传 stdio 的其余输出(日志走 stderr);windowsHide 对齐全项目惯例。
	const proc = spawn(invocation.command, invocation.args, { cwd, stdio: ["pipe", "pipe", "pipe"], shell: invocation.shell, env, windowsHide: true });
	// spawn 失败/被杀必须挂 error 监听(硬规则:未处理 error 事件崩主进程)。
	const spawnFailure = new Promise<never>((_, reject) => {
		proc.once("error", (error) => reject(error));
	});
	const conn = new AcpConnection(proc.stdin, proc.stdout);
	proc.on("error", (error) => conn.close(error));
	proc.stderr?.on("data", (chunk: Buffer) => {
		// CLI 诊断日志(stderr)只进主进程日志,不上时间线。
		const text = chunk.toString("utf8").trim();
		if (text) deps.logger?.info("acp", `[${tool.name}] ${text.slice(0, 2000)}`);
	});
	// Node 的 exit 早于 stdout 排空；close 才能收口，否则末批 update/result 会被丢弃。
	proc.once("close", (code, signal) => {
		conn.finish(new Error(`ACP agent exited (code=${code} signal=${signal})`));
	});
	return { proc, conn, spawnFailure };
}

/**
 * 进程树击杀。Windows 下 spawn 常经 cmd.exe 垫片（.cmd shim），proc.kill() 只杀垫片
 * 进程，CLI 孙进程成为孤儿（opencode 实测残留）；taskkill /T 按进程树强杀。
 * spawn 失败（taskkill 缺失等）兜底 proc.kill()——必须挂 error 监听（AGENTS 安全约束）。
 */
export function killAcpProcessTree(proc: import("node:child_process").ChildProcess): void {
	if (process.platform === "win32" && typeof proc.pid === "number") {
		try {
			const killer = spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
			killer.on("error", () => {
				try {
					proc.kill();
				} catch {}
			});
		} catch {
			try {
				proc.kill();
			} catch {}
		}
		return;
	}
	proc.kill();
}
