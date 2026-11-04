import { useAtomValue } from "jotai";
import { sessionRuntimeBySessionIdAtomFamily } from "../atoms";
import { acpToolsAtom } from "../atoms/acp-atoms";
import { sessionRecordByIdAtomFamily } from "../atoms/session-selectors";
import { resolveAcpRestoreHint, type AcpRestoreHint } from "../utils/acpSessionRestore";

/** ACP 历史恢复提示（未激活 / 激活中）；非 ACP 或已恢复返回 undefined。 */
export function useAcpRestoreHint(sessionId: string): AcpRestoreHint | undefined {
	const record = useAtomValue(sessionRecordByIdAtomFamily(sessionId));
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(sessionId));
	const tools = useAtomValue(acpToolsAtom);
	return resolveAcpRestoreHint(record, runtime, tools);
}

/**
 * ACP 历史「一定会被激活重放填进来」的窗口期。
 *
 * ACP 的历史存在 agent CLI 侧，激活（spawn + session/load 重放）之前时间线是空的。
 * 输入框宿主必须在这个窗口期就钉在底部——否则用户先在居中起始页里打字，重放落地那
 * 一刻 activeMessages 从 0 变成 N，输入框从居中换成列底（卸载重建），正在输入的字与
 * 焦点一起丢（pi 有本地历史文件、DSH 是常驻 host，首帧就有消息，不会踩到）。
 *
 * 工具被删（tool-missing）不算：那条路径历史永远不会恢复，保持居中起始页 + 引导条。
 */
export function useAcpHistoryRestorePending(sessionId: string): boolean {
	return useAcpRestoreHint(sessionId)?.kind === "restore";
}
