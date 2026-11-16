/**
 * ACP runtime 诊断物料：stderr 尾部缓冲与非标准通知留样本（纯函数/常量）。
 *
 * 从 AcpAgentManager 抽出：这两样是「空白回合/莫名失败」时唯一可用的原始证据
 * （限流、登录失败、协议外通道报错都只出现在这里），但都不参与回合成败判定——
 * 随拒收结果带进 UI 与日志即可。
 */
import type { AcpAgentRuntime } from "./acpAgentRuntime";
import type { AcpRpcNotification } from "./acpProtocol";

/** CLI 诊断输出(stderr)尾部:只留最近几行且每行截断,仅供空白回合诊断/日志,不进时间线。 */
const STDERR_TAIL_LINES = 5;
const STDERR_LINE_MAX_CHARS = 200;

export function pushStderrTail(runtime: AcpAgentRuntime, text: string): void {
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line) runtime.stderrTail.push(line.slice(0, STDERR_LINE_MAX_CHARS));
	}
	if (runtime.stderrTail.length > STDERR_TAIL_LINES) runtime.stderrTail.splice(0, runtime.stderrTail.length - STDERR_TAIL_LINES);
}

/** 非 session/update 通知留样本（诊断）：只保留最后一条，截断防长帧污染 UI。 */
export function rememberTurnNotification(runtime: AcpAgentRuntime, notification: AcpRpcNotification): void {
	const method = notification.method ?? "";
	// config_option_update 是已知通道（握手期即处理），不算异常信号。
	if (!method || method === "session/update" || method === "config_option_update") return;
	runtime.turnForeignNotification = `${method}: ${JSON.stringify(notification).slice(0, 300)}`;
}
