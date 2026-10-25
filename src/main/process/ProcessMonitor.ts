/**
 * 进程内存监控：生成 pi agent 子进程的内存快照。
 *
 * 数据源说明：
 * - 监控 pi agent 子进程 + 共享的 DSH host utilityProcess（按 pid 采样，不区分来源）；
 *   Electron 自身进程的内存不再采集，用户自行在系统任务管理器/活动监视器中查看。
 * - agent 子进程内存按 pid 调系统命令采样：Windows 用 PowerShell
 *   PrivateMemorySize64（tasklist 的 Mem Usage 是工作集，含共享页，多进程合计会重复计数），
 *   Linux/macOS 用 `ps -o rss= -p N`。命令参数一律数组形式（禁止字符串拼接，见安全规范）。
 * - 采样失败（进程刚好退出/命令缺失）返回 undefined，快照仍可用，非致命。
 */
import { spawn } from "node:child_process";
import { parsePrivateMemoryBytes, parsePsRssKb, parseTasklistMemoryKb } from "./pidMemoryParsers";
import type { AgentProcessMetric, ProcessMetricsSnapshot } from "../../shared/types";

const TASKLIST_TIMEOUT_MS = 2000;
const PS_TIMEOUT_MS = 2000;

/** 采集超时后 kill 子进程，避免监控调用挂死 IPC。 */
function runCollect(args: string[], timeoutMs: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(args[0], args.slice(1), {
			windowsHide: true,
			timeout: timeoutMs,
			killSignal: "SIGKILL",
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => reject(error));
		child.on("close", (code) => {
			if (code !== 0) {
				reject(new Error(`collect exited ${code}: ${stderr.trim()}`));
			} else {
				resolve(stdout);
			}
		});
	});
}

export { formatBytes } from "../../shared/formatBytes";

/** 按 pid 采样单个进程专用内存（字节）；失败返回 undefined。
 * 口径对齐任务管理器"内存"列（专用工作集，不含共享页）：
 * - Windows：PowerShell PrivateMemorySize64（tasklist 的 Mem Usage 是工作集，含共享页，
 *   多进程合计会把共享页重复计数——之前"内置监控 700MB vs 任务管理器 400MB"的根因）
 * - Linux/macOS：ps -o rss（无专用/共享分离，接受 RSS 口径） */
export async function sampleProcessMemoryBytes(pid: number): Promise<number | undefined> {
	try {
		if (process.platform === "win32") {
			const out = await runCollect(["powershell", "-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).PrivateMemorySize64`], TASKLIST_TIMEOUT_MS);
			const bytes = parsePrivateMemoryBytes(out);
			return bytes ?? undefined;
		}
		const out = await runCollect(["ps", "-o", "rss=", "-p", String(pid)], PS_TIMEOUT_MS);
		const kb = parsePsRssKb(out);
		return kb == null ? undefined : kb * 1024;
	} catch {
		// 进程恰好退出/命令缺失都算采样失败，快照继续可用
		return undefined;
	}
}

/**
 * 组装完整快照：并发采样所有 agent 子进程 + 内存汇总。
 * agent 内存采样失败项不计入汇总，避免"查不到就少一块"造成总和误导。
 */
export async function getProcessSnapshot(
	agents: Array<{
		agentId: string;
		pid: number;
		kind?: AgentProcessMetric["kind"];
		sessionId?: string;
		sessionTitle?: string;
		sessionTitles?: string[];
	}>,
): Promise<ProcessMetricsSnapshot> {
	const sampled = await Promise.all(
		agents.map(async (agent) => {
			const memoryBytes = await sampleProcessMemoryBytes(agent.pid);
			// 展开保留会话身份字段（sessionId/sessionTitle/sessionTitles），供监控表展示
			return { ...agent, memoryBytes } as AgentProcessMetric;
		}),
	);
	const totalAgentBytes = sampled.reduce((sum, item) => sum + (item.memoryBytes ?? 0), 0);
	return {
		agents: sampled,
		totalAgentBytes,
		sampledAt: Date.now(),
	};
}
