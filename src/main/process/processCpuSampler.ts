/**
 * 每进程 CPU 归属：把 Electron `app.getAppMetrics()` 的累计 CPU 秒数做差分。
 *
 * 为什么不用 `ProcessMetric.cpu.percentCPUUsage`：它算的是「自上次读这个字段以来」的百分比，
 * 任何第三方读一次就把窗口吃掉（主进程有好几处调 getAppMetrics），Windows 上还恒为 0；
 * `cumulativeCPUUsage` 是自进程启动以来的累计秒数，任意多处读取互不干扰，
 * 差分除以本地时间窗就是我们自己要的口径。
 *
 * 纯函数，不 import electron，便于单测。
 */

export type CpuSampleInput = {
	pid: number;
	/** Browser / Tab / GPU / Utility …，仅用于展示 */
	type: string;
	/** 自进程启动以来的累计 CPU 秒数；缺失（旧 Electron / 权限不足）时跳过该进程 */
	cumulativeCpuSeconds?: number;
	/** 进程创建时刻 epoch ms，用来识别 pid 复用 */
	creationTime?: number;
	memoryBytes?: number;
};

export type ProcessCpuSample = {
	pid: number;
	type: string;
	/** 采样窗口内平均 CPU%，100 = 占满一个核；多线程可超过 100 */
	cpuPct: number;
	memoryBytes?: number;
};

export type CpuBaseline = Map<number, { cpuSeconds: number; at: number; creationTime?: number }>;

const round1 = (value: number): number => Math.round(value * 10) / 10;

/**
 * 用上一轮基线算这一轮的平均 CPU%。首轮没有基线，只建基线不产出行。
 */
export function sampleProcessCpu(input: readonly CpuSampleInput[], baseline: CpuBaseline, at: number): { rows: ProcessCpuSample[]; baseline: CpuBaseline } {
	const next: CpuBaseline = new Map();
	const rows: ProcessCpuSample[] = [];
	for (const proc of input) {
		const current = proc.cumulativeCpuSeconds;
		if (typeof current !== "number" || !Number.isFinite(current) || current < 0) continue;
		next.set(proc.pid, { cpuSeconds: current, at, creationTime: proc.creationTime });
		const prev = baseline.get(proc.pid);
		if (!prev) continue;
		// pid 复用（前一进程已退出）：累计值不可比，重建基线。
		if (prev.creationTime !== undefined && proc.creationTime !== undefined && prev.creationTime !== proc.creationTime) continue;
		const elapsedMs = at - prev.at;
		const deltaCpuSeconds = current - prev.cpuSeconds;
		// 时钟回拨或计数变小时这一轮不成立，等下一轮重新建基线。
		if (elapsedMs <= 0 || deltaCpuSeconds < 0) continue;
		rows.push({
			pid: proc.pid,
			type: proc.type,
			cpuPct: round1((deltaCpuSeconds / (elapsedMs / 1000)) * 100),
			...(proc.memoryBytes ? { memoryBytes: proc.memoryBytes } : {}),
		});
	}
	rows.sort((a, b) => b.cpuPct - a.cpuPct || a.pid - b.pid);
	return { rows, baseline: next };
}
