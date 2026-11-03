/**
 * Web 端会话历史首屏加载的判定（纯函数，供 WebChatApp 与单测共用）。
 *
 * 背景（2027-02 用户反馈）：ACP 会话的历史只存在 agent CLI 侧——PiDeck 侧只有
 * 运行时投影 / 落盘归档 / 内存快照。冷会话（应用重启后第一次打开、或从未启动过）
 * 没有 runtime 时，服务端读不到 agent 侧历史，直接返回空数组；前端没有加载态，
 * 用户看到的是「空白会话页」。桌面端选中会话即后台激活 runtime（session/load 重放），
 * Web 端此前没有这条链路。
 *
 * 另一个更隐蔽的空白来源：ACP runtime 启动/重连窗口内投影为空，一次空结果如果
 * 覆盖了本地已有缓存，切走再切回就会一直空白。历史在 ACP 里不可删除，所以空结果
 * 永远不是「历史被清空」的权威信号。
 */
import type { AgentBackend } from "../../../shared/types";

/** 时间线首屏阶段：loading 显示骨架，error 显示重试入口。 */
export type WebHistoryPhase = "loading" | "error";

/**
 * 一次历史刷新结果是否可以覆盖本地缓存。
 *
 * - nextCount > 0：有内容，直接应用。
 * - 非 ACP：pi/DSH 的历史有本地权威源（JSONL / host 事件流），空结果就是真的空。
 * - ACP + runtime 未就绪（无 runtime / starting）：服务端只有空投影，保留已有内容，
 *   并让首屏继续停在 loading——激活完成后会重拉。
 * - ACP + 已有内容：空结果只能是瞬态（ACP 不支持删除历史），保留缓存。
 */
export function shouldApplyHistorySnapshot(input: { backend?: AgentBackend; nextCount: number; previousCount: number; acpRuntimePending: boolean }): boolean {
	if (input.nextCount > 0) return true;
	if (input.backend !== "acp") return true;
	if (input.acpRuntimePending) return false;
	return input.previousCount === 0;
}

/**
 * 磁盘快照是否「落后于在途流」（不可用来覆盖本地时间线）。
 *
 * 本端 SSE 还在收帧时，磁盘上的会话文件必然慢于已渲染内容（pi 通常在一段内容
 * 结束后才落盘）。此时拉到的窗口可能比本地还短——套用就会把正在出的回复抹掉
 * （用户报障：发消息后最新一条回复消失、过一会才又出现）。反过来说，磁盘比本地
 * 长就说明本地那轮流早就死了（手机后台节流、切网），正是落盘追赶该生效的场合。
 */
export function isStaleAgainstLiveStream(input: { localStreamLive: boolean; nextCount: number; previousCount: number }): boolean {
	return input.localStreamLive && input.nextCount < input.previousCount;
}

/**
 * 打开 ACP 会话时是否要后台激活 runtime 以恢复 agent 侧历史。
 *
 * 与桌面 ComposerArea 的 ACP 预热同源：选中即激活，握手时 session/load 重放历史。
 * 已有 runtime（starting/running/idle）时由它自己重放，不重复激活；
 * attempted 由调用方按会话记录，避免状态轮询让 effect 反复触发。
 */
export function shouldActivateAcpHistory(input: { backend?: AgentBackend; hasRuntime: boolean; attempted: boolean }): boolean {
	return input.backend === "acp" && !input.hasRuntime && !input.attempted;
}
