import React from "react";
import ReactDOM from "react-dom/client";
import { SelectionToolWindowView } from "../components/selectionWindow/SelectionToolWindowView";
import { ensureI18nLocale, resolveLocale, setI18nLocale } from "../i18n";
import { applySelectionWindowAppearance } from "./appearance";
import { attachSelectionCaptureBridge, detachSelectionCaptureBridge } from "./captureBridge";
import "./selection-tool.css";

/**
 * 系统级划词浮窗的渲染入口（独立 HTML，不加载主工作台）。
 *
 * 启动顺序很关键，三步都不能换：
 * 1. 先加载词典再 setI18nLocale：t() 是同步的，词典未注册时会静默退回 zh-CN；
 * 2. 渲染前 attach 捕获桥：主进程在 did-finish-load 后立刻推送首个载荷；
 * 3. 首帧前应用主题属性，避免先按默认浅色画一帧再切暗色闪一下。
 */
async function bootstrap(): Promise<void> {
	const locale = resolveLocale("system");
	try {
		await ensureI18nLocale(locale);
	} catch {
		// 词典加载失败不阻断浮窗：t() 回退 zh-CN（与 floater 入口同一策略）。
	}
	setI18nLocale(locale);
	await applySelectionWindowAppearance();
	attachSelectionCaptureBridge();
	window.addEventListener("pagehide", detachSelectionCaptureBridge);
	const container = document.getElementById("root");
	if (!container) return;
	ReactDOM.createRoot(container).render(
		<React.StrictMode>
			<SelectionToolWindowView />
		</React.StrictMode>,
	);
}

void bootstrap();
