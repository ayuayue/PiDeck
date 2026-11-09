/**
 * 进程监控：pi agent 子进程 + 共享 DSH host 的内存与 CPU 快照。
 *
 * 一次快照 = 同一条命令采两遍（间隔 CPU_WINDOW_MS）：内存取第二遍的最新值，
 * CPU 用两遍的累计 CPU 秒数差分算占用率。批量采样而不是逐 pid 起进程，
 * 因为 Windows 每个 PowerShell 冷启动 100~300ms，N 个 agent 会拖成 N 倍。
 *
 * 解析全在 processTableParsers（纯函数 + 单测），这里只负责执行与容错：
 * 单个 pid 刚好退出时该行缺失是正常情况，不让整张表失败。
 */
import { spawn } from "node:child_process";
import type { AgentProcessMetric, ProcessMetricsSnapshot } from "../../shared/types";
import { sampleProcessCpu, type CpuBaseline } from "./processCpuSampler";
import { parsePsProcessTable, parseWindowsProcessTable, type ProcessTable } from "./processTableParsers";

const PROCESS_SAMPLE_TIMEOUT_MS = 2000;
/** CPU 是两次采样的差值：窗口太短噪声大，太长则手动刷新感知卡顿。 */
const CPU_WINDOW_MS = 600;

export { formatBytes } from "../../shared/formatBytes";

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

/** CPU 用整数毫秒而不是 `$_.CPU` 的浮点秒：小数逗号 locale 下 `0,5` 会被读成 NaN。 */
function buildWindowsCommand(pids: number[]): string[] {
	const ids = pids.join(",");
	return ["powershell", "-NoProfile", "-NonInteractive", "-Command", `Get-Process -Id ${ids} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id);$($_.PrivateMemorySize64);$([long]($_.CPU*1000))" }`];
}

function buildPosixCommand(pids: number[]): string[] {
	return ["ps", "-o", "pid=,rss=,time=", "-p", pids.join(",")];
}

async function sampleProcessTable(pids: number[]): Promise<ProcessTable> {
	const isWindows = process.platform === "win32";
	try {
		const output = await runCollect(isWindows ? buildWindowsCommand(pids) : buildPosixCommand(pids), PROCESS_SAMPLE_TIMEOUT_MS);
		return isWindows ? parseWindowsProcessTable(output) : parsePsProcessTable(output);
	} catch {
		// 命令缺失 / 全部进程已退出：返回空表，快照照常返回（内存与 CPU 显示为 "-"）
		return new Map();
	}
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getProcessSnapshot(agents: readonly Omit<AgentProcessMetric, "memoryBytes" | "cpuPct" | "error">[]): Promise<ProcessMetricsSnapshot> {
	const pids = [...new Set(agents.map((agent) => agent.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
	if (pids.length === 0) {
		return { agents: agents.map((agent) => ({ ...agent })), totalAgentBytes: 0, sampledAt: Date.now() };
	}

	const first = await sampleProcessTable(pids);
	const firstAt = Date.now();
	await delay(CPU_WINDOW_MS);
	const second = await sampleProcessTable(pids);
	const secondAt = Date.now();

	const baseline: CpuBaseline = new Map();
	for (const [pid, entry] of first) {
		baseline.set(pid, { cpuSeconds: entry.cpuSeconds, at: firstAt });
	}
	const { rows } = sampleProcessCpu(
		[...second].map(([pid, entry]) => ({ pid, type: "agent", cumulativeCpuSeconds: entry.cpuSeconds })),
		baseline,
		secondAt,
	);
	const cpuPctByPid = new Map(rows.map((row) => [row.pid, row.cpuPct]));

	const sampled: AgentProcessMetric[] = agents.map((agent) => {
		const latest = second.get(agent.pid) ?? first.get(agent.pid);
		return { ...agent, memoryBytes: latest?.memoryBytes, cpuPct: cpuPctByPid.get(agent.pid) };
	});
	const totalAgentBytes = sampled.reduce((sum, item) => sum + (item.memoryBytes ?? 0), 0);
	return { agents: sampled, totalAgentBytes, sampledAt: secondAt };
}
