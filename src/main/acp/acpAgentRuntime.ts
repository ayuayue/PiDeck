/**
 * ACP 会话 runtime 的形状定义（纯类型模块）。
 *
 * 从 AcpAgentManager 抽出：看门狗/快照存储/握手等协作者模块需要引用同一 runtime
 * 结构，集中放此处避免循环 import（manager → 协作者 → 类型 ← manager）。
 * 字段语义注释是行为契约的一部分，迁移时原样保留。
 */
import type { ChildProcess } from "node:child_process";
import type { AcpAgentInfo, AcpToolConfig } from "../../shared/types/acp";
import type { AgentRuntimeState, AgentStatus, AgentTab } from "../../shared/types/agent";
import type { AcpConfigOption } from "./acpProtocol";
import type { AcpConnection } from "./AcpConnection";
import type { AcpPermissionRequests } from "./AcpPermissionRequests";
import type { AcpProjectionState } from "./AcpEventProjector";
import { acpSessionTps, type AcpUsageTotals } from "./acpUsageMetrics";

/** cancel 发起方:user_stop=用户主动停止(空白收口属正常);stall=看门狗代发(按失败收口)。 */
export type AcpCancelSource = "user_stop" | "stall";

/** 升级强杀原因;sendPrompt catch 依此定向结算(delivery=unknown + 本地化文案)。 */
export type AcpAbortEscalationReason = "abort_repeat" | "abort_no_response" | "stall";

export type AcpAgentRuntime = {
	tab: AgentTab;
	/** agent 侧 sessionId(ACP 会话身份,catalog 持久化为 acpSessionId)。 */
	acpSessionId: string;
	/** 使用的工具配置快照(会话期工具被删/改不影响运行中进程)。 */
	tool: AcpToolConfig;
	proc: ChildProcess | null;
	conn: AcpConnection | null;
	projection: AcpProjectionState;
	agentInfo: AcpAgentInfo;
	status: AgentStatus;
	/** 是否有进行中的 prompt 回合(session/prompt 尚未返回)。 */
	turnActive: boolean;
	permissions: AcpPermissionRequests;
	/** cancel 后到 prompt 结算前仍允许尾部 update，但不再接受新审批。 */
	cancelling: boolean;
	/** 本次 cancel 的发起方:user_stop=用户主动停止(空白收口属正常);stall=看门狗
	 *  代发(用户没叫停,空白回合是 CLI 异常,必须按失败收口而非谎报成功)。 */
	cancelReason: AcpCancelSource | null;
	/** load 尚未成功时不发布半段历史、标题或配置，失败可完整丢弃。 */
	reloading: boolean;
	/** 握手时 session/load 成功（历史会话恢复）：不全量重放工具级记忆（交给 agent 恢复会话状态），只补回 bypass 权限档。 */
	loadedSession: boolean;
	flushTimer: NodeJS.Timeout | null;
	flushPending: boolean;
	/** abort/超时升级强杀前的宽限定时器;回合正常结算时清除。 */
	abortEscalateTimer: NodeJS.Timeout | null;
	/** 回合 stall 看门狗 interval;回合结算时清除。 */
	stallTimer: NodeJS.Timeout | null;
	/** 最近一次 session/update 或回合派发的时间戳,stall 判定基准。 */
	lastUpdateAt: number;
	/** 回合兑底超时的滚动刷新句柄：session/prompt 在途时由连接层布防，回合内每有进展
	 *  （session/update、挂起审批）就顺延截止——超时口径因此是「无进展静默上限」而非
	 *  总时长硬上限，长但健康的回合不会被误杀；回合结算/stop/连接死亡统一置空。 */
	turnDeadlineRefresh: (() => void) | null;
	/** 在途工具调用 id 集：tool_call 开始入集，tool_call_update 终态出集（AcpUpdatePipeline 维护）。
	 *  stall 看门狗把「有在途工具调用」视作合法等待（同挂起审批）：长命令 started→completed
	 *  之间可长时间无流式输出，不算静默；回合各收口点清空，防跨回合泄漏成永久豁免。 */
	inFlightToolCalls: Set<string>;
	/** 本回合升级强杀原因;sendPrompt catch 依此定向结算(delivery=unknown + 本地化文案)。 */
	escalatedStop: AcpAbortEscalationReason | null;
	/**
	 * 本回合是否见过 agent 侧动静（任何 session/update 通知或挂起审批）。
	 * 断线重连的判据：有过动静说明工具可能已经开跑，重开会重跑一遍；每回合派发前清空。
	 */
	turnSawActivity: boolean;
	/**
	 * 本回合收到的 session/update 类型计数（诊断用）：空白回合要靠它区分
	 * 「事件流真的没来」与「来了但我们没消费」（如 agent 发的是非标准 update 类型）。
	 * 每回合派发前清空。
	 */
	turnUpdateKinds: Map<string, number>;
	/** 本回合收到的非 session/update 通知的最后一个样本（method + 截断原文），诊断用。 */
	turnForeignNotification?: string;
	/** CLI stderr 尾部（最近几行，限流/登录失败等只打在 stderr 的错误靠它带进 UI）。 */
	stderrTail: string[];
	/** 会话标题(session_info_update / new 返回值;供 catalog 自动标题)。 */
	title?: string;
	/** 本回合派发时刻（TTFT/总耗时的计时基准；回合结算或失败后清空）。 */
	turnStartedAt?: number;
	/** 本回合首个正文 chunk 到达时刻（TTFT 首选，与 pi 的 text delta 同口径）。 */
	turnFirstTextAt?: number;
	/** 本回合首个思考 chunk 到达时刻（无正文时作为 TTFT 回退，与 pi 同语义）。 */
	turnFirstThoughtAt?: number;
	/** 会话累计 token/缓存用量（session/prompt 响应的实验性 usage 累计；CLI 不返回时缺省）。 */
	usageTotals?: AcpUsageTotals;
	/** 最近一次成功回合的性能快照（TTFT/总耗时/TPS），供底栏圆环面板展示。 */
	lastReplyPerf?: { ttftMs?: number; totalMs?: number; tps?: number; endToEndTps?: number; at: number };
	/** session/new|load 与 set_config_option 返回的会话级配置(模型/思考档/模式)。
	 *  渲染层按 category 渲染选择器;agent 不提供时恒 undefined(回退隐藏)。 */
	configOptions?: AcpConfigOption[];
	/** session/update 串行链:投影→物化(异步落盘)→flush 必须按序完成,
	 * 否则并发的物化回写会用旧 messages 快照覆盖后到的投影结果(图片/流式块丢失)。 */
	updateChain: Promise<void>;
	/** session/set_config_option 串行链:并发的响应可能乱序,迟到的旧整表会回退
	 *  configOptions 并推过期通知;排队发送使应用顺序=请求顺序。失败不阻塞后续。 */
	configChain?: Promise<void>;
};

/** AcpAgentManager 的注入依赖（超时类字段供测试注入短值验证定时器路径）。 */
export type AcpManagerLogger = { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };

/** runtime → agentsRuntimeState 通道载荷（底栏状态/上下文仪表数据源）。纯映射，无副作用。 */
export function buildAgentRuntimeState(runtime: AcpAgentRuntime): AgentRuntimeState {
	const usage = runtime.projection.usage;
	// token/缓存/命中率来自 session/prompt 响应的实验性 usage 累计（CLI 不返回时整组缺省）；
	// TTFT/总耗时/TPS 由适配层本地计时，任何流式 CLI 都有值。
	const totals = runtime.usageTotals;
	const perf = runtime.lastReplyPerf;
	const sessionTps = acpSessionTps(totals);
	return {
		isStreaming: runtime.turnActive,
		isTurnActive: runtime.turnActive,
		// 工具名作展示模型位：让底栏显示当前 CLI（如 "Gemini CLI"）。
		modelName: runtime.tool.name,
		provider: "acp",
		modelId: runtime.tool.id,
		todos: runtime.projection.todos,
		// usage_update（opencode/kimi 等非标准但广泛流传的会话用量通知）→ 上下文仪表数据源。
		...(usage?.used !== undefined ? { contextTokens: usage.used } : {}),
		...(usage?.size !== undefined ? { contextWindow: usage.size } : {}),
		...(usage?.used !== undefined && usage?.size !== undefined ? { contextPercent: Math.max(0, Math.min(100, Math.round((usage.used / usage.size) * 1000) / 10)) } : {}),
		...(usage?.costAmount !== undefined ? { cost: usage.costAmount } : {}),
		...(totals
			? {
					inputTokens: totals.inputTokens,
					outputTokens: totals.outputTokens,
					// 缓存/命中率只在 agent 真的上报过缓存字段时下发（Qoder 只报 input/output，
					// 显示一排 0 会让用户以为缓存完全没命中）。
					...(totals.cacheReported
						? {
								cacheRead: totals.cacheRead,
								cacheWrite: totals.cacheWrite,
								cacheTotal: totals.cacheRead + totals.cacheWrite,
								...(totals.cacheHitLatest !== undefined ? { cacheHitPercent: totals.cacheHitLatest } : {}),
								...(totals.cacheHitSamples > 0 ? { cacheHitAveragePercent: totals.cacheHitSum / totals.cacheHitSamples, cacheHitSampleCount: totals.cacheHitSamples } : {}),
							}
						: {}),
				}
			: {}),
		...sessionTps,
		...(perf ? { ttftMs: perf.ttftMs, totalMs: perf.totalMs, tps: perf.tps, endToEndTps: perf.endToEndTps } : {}),
	};
}
