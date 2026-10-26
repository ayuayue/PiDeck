/**
 * ACP 回合看门狗：abort 升级强杀宽限 + 回合 stall 静默检测。
 *
 * 从 AcpAgentManager 抽出的协作者（纯定时器编排，不含进程管理）：
 * - abort 升级：用户停止/看门狗代发 cancel 后的宽限；宽限内回合自行结算则
 *   clearTurnTimers 取消，超时仍未结算则升级强杀（CLI wedged 不处理 cancel 的实测兑底）。
 * - stall 看门狗：回合内长时间无任何 session/update 且无挂起审批 → 先补发
 *   session/cancel（agent 可能只是模型侧卡住），再经 abort 升级宽限强杀。
 * 强杀出口经 host.forceStop 回到 manager 的 stop() 同一路径（杀进程 → conn.close →
 * 在途 prompt 被拒 → sendPrompt catch 定向结算），本模块不直接杀进程。
 * runtime 归属校验（ownsRuntime）保证 stop/重建后的旧定时器不再作用于新 runtime。
 */
import type { AcpAbortEscalationReason, AcpAgentRuntime } from "./acpAgentRuntime";

/** abort 后等 CLI 自行收口的宽限;超时回合仍未结算则升级强杀(CLI wedged 不处理 cancel 的实测兑底)。 */
const ABORT_ESCALATION_MS = 5_000;
/** 回合内全静默(无任何 session/update 且无挂起审批)的 stall 判定阈值;深思回合正常也有 thought/tool 流。 */
const PROMPT_STALL_TIMEOUT_MS = 90_000;

export type AcpTurnWatchdogHost = {
	/** runtime 归属校验：stop/重建后旧定时器不得再作用于新 runtime。 */
	ownsRuntime(runtime: AcpAgentRuntime): boolean;
	/** 升级强杀出口（cancel 宽限超时/stall 两级收口）：由 manager 提供，走 stop() 同一路径。 */
	forceStop(runtime: AcpAgentRuntime, reason: AcpAbortEscalationReason): void;
	logger?: { info(channel: string, message: string, meta?: Record<string, unknown>): void; warn(channel: string, message: string, meta?: Record<string, unknown>): void };
	/** abort 升级强杀宽限(默认 5s)。测试注入短值验证升级路径。 */
	abortEscalationMs?: number;
	/** 回合无输出 stall 判定阈值(默认 90s)。测试注入短值验证看门狗。 */
	promptStallTimeoutMs?: number;
};

export class AcpTurnWatchdog {
	constructor(private readonly host: AcpTurnWatchdogHost) {}

	/** 清回合辅助定时器（abort 升级宽限/stall 看门狗）；回合结算、stop、连接死亡共用。 */
	clearTurnTimers(runtime: AcpAgentRuntime): void {
		this.clearAbortEscalation(runtime);
		this.clearStallWatchdog(runtime);
	}

	clearAbortEscalation(runtime: AcpAgentRuntime): void {
		if (runtime.abortEscalateTimer) {
			clearTimeout(runtime.abortEscalateTimer);
			runtime.abortEscalateTimer = null;
		}
	}

	clearStallWatchdog(runtime: AcpAgentRuntime): void {
		if (runtime.stallTimer) {
			clearInterval(runtime.stallTimer);
			runtime.stallTimer = null;
		}
	}

	/** armed abort 升级：宽限内回合自行结算则 clearTurnTimers 取消；超时仍未结算强杀。 */
	scheduleAbortEscalation(runtime: AcpAgentRuntime, reason: "abort_no_response" | "stall"): void {
		if (runtime.abortEscalateTimer || !runtime.turnActive) return;
		runtime.abortEscalateTimer = setTimeout(() => {
			runtime.abortEscalateTimer = null;
			if (!this.host.ownsRuntime(runtime) || !runtime.turnActive) return;
			this.host.forceStop(runtime, reason);
		}, this.host.abortEscalationMs ?? ABORT_ESCALATION_MS);
		runtime.abortEscalateTimer.unref?.();
	}

	/**
	 * 回合 stall 看门狗：派发时布防，interval 检查 turnActive 期间是否长时间无任何
	 * session/update。全静默超阈值 → 先补发 cancel（agent 可能只是模型侧卡住，还活着），
	 * 再经 abort 升级宽限强杀——两级都由 host.forceStop 收口。
	 * 挂起审批与在途工具调用不算静默：那都是 agent 合法等待（用户输入/工具执行）。
	 */
	armStallWatchdog(runtime: AcpAgentRuntime): void {
		this.clearStallWatchdog(runtime);
		runtime.lastUpdateAt = Date.now();
		const timeoutMs = this.host.promptStallTimeoutMs ?? PROMPT_STALL_TIMEOUT_MS;
		const intervalMs = Math.max(50, Math.min(5_000, Math.floor(timeoutMs / 3)));
		runtime.stallTimer = setInterval(() => {
			if (!this.host.ownsRuntime(runtime) || !runtime.turnActive) {
				this.clearStallWatchdog(runtime);
				return;
			}
			if (runtime.permissions.hasPending()) return;
			// 在途工具调用不算静默：那是 agent 合法等待工具结束（npm install/构建/测试等
			// 长命令在 tool_call started→completed 之间可长时间无流式输出），与挂起审批同等
			// 豁免。刷新静默基准=工具收口后重新起算；真悬死由回合兑底超时收口（#411）。
			if (runtime.inFlightToolCalls.size > 0) {
				runtime.lastUpdateAt = Date.now();
				return;
			}
			if (Date.now() - runtime.lastUpdateAt < timeoutMs) return;
			this.clearStallWatchdog(runtime);
			runtime.cancelling = true;
			runtime.cancelReason = "stall";
			runtime.permissions.cancelAll();
			try {
				runtime.conn?.notify("session/cancel", { sessionId: runtime.acpSessionId, reason: "stall" });
			} catch {
				// 连接已死:closed handler 会结算,这里不再补刀。
			}
			this.scheduleAbortEscalation(runtime, "stall");
		}, intervalMs);
		runtime.stallTimer.unref?.();
	}
}
