/**
 * 全局通知（#115 U5 收尾）：统一走 sonner 全局 toast。
 * 保留 showNotice(message, duration, kind, title, actions, id) 旧 API，调用点零改动；
 * 单条 toast 由 toast.custom 渲染的自定义卡片 NoticeToastCard 承载
 * （图标 + 标题/正文 + 复制/关闭 + 操作按钮），kind 映射 error/warning/info/neutral 图标。
 *
 * Toaster 未挂载（App 尚未启动 / 渲染树崩溃）时回退到 DOM toast，
 * 保证全局错误处理仍能给用户可见反馈。
 */

import { createElement } from "react";
import { toast } from "sonner";
import { NoticeToastCard, writeClipboardText } from "../components/ui-shadcn/notice-toast";
import { t } from "../i18n";

type NoticeData = {
	message: string;
	duration: number;
	kind?: "info" | "error" | "warning";
};

/** toast 上的可点击按钮（对应 sonner 的 action/cancel）。 */
export type NoticeAction = {
	label: string;
	onClick?: () => void;
};

/** 提示的可选操作按钮：action 为主按钮、cancel 为次按钮（对应 sonner 语义）。 */
export type NoticeActions = {
	action?: NoticeAction;
	cancel?: NoticeAction;
};

let fallbackHost: HTMLDivElement | null = null;
let nextFallbackNoticeId = 0;
/** 自定义卡片 toast 的自增 id：toast.custom 不返回 id，需自行生成并回传（用于 dismissNotice 精准关闭）。 */
let nextSonnerNoticeId = 0;
export type NoticeId = string | number;

// ── DOM 兜底 toast 的图标源（与 NoticeToastCard 的 KIND_ICON 同款 lucide path）──
// 正常路径走 React 组件（lucide-react）；这里只能用纯 DOM 重建卡片，直接内嵌同款
// path 保证两套渲染（sonner 自定义卡片 / Toaster 未挂载时的 DOM 兜底）视觉完全一致。
type FallbackIconKey = "neutral" | "info" | "warning" | "error" | "copy" | "check" | "close";
const KIND_ICON_PATHS: Record<FallbackIconKey, string> = {
	neutral: "<path d='M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9'/><path d='M10.3 21a1.94 1.94 0 0 0 3.4 0'/>",
	info: "<circle cx='12' cy='12' r='10'/><path d='M12 16v-4'/><path d='M12 8h.01'/>",
	warning: "<path d='m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z'/><path d='M12 9v4'/><path d='M12 17h.01'/>",
	error: "<circle cx='12' cy='12' r='10'/><line x1='12' y1='8' x2='12' y2='12'/><line x1='12' y1='16' x2='12.01' y2='16'/>",
	copy: "<rect width='14' height='14' x='8' y='8' rx='2' ry='2'/><path d='M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2'/>",
	check: "<path d='M20 6 9 17l-5-5'/>",
	close: "<path d='M18 6 6 18'/><path d='m6 6 12 12'/>",
};

/** 创建与 lucide-react 同规格的内联 SVG 图标（stroke 风格），用于纯 DOM 兜底 toast。 */
function svgIcon(key: FallbackIconKey, size = 14): SVGSVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 24 24");
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.setAttribute("aria-hidden", "true");
	svg.innerHTML = KIND_ICON_PATHS[key];
	return svg;
}

/** 图标块的 kind 对应颜色（与 NoticeToastCard 的 KIND_ICON className 语义一致）。 */
const KIND_ICON_COLORS: Record<"neutral" | "info" | "warning" | "error", string> = {
	neutral: "var(--color-text-tertiary)",
	info: "var(--color-info)",
	warning: "var(--color-warning)",
	error: "var(--color-danger)",
};

// sonner 2.x 在没有可见 toast 时不会渲染任何 DOM（源码里 `if (!filteredToasts.length) return null`），
// 因此不能用 DOM 查询该属性来探测挂载态——那会在每次首个 toast 前都误判为未挂载，
// 导致所有通知永远走黑色 DOM 兜底。挂载状态改由 Toaster 组件挂载时显式回报。
let toasterReady = false;

export function setToasterReady(ready: boolean) {
	toasterReady = ready;
}

/**
 * sonner 的 toast()/toast.custom() 在 Toaster 未挂载（启动早期/渲染树崩溃）时静默丢弃，
 * 此时走 DOM 兜底，保证全局异常仍能给用户可见反馈。
 */
function toasterMounted() {
	return toasterReady;
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
function showFallbackNotice(message: string, duration: number, kind: NoticeData["kind"] = "info", title?: string, actions?: NoticeActions, id?: NoticeId): NoticeId | undefined {
	if (typeof document === "undefined") return;
	// 同稳定 id 再弹：先撤掉上一条，避免自动重试连发堆一排。
	if (id !== undefined && fallbackHost) {
		const existing = fallbackHost.querySelector<HTMLDivElement>(`[data-notice-id="${CSS.escape(String(id))}"]`);
		if (existing) dismissFallbackNotice(existing, fallbackHost);
	}
	const noticeId = id !== undefined ? String(id) : `fallback-notice-${++nextFallbackNoticeId}`;
	const host = ensureFallbackHost();
	const item = document.createElement("div") as HTMLDivElement;
	// 与 NoticeToastCard 同一套布局与 token（图标块 + 内容 + 右上按钮组 + 底部按钮行），
	// 字体/圆角/间距全部走 CSS 变量，主题自动适配；kind 只体现在图标与图标色。
	item.style.cssText = [
		"display:flex",
		"align-items:flex-start",
		"gap:12px",
		"pointer-events:auto",
		"padding:14px",
		"border-radius:var(--radius-lg, 10px)",
		"background:var(--color-bg-panel, #ffffff)",
		"border:1px solid var(--color-border-subtle, rgba(0,0,0,0.08))",
		"box-shadow:var(--shadow-popover, 0 4px 12px rgba(0,0,0,0.12))",
		"font:500 13px/1.5 var(--font-family-base, system-ui,-apple-system,Segoe UI,sans-serif)",
		"word-break:break-word",
		"width:min(360px, calc(100vw - 32px))",
	].join(";");
	item.setAttribute("role", kind === "error" ? "alert" : "status");
	item.dataset.noticeId = noticeId;

	// 图标块：24×24 圆角背景 + 14px 线性图标（与 NoticeToastCard 同规格）
	const iconBlock = document.createElement("div");
	iconBlock.style.cssText = [
		"display:flex",
		"align-items:center",
		"justify-content:center",
		"width:24px",
		"height:24px",
		"flex:none",
		"margin-top:1px",
		"border-radius:var(--radius-md, 8px)",
		"background:var(--color-bg-muted, rgba(0,0,0,0.05))",
		"color:" + KIND_ICON_COLORS[kind],
	].join(";");
	iconBlock.appendChild(svgIcon(kind));
	item.appendChild(iconBlock);

	// 内容列：标题 + 正文（有标题时标题为主文案、正文退为描述，与卡片语义一致）
	const content = document.createElement("div");
	content.style.cssText = ["flex:1", "min-width:0", "display:flex", "flex-direction:column"].join(";");
	if (title) {
		const titleEl = document.createElement("div");
		titleEl.style.cssText = [
			"font-weight:500",
			"font-size:13px",
			"line-height:20px",
			"color:var(--color-text-primary, #1f2328)",
		].join(";");
		titleEl.textContent = title;
		content.appendChild(titleEl);
	}
	const msgEl = document.createElement("div");
	// 有标题时正文是描述（12px 次级色）；无标题时整段作为主文案（13px 主色）
	msgEl.style.cssText = title
		? [
			"margin-top:2px",
			"font-size:12px",
			"line-height:16px",
			"color:var(--color-text-secondary, #57606a)",
		].join(";")
		: ["font-size:13px", "line-height:20px", "color:var(--color-text-primary, #1f2328)"].join(";");
	msgEl.textContent = message;
	content.appendChild(msgEl);

	if (actions) {
		// 按钮区：次按钮（cancel）在左、主按钮（action）在右，点击后先执行回调再收起 toast
		const buttons = document.createElement("div");
		buttons.style.cssText = ["display:flex", "gap:8px", "justify-content:flex-end", "margin-top:8px"].join(";");
		for (const key of ["cancel", "action"] as const) {
			const action = actions[key];
			if (!action) continue;
			const button = document.createElement("button");
			button.type = "button";
			// 与 NoticeToastCard 按钮一致：主按钮带「→」强化前往语义
			button.textContent = key === "action" ? `${action.label} →` : action.label;
			button.style.cssText = [
				"display:inline-flex",
				"align-items:center",
				"height:28px",
				"border:0",
				"border-radius:var(--radius-md, 8px)",
				"padding:0 10px",
				"font:500 12px/1.4 system-ui,sans-serif",
				"cursor:pointer",
			].join(";");
			if (key === "action") {
				button.style.cssText += [
					"background:var(--color-primary, var(--color-accent, #3b82f6))",
					"color:var(--color-primary-foreground, #fff)",
				].join(";");
			} else {
				button.style.cssText += [
					"border:1px solid var(--color-border-subtle, rgba(0,0,0,0.12))",
					"background:var(--color-bg-muted, rgba(0,0,0,0.04))",
					"color:var(--color-text-secondary, #57606a)",
				].join(";");
			}
			button.addEventListener("click", () => {
				action.onClick?.();
				dismissFallbackNotice(item, host);
			});
			buttons.appendChild(button);
		}
		content.appendChild(buttons);
	}
	item.appendChild(content);

	// 右上按钮组（复制/关闭），与卡片同规格：24px 图标钮
	const actionGroup = document.createElement("div");
	actionGroup.style.cssText = ["display:flex", "align-items:center", "gap:2px", "flex:none", "margin:0 -4px"].join(";");
	const copyBtn = document.createElement("button");
	copyBtn.type = "button";
	copyBtn.setAttribute("aria-label", t("common.copy"));
	copyBtn.title = t("common.copy");
	copyBtn.style.cssText = iconButtonCss;
	copyBtn.appendChild(svgIcon("copy"));
	copyBtn.addEventListener("click", () => {
		void writeClipboardText(title ? `${title}\n${message}` : message).then((ok) => {
			if (!ok) return;
			// 复制成功后短暂切换成勾号（与 NoticeToastCard 一致），再还原
			copyBtn.replaceChildren(svgIcon("check"));
			copyBtn.style.color = "var(--color-success, #16a34a)";
			window.setTimeout(() => {
				copyBtn.replaceChildren(svgIcon("copy"));
				copyBtn.style.color = "var(--color-text-tertiary, #8b8f94)";
			}, 1600);
		});
	});
	actionGroup.appendChild(copyBtn);
	const closeBtn = document.createElement("button");
	closeBtn.type = "button";
	closeBtn.setAttribute("aria-label", t("common.close"));
	closeBtn.title = t("common.close");
	closeBtn.style.cssText = iconButtonCss;
	closeBtn.appendChild(svgIcon("close"));
	closeBtn.addEventListener("click", () => dismissFallbackNotice(item, host));
	actionGroup.appendChild(closeBtn);
	item.appendChild(actionGroup);

	host.appendChild(item);
	if (Number.isFinite(duration)) {
		window.setTimeout(() => dismissFallbackNotice(item, host), Math.max(1200, duration));
	}
	return noticeId;
}

/** 兜底 toast 右上角图标钮的共享样式（24px 方钮，与 NoticeToastCard 的 copy/close 一致）。 */
const iconButtonCss = [
	"display:inline-flex",
	"align-items:center",
	"justify-content:center",
	"width:24px",
	"height:24px",
	"flex:none",
	"border:0",
	"border-radius:var(--radius-md, 6px)",
	"background:transparent",
	"color:var(--color-text-tertiary, #8b8f94)",
	"cursor:pointer",
].join(";");

/**
 * 弹出全局 toast。duration 省略时 info=1500ms、error/warning=3000ms。
 * 粘性提示必须传 Number.POSITIVE_INFINITY：sonner 把 duration: 0 当成立刻关闭，
 * 看起来就像“闪一下就没了”。空 message 会直接丢弃，调用方需保证有正文。
 */
export function showNotice(
	message: string,
	duration?: number,
	kind?: NoticeData["kind"],
	title?: string,
	actions?: NoticeActions,
	/** 稳定 id：同 id 再次弹出时顶掉上一条，避免自动重试等连发场景堆一排 toast。 */
	id?: NoticeId,
): NoticeId | undefined {
	const resolvedDuration = duration ?? (kind === "error" || kind === "warning" ? 3000 : 1500);
	const text = String(message ?? "").trim();
	if (!text) return;
	if (!toasterMounted()) {
		return showFallbackNotice(text, resolvedDuration, kind, title, actions, id);
	}
	// 统一走自定义卡片（toast.custom）：一张卡片承载「图标 + 标题/正文 + 复制/关闭 + 操作按钮」，
	// 不再依赖 sonner 内置 title/description/action 布局——后者把按钮塞在正文右侧同一行，
	// 长文案 + 双按钮时会挤成一团（历史 issue）。卡片内容见 NoticeToastCard。
	// 有标题时标题为主文案、正文退为描述；无标题（含空字符串）时整段作为主文案。
	const noticeId = id !== undefined ? id : `notice-${++nextSonnerNoticeId}`;
	const cardTitle = title ? title : text;
	const cardDescription = title ? text : undefined;
	toast.custom(
		(toastId) =>
			createElement(NoticeToastCard, {
				toastId,
				kind: kind ?? "neutral",
				title: cardTitle,
				description: cardDescription,
				actions,
			}),
		{ id: noticeId, duration: resolvedDuration },
	);
	return noticeId;
}

/** 精准关闭由 showNotice 返回的通知，不影响其他全局 toast。 */
export function dismissNotice(id: NoticeId | undefined) {
	if (id === undefined) return;
	if (toasterMounted()) {
		toast.dismiss(id);
		return;
	}
	const item = fallbackHost?.querySelector<HTMLDivElement>(`[data-notice-id="${CSS.escape(String(id))}"]`);
	if (item && fallbackHost) dismissFallbackNotice(item, fallbackHost);
}
