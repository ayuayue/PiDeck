/**
 * 全局通知（#115 U5 收尾）：统一走 sonner（shadcn 官方 toast）。
 * 保留 showNotice(message, duration, kind) 旧 API，调用点零改动；
 * kind 映射 sonner 的 error/warning/info 变体。
 *
 * Toaster 未挂载（App 尚未启动 / 渲染树崩溃）时回退到 DOM toast，
 * 保证全局错误处理仍能给用户可见反馈。
 */

import { toast } from "sonner";
import { t } from "../i18n";

type NoticeData = {
	message: string;
	duration: number;
	kind?: "info" | "error" | "warning";
};

let fallbackHost: HTMLDivElement | null = null;

// sonner 2.x 在没有可见 toast 时不会渲染任何 DOM（源码里 `if (!filteredToasts.length) return null`），
// 因此不能用 DOM 查询该属性来探测挂载态——那会在每次首个 toast 前都误判为未挂载，
// 导致所有通知永远走黑色 DOM 兜底。挂载状态改由 Toaster 组件挂载时显式回报。
let toasterReady = false;

export function setToasterReady(ready: boolean) {
	toasterReady = ready;
}

function ensureFallbackHost() {
	if (fallbackHost && document.body.contains(fallbackHost)) return fallbackHost;
	const host = document.createElement("div");
	host.id = "app-notice-fallback-host";
	host.setAttribute("aria-live", "polite");
	// 与 sonner 的 top-right 位置保持一致，并让开标题栏拖拽区，避免兑底与正式 toast 位置跳动
	host.style.cssText = [
		"position:fixed",
		"top:calc(var(--window-drag-height, 0px) + 12px)",
		"right:16px",
		"z-index:2147483000",
		"display:flex",
		"flex-direction:column",
		"align-items:flex-end",
		"gap:8px",
		"pointer-events:none",
		"max-width:min(520px, calc(100vw - 32px))",
		"-webkit-app-region:no-drag"
	].join(";");
	document.body.appendChild(host);
	fallbackHost = host;
	return host;
}

/** 关闭兜底通知并回收宿主节点；持久 Ask 通知只能通过这个按钮结束。 */
function dismissFallbackNotice(item: HTMLDivElement, host: HTMLDivElement) {
	item.remove();
	if (host.childElementCount === 0) {
		host.remove();
		if (fallbackHost === host) fallbackHost = null;
	}
}

/** Toaster 未挂载时的 DOM 兜底 toast，避免全局异常完全静默。 */
function showFallbackNotice(message: string, duration: number, kind: NoticeData["kind"] = "info") {
	if (typeof document === "undefined") return;
	const host = ensureFallbackHost();
	const item = document.createElement("div");
	// 与 sonner 卡片同一套中性面板样式（走 CSS 变量，主题自动适配）；
	// kind 只保留可访问性语义，不叠加高饱和色竖条，避免 fallback 与正式 toast 视觉分裂。
	item.style.cssText = [
		"position:relative",
		"pointer-events:auto",
		"padding:12px 40px 12px 14px",
		"border-radius:10px",
		"background:var(--color-bg-panel, #ffffff)",
		"color:var(--color-text-primary, #1f2328)",
		"border:1px solid var(--color-border-subtle, rgba(0,0,0,0.08))",
		"box-shadow:var(--shadow-popover, 0 4px 12px rgba(0,0,0,0.12))",
		"font:500 13px/1.4 var(--font-family-base, system-ui,-apple-system,Segoe UI,sans-serif)",
		"word-break:break-word",
	].join(";");
	item.setAttribute("role", kind === "error" ? "alert" : "status");
	const close = document.createElement("button");
	close.type = "button";
	close.textContent = "×";
	close.setAttribute("aria-label", t("common.close"));
	close.title = t("common.close");
	close.style.cssText = [
		"position:absolute",
		"top:8px",
		"right:8px",
		"width:24px",
		"height:24px",
		"border:0",
		"border-radius:6px",
		"background:transparent",
		"color:var(--color-text-tertiary,#8b8f94)",
		"font:600 18px/1 system-ui,sans-serif",
		"cursor:pointer",
	].join(";");
	close.addEventListener("click", () => dismissFallbackNotice(item, host));
	item.appendChild(document.createTextNode(message));
	item.appendChild(close);
	host.appendChild(item);
	if (Number.isFinite(duration)) {
		window.setTimeout(() => dismissFallbackNotice(item, host), Math.max(1200, duration));
	}
}

/**
 * sonner 的 toast() 在 Toaster 未挂载（启动早期/渲染树崩溃）时静默丢弃，
 * 此时走 DOM 兜底，保证全局异常仍能给用户可见反馈。
 */
function toasterMounted() {
	return toasterReady;
}

export function showNotice(message: string, duration?: number, kind?: NoticeData["kind"]) {
	const resolvedDuration = duration ?? (kind === "error" || kind === "warning" ? 3000 : 1500);
	const text = String(message ?? "").trim();
	if (!text) return;
	if (!toasterMounted()) {
		showFallbackNotice(text, resolvedDuration, kind);
		return;
	}
	const options = { duration: resolvedDuration };
	if (kind === "error") toast.error(text, options);
	else if (kind === "warning") toast.warning(text, options);
	else if (kind === "info") toast.info(text, options);
	else toast(text, options);
}
