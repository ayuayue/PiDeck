/**
 * web-main — PiDeck Web 服务 React 入口（A2）。
 * 独立于主窗口 renderer；通过 /api/* 与主进程 WebServiceManager 通信。
 *
 * 重构后与桌面端共享同一套样式基座（styles.css → foundation/timeline/surfaces/
 * tailwind token），并按 prefers-color-scheme 设置 data-theme 启用暗色模式。
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import "./web/web.css";
import { setI18nLocale } from "./i18n";
import { resolveLocale } from "./i18n";
import { WebChatApp } from "./web/WebChatApp";

// 与桌面端一致的 locale 解析：优先浏览器语言，中文按简体/繁体分流
const initialLocale = resolveLocale("system");
setI18nLocale(initialLocale);
document.documentElement.lang = initialLocale === "pseudo" ? "en-US" : initialLocale;

// 暗色模式：跟随系统 prefers-color-scheme，映射到 foundation.css 的 data-theme
const darkMedia = window.matchMedia("(prefers-color-scheme: dark)");
function applyTheme() {
	document.documentElement.dataset.theme = darkMedia.matches ? "dark" : "light";
}
applyTheme();
darkMedia.addEventListener("change", applyTheme);

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<WebChatApp />
	</StrictMode>,
);
