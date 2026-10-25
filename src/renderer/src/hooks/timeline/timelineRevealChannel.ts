/**
 * 时间线「按 entryId 定位」的渲染层单通道。
 *
 * 为什么独立成无依赖模块：消费方是 SessionMessageTimeline（只要事件名与轮询计划），
 * 而 useHostPluginNavigation 的依赖链会经 desktopApi → browserApi 在模块求值时读
 * window.location.search。时间线组件一旦直接 import 那个 hook，单测的极简 DOM 沙箱
 * 就会在加载阶段炸掉（2026-10 全量回归实测）。这里只放常量与纯函数，谁都能安全引用。
 */
export const REVEAL_TIMELINE_ENTRY_EVENT = "pideck:reveal-timeline-entry";
export const REVEAL_TIMELINE_ENTRY_TIMEOUT_MS = 4000;
export const REVEAL_TIMELINE_ENTRY_POLL_MS = 120;
/** 重派间隔（ms）：首次派发时监听方可能还没挂载（会话正在切换），只发一次会让事件永久丢失。 */
export const REVEAL_TIMELINE_ENTRY_REDISPATCH_MS = 900;

export type RevealAttemptPlan = {
	action: "scroll" | "dispatch" | "wait" | "give-up";
	keepPolling: boolean;
};

/**
 * 单次轮询的决策（纯函数，可单测）。
 *
 * - DOM 直接命中且从未派发事件：未虚拟化的老路径，自己滚进视野；
 * - DOM 直接命中但已派发：目标行是时间线响应事件后 jumpToMessage 挂出来的，
 *   controller 已完成精确落位，不再重复滚动，也不继续轮询；
 * - 未命中且未派发：派发一次渲染层事件（虚拟区外的行只能靠它进 DOM）；
 * - 已派发但监听方当时还没挂载（会话切换中）：按 REDISPATCH 间隔重派，事件可安全重复消费
 *   （jumpToMessage 幂等：命中已挂载行时只是重新落位）；
 * - 其余未命中：继续轮询到超时，等监听端把行挂出来。
 *
 * 注意：超时只停「本 hook 自己的轮询」，停不掉 controller 的 pendingJump ——
 * 冷会话里目标数据还没上屏时，跳转由 controller 挂起并在数据到达后自行落位。
 */
export function planRevealAttempt(input: { found: boolean; eventDispatched: boolean; elapsedMs: number; timeoutMs?: number; sinceDispatchMs?: number }): RevealAttemptPlan {
	if (input.found) return { action: input.eventDispatched ? "wait" : "scroll", keepPolling: false };
	if (input.elapsedMs >= (input.timeoutMs ?? REVEAL_TIMELINE_ENTRY_TIMEOUT_MS)) return { action: "give-up", keepPolling: false };
	if (!input.eventDispatched) return { action: "dispatch", keepPolling: true };
	if ((input.sinceDispatchMs ?? 0) >= REVEAL_TIMELINE_ENTRY_REDISPATCH_MS) return { action: "dispatch", keepPolling: true };
	return { action: "wait", keepPolling: true };
}

/**
 * 冷会话里「目标不在已加载数据」是否只是「还没到」，应挂起等待而不是放弃。
 *
 * 判据（单测钉住）：会话还没有任何消息投影、或首屏/补页仍在加载 —— 这两种情况下
 * targetIndex < 0 不能当成「目标不存在」。旧实现直接放弃，宿主插件按 entryId 导航到
 * 尚未加载消息的会话时静默失效（#401 复审 P0）。
 */
export function shouldDeferJumpUntilLoaded(input: { targetIndex: number; messageCount: number; surfaceLoading: boolean }): boolean {
	if (input.targetIndex >= 0) return false;
	if (input.messageCount === 0) return true;
	return input.surfaceLoading;
}
