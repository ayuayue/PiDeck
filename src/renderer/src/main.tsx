import React from "react";
import ReactDOM from "react-dom/client";
import type { AppLogLevel } from "@shared/types";
import { App } from "./App";
import "./styles.css";
import "./file-icons.css";

function writeStartupLog(level: AppLogLevel, message: string, detail?: unknown) {
  window.piDesktop?.app.rendererLog(level, "renderer", message, detail).catch(() => undefined);
}

window.addEventListener("error", (event) => {
  writeStartupLog("error", "Renderer startup uncaught error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    error: event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error),
  });
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  writeStartupLog("error", "Renderer startup unhandled rejection", {
    reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
});

writeStartupLog("info", "Renderer bootstrap started", {
  url: window.location.href,
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  writeStartupLog("error", "Renderer root element missing");
  throw new Error("Renderer root element missing");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

/**
 * React 首次渲染完成后，淡出启动画面覆盖层，动画结束后移除 DOM 节点。
 *
 * 使用 requestAnimationFrame 确保 React commit 阶段已完成、样式已计算。
 * 再用 requestAnimationFrame 触发 fade-out 类，让浏览器在下一次帧中
 * 执行 CSS transition，实现平滑过渡。
 */
requestAnimationFrame(() => {
  writeStartupLog("info", "Renderer React tree mounted");

  const overlay = document.getElementById("boot-overlay");
  if (!overlay) return;

  // 下一帧触发 fade-out class，确保 CSS transition 生效
  requestAnimationFrame(() => {
    overlay.classList.add("fade-out");

    // 过渡结束后从 DOM 移除覆盖层，释放层级上下文
    overlay.addEventListener(
      "transitionend",
      () => {
        overlay.remove();
      },
      { once: true },
    );
  });
});
