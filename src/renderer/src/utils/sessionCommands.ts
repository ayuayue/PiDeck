import type {
	SessionCommandError,
	SessionCommandResult,
	SessionRuntimeTarget,
} from "../../../shared/types";
import { t, type TranslationKey } from "../i18n";

/**
 * 取消息携带的文件条目 id（meta.entryId）。meta 是 Record<string, unknown>，
 * 这里收窄成 string；编辑/删除/重发用它对 JSONL 做锚点定位（live randomUUID 无效）。
 */
export function messageEntryId(message: { meta?: Record<string, unknown> | undefined } | undefined): string | undefined {
	return typeof message?.meta?.entryId === "string" ? message.meta.entryId : undefined;
}

const SESSION_COMMAND_ERROR_KEYS: Record<SessionCommandError["code"], TranslationKey> = {
	SESSION_NOT_FOUND: "sessionCommand.sessionNotFound",
	MESSAGE_NOT_FOUND: "sessionCommand.messageNotFound",
	SESSION_RUNTIME_UNAVAILABLE: "sessionCommand.runtimeUnavailable",
	SESSION_RUNTIME_CHANGED: "sessionCommand.runtimeChanged",
	SESSION_RUNTIME_BUSY: "sessionCommand.runtimeBusy",
	SESSION_COMMAND_FAILED: "sessionCommand.commandFailed",
	SESSION_MODEL_NOT_FOUND: "sessionCommand.modelNotFound",
};

export class SessionCommandFailure extends Error {
	readonly code: SessionCommandError["code"];
	readonly params?: SessionCommandError["params"];
	readonly debugDetails?: string;
	/** 模型在本地 models.json 存在但运行中 Agent 未加载：需重启 Agent 生效。 */
	readonly needsRestart?: boolean;

	constructor(error: SessionCommandError) {
		super(t(SESSION_COMMAND_ERROR_KEYS[error.code], error.params));
		this.name = "SessionCommandFailure";
		this.code = error.code;
		this.params = error.params;
		this.debugDetails = error.debugDetails;
		this.needsRestart = error.needsRestart;
	}
}

export function requireSessionCommand<T>(result: SessionCommandResult<T>): T {
	if (result.ok) return result.value;
	throw new SessionCommandFailure(result.error);
}

const DEBUG_DETAILS_TOAST_MAX = 140;

/**
 * 会话命令失败 toast：稳定 i18n 文案不够定位时（如「会话操作失败，请重试」），
 * 附带 debugDetails 原文，避免用户只能看到泛化失败、开发者也看不到日志。
 */
export function sessionCommandFailureToast(
	error: unknown,
	translateRaw?: (message: string) => string,
): string {
	const raw = error instanceof Error ? error.message : String(error);
	const message = translateRaw ? translateRaw(raw) : raw;
	const details = error instanceof SessionCommandFailure
		? error.debugDetails?.trim()
		: undefined;
	if (!details || details === raw || details === message) return message;
	const clipped = details.length > DEBUG_DETAILS_TOAST_MAX
		? `${details.slice(0, DEBUG_DETAILS_TOAST_MAX)}…`
		: details;
	return `${message}（${clipped}）`;
}

/**
 * 判定运行时状态是否仍可接受命令（live）。
 * starting/idle/running 才是「进程仍在、可接收命令」的 live 状态；error/closed 是终态
 * （进程已失败/已关闭），detached 是已解绑，undefined 表示没有运行时——均不可作为
 * 重启/停止/重发等运行时命令的目标，也不应显示「重启」入口。
 */
export function isLiveRuntimeStatus(status?: string | null): boolean {
	return status === "starting" || status === "idle" || status === "running";
}

export function toSessionRuntimeTarget(
	sessionId: string,
	runtime: { agentId?: string; runtimeGeneration?: number; status?: string | null } | undefined,
): SessionRuntimeTarget | undefined {
	// target 只表达「会话 → 当前绑定运行实例」的句柄，不做 live 判定：
	// stop/restart 对 error/closed 终态 Agent 仍有效（主进程幂等 stop + 重启重建），
	// 而「重发是否需要先停」这类 live 判定由各调用点用 isLiveRuntimeStatus 单独判断。
	if (!runtime?.agentId || runtime.runtimeGeneration === undefined) return undefined;
	return {
		sessionId,
		agentId: runtime.agentId,
		runtimeGeneration: runtime.runtimeGeneration,
	};
}

// ── 会话运行控制策略（全状态可操作）──
//
// 产品规则：任意状态的会话都必须能操作运行控制，不为「没进程」「进程死了」
// 这类中间态留死角。但不同状态下的「启动/停止/重启/重载」语义并不相同，
// 因此把判定收敛成纯函数，UI 只消费结论、不做 if/else 分叉。

/**
 * 会话运行状态全集（含「无进程」两类）：
 * - `starting` / `idle` / `running`：live（进程在，可接收命令）
 * - `error` / `closed`：终态（进程已失败/已关闭，绑定可能仍在）
 * - `detached`：已解绑（前端视图态，主进程无绑定）
 * - `unstarted`：从未启动（有会话记录，无任何 runtime）
 *
 * `detached` 与 `unstarted` 对外行为一致（都走 activate），分开命名只为日志可读。
 */
export type SessionRunState =
	| "starting"
	| "idle"
	| "running"
	| "error"
	| "closed"
	| "detached"
	| "unstarted";

export type SessionRunAction = "start" | "stop" | "restart" | "reload";

export interface SessionRunCapabilities {
	/** 归一化后的运行状态（UI 可直接用于文案/徽章） */
	state: SessionRunState;
	/** 是否持有可用绑定（agentId + runtimeGeneration）；终态也可能持有 */
	hasBinding: boolean;
	/** 「主控按钮」语义：unstarted/detached/error/closed → start；live → restart */
	primaryAction: "start" | "restart";
	canStart: boolean;
	canStop: boolean;
	canRestart: boolean;
	canReload: boolean;
	/** 主控动作会杀掉正在执行的对话，UI 必须先确认 */
	requiresConfirm: boolean;
	/** 是否处于过渡态（starting / 正在重启），用于置灰与 spinner */
	pending: boolean;
}

/** 归一化运行状态：把 undefined / detached / 未知值统一成 `unstarted`/`detached`。 */
export function resolveSessionRunState(
	runtime: { status?: string | null } | undefined,
	hasBinding: boolean,
): SessionRunState {
	switch (runtime?.status) {
		case "starting":
		case "idle":
		case "running":
		case "error":
		case "closed":
			return runtime.status;
		case "detached":
			return "detached";
		default:
			// 没有 runtime 行（或状态缺失）：有绑定视为已解绑，否则视为从未启动。
			return hasBinding ? "detached" : "unstarted";
	}
}

/**
 * 全状态运行控制策略（纯函数，可单测）。
 *
 * `busy` 表达「该会话上有互斥操作正在进行」（重启中/激活中/重载中），
 * 过渡态下不再放开第二个动作，避免并发把绑定打乱。
 */
export function sessionRunCapabilities(input: {
	state: SessionRunState;
	hasBinding: boolean;
	busy?: boolean;
	/** 队列里还有 sending/unknown 的排队消息时禁止重启，避免丢消息。 */
	hasInFlightQueuedPrompt?: boolean;
}): SessionRunCapabilities {
	const { state, hasBinding } = input;
	const busy = Boolean(input.busy);
	const isLive = isLiveRuntimeStatus(state);
	// 终态（error/closed）虽然还持有绑定，但进程已死：语义上要「启动」而不是「重启」。
	const isTerminal = state === "error" || state === "closed";
	const needsStart = state === "unstarted" || state === "detached" || isTerminal;

	// starting 期间进程已 fork 但尚未握手完成：启动/重启会造成竞争，必须挡住；
	// 但「停止」保留可用——进程卡在启动阶段时用户需要一个手动中断的出口。
	const canStart = state !== "starting" && !busy && (needsStart || isLive);
	// 停止对 live（含 starting）生效，用于中断卡在启动阶段的进程；
	// 终态没有可停的进程，改由「启动」重建（见 canStart 分支）。
	const canStop = isLive && !busy;
	// 重载是从磁盘刷新消息文件：live 时内存里有流式消息，强刷会覆盖，
	// 因此只对「无进程」状态开放（终态/未启动/已解绑）。
	const canReload = !isLive && !busy;

	return {
		state,
		hasBinding,
		primaryAction: needsStart ? "start" : "restart",
		canStart,
		canStop,
		canRestart: canStart && !input.hasInFlightQueuedPrompt,
		canReload,
		// 主控按钮在 live 态是「重启进程」：会中断当前回答，必须先确认。
		requiresConfirm: isLive,
		pending: state === "starting" || busy,
	};
}

/** 单条动作在该状态下是否可用（供菜单逐项置灰）。 */
export function canRunSessionAction(
	capabilities: SessionRunCapabilities,
	action: SessionRunAction,
): boolean {
	switch (action) {
		case "start":
		case "restart":
			return capabilities.canRestart;
		case "stop":
			return capabilities.canStop;
		case "reload":
			return capabilities.canReload;
	}
}

// ── 会话代理设置的生效方式 ──

export type ProxyApplyStrategy =
	/** 会话正在运行（且可重启）：保存后自动重启进程，代理立即生效 */
	| "restart-now"
	/** 无进程：下次启动会话时自然生效，无需额外动作 */
	| "next-start"
	/** DSH 共享 host：不能按会话重启（会波及所有 DSH 会话），只提示 */
	| "dsh-host-restart";

/**
 * 决定「会话代理设置」保存后如何生效（纯函数，可单测）。
 *
 * 代理注入在子进程 spawn env 上，**进程不重建就不会重新读到新值**。此前 UI 的做法是
 * 统一提示「重启该会话后生效」，用户得自己走「停止 → 启动」两步；本函数存在的意义就是
 * 把这套判定收敛掉，让 UI 在可重启时直接自动重启（一步生效）。
 *
 * - DSH 优先判定：其会话共享单一 host，按会话重启会杀掉全部 DSH 会话，永远不自动重启。
 * - 只有 live（starting/idle/running）才值得重启：终态进程已死，下次启动自然读新配置。
 */
export function resolveProxyApplyStrategy(input: {
	backend?: string;
	hasBinding: boolean;
	isLive: boolean;
}): ProxyApplyStrategy {
	if (input.backend === "dsh") return "dsh-host-restart";
	if (input.hasBinding && input.isLive) return "restart-now";
	return "next-start";
}
