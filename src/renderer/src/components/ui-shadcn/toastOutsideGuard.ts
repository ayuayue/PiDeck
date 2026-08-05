/**
 * Radix DismissableLayer 把「内容外的指针按下」当作外部交互并默认关闭弹框。
 * 全局 toast（sonner toaster / DOM 兜底）渲染在 dialog 内容之外，
 * 点 toast 的关闭按钮会被误判为「点击弹框外部」而连带关闭弹框。
 * 两个 shadcn 弹框包装层（dialog / alert-dialog）统一用此判定拦截：
 * 来自 toast 区域的外部交互一律 preventDefault，弹框保持打开。
 */

// Radix 的 outside 事件是 CustomEvent，真实指针目标在 detail.originalEvent.target 上
export type OutsideInteractionEvent = {
  target: EventTarget | null;
  preventDefault: () => void;
  detail?: { originalEvent?: Event };
};

const TOAST_REGION_SELECTOR = "[data-sonner-toaster], #app-notice-fallback-host";

/** 判定外部交互是否来自全局 toast 区域；命中后调用方应 event.preventDefault() 阻止弹框关闭 */
export function isOutsideInteractionFromToast(event: OutsideInteractionEvent): boolean {
  const target = event.detail?.originalEvent?.target ?? event.target;
  return target instanceof Element && Boolean(target.closest(TOAST_REGION_SELECTOR));
}
