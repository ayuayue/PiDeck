/**
 * 进程内存监控快照类型。
 *
 * 监控 pi agent 子进程 + 共享的 DSH host utilityProcess。
 * Electron 自身进程的内存由用户自行在系统任务管理器/活动监视器中查看
 * （口径因平台/Chromium 版本而异，内置监控容易对不上，徒增困惑）。
 * 子进程不在 app metrics 里，由主进程按 pid 调系统命令查询内存与 CPU
 * （Windows PowerShell PrivateMemorySize64 / Linux·macOS `ps -o rss`），缺失时为 undefined。
 */

/** 进程监控里 DSH host 那一行的稳定 id（不是会话 agentId，停止走 host dispose）。 */
export const DSH_HOST_MONITOR_ID = "dsh-host";

export type ProcessMetricKind = "pi" | "dsh-host";

export type AgentProcessMetric = {
	/** pi agent 会话标识，或 DSH_HOST_MONITOR_ID */
	agentId: string;
	/** 行类型：缺省视为 pi（兼容旧快照） */
	kind?: ProcessMetricKind;
	/** 关联的会话 id（可点击跳转）；DSH host / 匿名 agent 无绑定时为 undefined */
	sessionId?: string;
	/** 关联会话标题（catalog 有记录时提供；DSH host 为摘要，完整列表见 sessionTitles） */
	sessionTitle?: string;
	/** DSH host 挂着的全部会话标题（表内摘要 + 悬停完整列表） */
	sessionTitles?: string[];
	/** 子进程 pid（pi ChildProcess 或 DSH utilityProcess） */
	pid: number;
	/** 常驻内存（字节）；系统命令采样失败时 undefined */
	memoryBytes?: number;
	/** 刷新窗口内的平均 CPU%（100 = 占满一核，多线程可超过 100）；首次采样或进程刚启动时 undefined */
	cpuPct?: number;
	/** 该进程采样失败的原因（非致命，仅展示用） */
	error?: string;
};

export type ProcessMetricsSnapshot = {
	/** 正在运行的 pi agent +（若已 fork）DSH host */
	agents: AgentProcessMetric[];
	/** 已采样内存之和（字节，失败项不计；Windows 为专用内存，其余平台 RSS） */
	totalAgentBytes: number;
	/** 快照采样时间戳（ms） */
	sampledAt: number;
};
