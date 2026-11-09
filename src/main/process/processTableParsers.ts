/**
 * 进程表采样的纯解析函数（无 electron 依赖，可被 node --test 直接 import）。
 * 解析逻辑独立成文件的原因：系统命令输出解析是易错点（ps 的 TIME 格式随平台变、
 * 空白/千分位/CRLF），配单测锁定行为；运行时执行与错误处理在 ProcessMonitor。
 *
 * 一次命令取一批 pid 的内存 + 累计 CPU 秒数：
 * - Windows：PowerShell `Get-Process -Id ...` 输出 `pid;PrivateMemorySize64;CPU毫秒`
 * - Linux/macOS：`ps -o pid=,rss=,time=` 输出 `pid rss(KB) TIME`
 * 累计 CPU 秒数交给 processCpuSampler 做差分（同一口径，不重复实现）。
 */

export type ProcessTableEntry = {
	/** 常驻内存（字节） */
	memoryBytes: number;
	/** 进程启动以来的累计 CPU 秒数 */
	cpuSeconds: number;
};

export type ProcessTable = Map<number, ProcessTableEntry>;

/**
 * 解析 ps 的 TIME 字段为秒。三种形状：
 * - Linux：`hh:mm:ss`（超过 24h 加 `dd-` 前缀）
 * - macOS 短：`mm:ss.ss`（只有两段，秒带小数）
 * - macOS 长：`hh:mm:ss.ss`
 * 只按段数判断，不能把 `0:00.05` 当成 hh:mm → 会放大 100 倍。
 */
export function parsePsCpuTime(value: string): number | null {
	const text = value.trim();
	if (!text) return null;
	const dashAt = text.indexOf("-");
	const dayPart = dashAt >= 0 ? text.slice(0, dashAt) : null;
	const clock = dashAt >= 0 ? text.slice(dashAt + 1) : text;
	// 带 `-` 前缀就必须是纯数字天数：否则 "-1:00" 会被兜底成 0 天 1:00。
	if (dayPart != null && !/^\d+$/.test(dayPart)) return null;
	const days = dayPart == null ? 0 : Number(dayPart);
	if (!Number.isFinite(days) || days < 0) return null;
	const parts = clock.split(":");
	if (parts.length < 2 || parts.length > 3) return null;
	const nums = parts.map((part) => Number(part));
	if (nums.some((num) => !Number.isFinite(num) || num < 0)) return null;
	const seconds = parts.length === 3 ? nums[0] * 3600 + nums[1] * 60 + nums[2] : nums[0] * 60 + nums[1];
	return days * 86400 + seconds;
}

/**
 * 解析 `ps -o pid=,rss=,time= -p 1,2,3` 输出。rss 是 KB，这里统一换算成字节。
 * 进程刚好退出时该行缺失，属正常情况；格式不合的行跳过而不是整批失败。
 */
export function parsePsProcessTable(output: string): ProcessTable {
	const table: ProcessTable = new Map();
	for (const line of output.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length !== 3) continue;
		const pid = Number(fields[0]);
		const rssKb = Number(fields[1]);
		const cpuSeconds = parsePsCpuTime(fields[2]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (!Number.isFinite(rssKb) || rssKb < 0) continue;
		if (cpuSeconds == null) continue;
		table.set(pid, { memoryBytes: rssKb * 1024, cpuSeconds });
	}
	return table;
}

/**
 * 解析 PowerShell 批量输出，每行 `pid;PrivateMemorySize64;CPU毫秒`。
 * CPU 用整数毫秒而不是 `$_.CPU` 的浮点秒：PowerShell 的字符串化跟随系统区域，
 * 小数逗号的 locale 下 `0,5` 会被 Number() 读成 NaN。
 */
export function parseWindowsProcessTable(output: string): ProcessTable {
	const table: ProcessTable = new Map();
	for (const line of output.split(/\r?\n/)) {
		const fields = line
			.replace(/^\uFEFF/, "")
			.trim()
			.split(";");
		if (fields.length !== 3) continue;
		const pid = Number(fields[0]);
		const memoryBytes = Number(fields[1]);
		const cpuMs = Number(fields[2]);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		if (!Number.isFinite(memoryBytes) || memoryBytes < 0) continue;
		if (!Number.isFinite(cpuMs) || cpuMs < 0) continue;
		table.set(pid, { memoryBytes, cpuSeconds: cpuMs / 1000 });
	}
	return table;
}
