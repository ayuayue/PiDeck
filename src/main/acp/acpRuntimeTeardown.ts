/**
 * ACP runtime 的停机路径：定时器收尾 → 关连接 → 杀进程树（立即/有序两种）。
 *
 * 从 AcpAgentManager 抽出：两条停止路径（killProcess 立即强杀用于握手失败与断线重连，
 * shutdownProcess 有序停止用于正常 stop）共用同一段「先清定时器再关连接」的前置动作，
 * 放在一处才不会出现只改一条路径的漂移。所有状态都在 runtime 上，这里只按参数动作。
 */
import type { AcpTurnWatchdog } from "./acpTurnWatchdog";
import type { AcpAgentRuntime } from "./acpAgentRuntime";
import { killAcpProcessTree, shutdownAcpProcess } from "./AcpProcessHost";

/** flush 批处理 + 回合看门狗的定时器收尾；两条停止路径共用。 */
export function clearAcpRuntimeTimers(runtime: AcpAgentRuntime, watchdog: AcpTurnWatchdog): void {
	if (runtime.flushTimer) {
		clearTimeout(runtime.flushTimer);
		runtime.flushTimer = null;
		runtime.flushPending = false;
	}
	watchdog.clearTurnTimers(runtime);
}

/** 立即强杀：握手失败/断线重连/替旧进程时用（进程或连接已死，没有可等的收尾）。 */
export function killAcpRuntimeProcess(runtime: AcpAgentRuntime, watchdog: AcpTurnWatchdog): void {
	clearAcpRuntimeTimers(runtime, watchdog);
	runtime.conn?.close();
	const proc = runtime.proc;
	if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
	runtime.proc = null;
	// 进程树击杀(Windows taskkill /T + 兑底 proc.kill)见 AcpProcessHost.killAcpProcessTree。
	killAcpProcessTree(proc);
}

/**
 * 有序停止（issue #475）：结算在途请求 → 关 stdin → 等 CLI 自己退出（跑 SessionEnd
 * 钩子/自身清理），宽限到点仍未退出才整树强杀。与 pi 侧 LocalPiRuntimeLauncher 的
 * stop 对齐（#450）；握手失败/断线重连仍走 killProcess 的立即强杀（进程/连接已死，
 * 没有可等的收尾）。
 */
export async function shutdownAcpRuntimeProcess(runtime: AcpAgentRuntime, watchdog: AcpTurnWatchdog, gracefulExitMs: number | undefined): Promise<void> {
	clearAcpRuntimeTimers(runtime, watchdog);
	runtime.conn?.close();
	const proc = runtime.proc;
	if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
	runtime.proc = null;
	await shutdownAcpProcess(proc, { gracefulExitMs });
}
