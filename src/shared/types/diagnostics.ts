/**
 * 开发诊断快照：设置里打开「性能诊断」后，主进程按固定间隔采样，
 * 给设置页一份可对照的数据（内存 / 事件循环延迟 / 每进程 CPU / 最近关键耗时）。
 * 默认关闭，生产零开销。
 */

export type DiagnosticsEventTiming = {
	/** 事件名，如 agent.create / session.history.load */
	name: string;
	/** 开始时刻 epoch ms */
	startedAt: number;
	/** 耗时 ms */
	durationMs: number;
	detail?: Record<string, string | number | boolean | null>;
};

export type DiagnosticsProcessCpu = {
	pid: number;
	/** Browser / Tab / GPU / Utility …（Electron ProcessMetric.type 原值） */
	type: string;
	/** 最近一个采样窗口的平均 CPU%，100 = 占满一个核；多线程进程可超过 100 */
	cpuPct: number;
	/** 本次诊断开启以来的峰值 CPU%，用于捕捉两次刷新之间的尖刺 */
	peakCpuPct: number;
};

export type DiagnosticsSnapshot = {
	enabled: boolean;
	sampledAt: number;
	/** 主进程 RSS / 堆（字节） */
	main: {
		rssBytes: number;
		heapUsedBytes: number;
		heapTotalBytes: number;
		externalBytes: number;
		arrayBuffersBytes: number;
	};
	/** 最近一次事件循环延迟（setImmediate 往返），ms */
	eventLoopLagMs: number;
	/** 采样窗口内的最大事件循环延迟，ms */
	eventLoopLagMaxMs: number;
	/** 各 Electron 进程（主/渲染/GPU/utility）最近 1s 的 CPU 占用，按 cpuPct 降序 */
	processCpu: DiagnosticsProcessCpu[];
	/** 内存 CSV 路径；未开内存采样时为 null */
	memoryProfilePath: string | null;
	/** 事件耗时 JSONL 路径；未开诊断时为 null */
	timingsPath: string | null;
	/** 每进程 CPU 时间序列 JSONL 路径（5s 一行）；未开诊断时为 null */
	cpuPath: string | null;
	/** 最近若干条关键耗时（新→旧） */
	recentTimings: DiagnosticsEventTiming[];
};

/**
 * 运行架构状态：用于检测「x64 包跑在 ARM 芯片转译层下」（macOS Rosetta 2）。
 * 典型事故（2026-10）：M1 Pro 用户在 Release 页默认点开无后缀的 x64 dmg，全程
 * Rosetta 转译导致严重卡顿。渲染层据此提示换装 arm64 包。
 */
export type ArchStatus = {
	/** 运行平台：darwin / win32 / linux（process.platform） */
	platform: string;
	/** 当前二进制架构：x64 / arm64 等（process.arch） */
	processArch: string;
	/** Electron 判定：x64 二进制正跑在 ARM64 转译层下（macOS=Rosetta 2，Windows=ARM 模拟） */
	runningUnderArm64Translation: boolean;
};
