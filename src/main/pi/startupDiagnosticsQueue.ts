import { resolveDisabledExtensionsCopy, resolveDisabledExtensionsReason } from "./extensionStartupFallback";
import type { DisabledExtensionsReason } from "./extensionStartupFallback";

/** 启动期诊断的可选项与 AgentManager.addLocalizedMessage 的 options 同构（含 i18n 参数与调试细节）。 */
export interface StartupDiagnosticOptions {
	params?: import("../../shared/types").I18nParams;
	debugDetails?: string;
	meta?: Record<string, unknown>;
}

/**
 * 暂存中的启动期诊断（扩展回退说明 / 首个 run 前的 extension_error）。
 * 首个 agent_start 到达前不写时间线，避免插进历史轮次与当前消息之间。
 */
export type QueuedStartupDiagnostic = {
	role: "system" | "error";
	i18nKey: string;
	fallbackText: string;
	options?: StartupDiagnosticOptions;
};

/** AgentManager 拆分 Wave 4A：宿主回调只暴露时间线写入、toast 广播、设置读取与 warn 日志。 */
export interface StartupDiagnosticsHost {
	/** 写一条本地化消息进会话时间线（AgentManager.addLocalizedMessage 的窄化版）。 */
	addLocalizedMessage(agentId: string, role: QueuedStartupDiagnostic["role"], i18nKey: string, fallbackText: string, options?: StartupDiagnosticOptions): void;
	/** 广播 agentsNotice（toast）；payload 形态见 AgentManager.notifyExtensionsDisabled 的 emit。 */
	emitNotice(payload: Record<string, unknown>): void;
	/** settingsStore 的 piRpcNoExtensions 当前值（「扩展被禁用」成因判定）。 */
	isNoExtensionsSetting(): boolean;
}

/**
 * 启动期诊断队列（AgentManager 拆分 Wave 4A，2027-02 从 AgentManager 迁出，行为零变化）。
 *
 * 为什么需要暂存：扩展回退说明 / 首个 run 前的 extension_error 到达时，
 * 用户的触发消息还没落盘，直接 append 会插进历史轮次与当前消息之间
 * （用户体感「错误提示跑上旧卡片」）。首个 agent_start 开始时按序落盘：
 * 位于用户消息之后、回答之前，正好在当前活动点上。
 */
export class StartupDiagnosticsQueue {
	private readonly pendingStartupDiagnostics = new Map<string, QueuedStartupDiagnostic[]>();
	/** 已发生过首个 agent_start 的 agent：此后的 extension_error 属于运行期间，直接落盘。 */
	private readonly agentStartedFirstRun = new Set<string>();
	/** 已弹过的「扩展被禁用」成因（本次运行内）：见 notifyExtensionsDisabled。 */
	private readonly disabledExtensionsNoticesSent = new Set<DisabledExtensionsReason>();

	constructor(private readonly host: StartupDiagnosticsHost) {}

	/** 暂存一条启动期诊断，等首个 agent_start 统一落盘（见 pendingStartupDiagnostics）。 */
	queueStartupDiagnostic(agentId: string, diagnostic: QueuedStartupDiagnostic): void {
		const list = this.pendingStartupDiagnostics.get(agentId) ?? [];
		list.push(diagnostic);
		this.pendingStartupDiagnostics.set(agentId, list);
	}

	/** 首个 run 开始：把启动期诊断按序写入时间线（此刻用户消息已就位，位置正确）。 */
	private flushStartupDiagnostics(agentId: string): void {
		const list = this.pendingStartupDiagnostics.get(agentId);
		if (!list || list.length === 0) return;
		this.pendingStartupDiagnostics.delete(agentId);
		for (const diagnostic of list) {
			this.host.addLocalizedMessage(agentId, diagnostic.role, diagnostic.i18nKey, diagnostic.fallbackText, diagnostic.options);
		}
	}

	/**
	 * 按到达时机分流一条诊断：首个 agent_start 之前 = 启动期，暂存等首个 run 落盘；
	 * 之后 = 运行期间，直接写时间线。
	 */
	deliver(agentId: string, diagnostic: QueuedStartupDiagnostic): void {
		if (!this.agentStartedFirstRun.has(agentId)) {
			this.queueStartupDiagnostic(agentId, diagnostic);
		} else {
			this.host.addLocalizedMessage(agentId, diagnostic.role, diagnostic.i18nKey, diagnostic.fallbackText, diagnostic.options);
		}
	}

	/** 首个 agent_start：flush 暂存诊断并标记此后为运行期（两个动作必须成对）。 */
	markFirstRun(agentId: string): void {
		this.flushStartupDiagnostics(agentId);
		this.agentStartedFirstRun.add(agentId);
	}

	/** 生命周期清理：重启/关闭后新 runtime 重新队列。 */
	clear(agentId: string): void {
		this.pendingStartupDiagnostics.delete(agentId);
		this.agentStartedFirstRun.delete(agentId);
	}

	/**
	 * 回退成功或设置开关生效时的统一说明：已禁用扩展，附上可粘贴给 AI 的 stderr。
	 *  不立即写时间线，等首个 run（用户消息之后）落盘，避免插进历史轮次中间。
	 *  设置开关（piRpcNoExtensions）是持续成因：只弹一次 toast，避免每个新会话连发；
	 *  用户反馈过「设置里一直是禁用扩展启动但没人提示」，能力静默缺失比报错更难发现。
	 */
	notifyExtensionsDisabled(agentId: string, input: { fallbackFromExtensions: boolean; debugDetails?: string }): void {
		const reason = resolveDisabledExtensionsReason({
			settingDisabled: this.host.isNoExtensionsSetting(),
			fallbackFromExtensions: input.fallbackFromExtensions,
		});
		if (!reason) return;
		const copy = resolveDisabledExtensionsCopy(reason);
		this.queueStartupDiagnostic(agentId, {
			role: "system",
			i18nKey: copy.diagnosticKey,
			fallbackText: copy.diagnosticFallback,
			...(input.debugDetails ? { options: { debugDetails: input.debugDetails } } : {}),
		});
		// toast 每个成因每次运行只弹一次：进程自动重连/连续新建会话都会走到这里，重复弹会刷屏。
		if (this.disabledExtensionsNoticesSent.has(reason)) return;
		this.disabledExtensionsNoticesSent.add(reason);
		this.host.emitNotice({
			agentId,
			message: copy.noticeFallback,
			i18nKey: copy.noticeKey,
			kind: "warning",
			duration: copy.noticeDurationMs,
			...(copy.noticeAction ? { action: copy.noticeAction } : {}),
		});
	}
}
