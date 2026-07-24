import React from "react";
import ReactDOM from "react-dom/client";
import type { AppLogLevel } from "@shared/types";
import { App } from "./App";
import { AppErrorBoundary } from "./components/ui/AppErrorBoundary";
import { t } from "./i18n";
import { showNotice } from "./utils/notice";
import "./styles.css";
import "./file-icons.css";

function writeStartupLog(level: AppLogLevel, message: string, detail?: unknown) {
  window.piDesktop?.app.rendererLog(level, "renderer", message, detail).catch(() => undefined);
}

/** 将异常压缩成用户可读的短文案，避免 toast 被超长 stack 淹没。 */
function formatRuntimeError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

// 全局运行时异常：写日志 + toast，避免静默失败或整页无反馈。
window.addEventListener("error", (event) => {
  // 资源加载失败（script/img）也会进 error 事件，但 event.error 通常为空；
  // 这类错误不适合弹业务 toast，只记日志。
  const isResourceError = event.target instanceof HTMLElement;
  writeStartupLog("error", "Renderer uncaught error", {
    message: event.message,
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
    isResourceError,
    error: event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.error ?? ""),
  });
  if (!isResourceError) {
    const message = formatRuntimeError(event.error ?? event.message);
    if (message) {
      showNotice(`${t("app.runtimeErrorToast")}: ${message}`, 6000, "error");
    }
  }
});

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  writeStartupLog("error", "Renderer unhandled rejection", {
    reason: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
  const message = formatRuntimeError(reason);
  if (message) {
    showNotice(`${t("app.unhandledRejectionToast")}: ${message}`, 6000, "error");
  }
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
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);

/**
 * React 首次渲染完成后，淡出启动画面覆盖层，动画结束后移除 DOM 节点。
 *
 * 使用 requestAnimationFrame 确保 React commit 阶段已完成、样式已计算。
 * 再用 requestAnimationFrame 触发 fade-out 类，让浏览器在下一次帧中
 * 执行 CSS transition，实现平滑过渡。
 * 额外设置 fallback 超时，避免 transitionend 丢失导致遮罩残留。
 */
requestAnimationFrame(() => {
  writeStartupLog("info", "Renderer React tree mounted");

  const overlay = document.getElementById("boot-overlay");
  if (!overlay) return;

  let removed = false;
  const removeOverlay = () => {
    if (removed) return;
    removed = true;
    overlay.remove();
  };

  // 下一帧触发 fade-out class，确保 CSS transition 生效
  requestAnimationFrame(() => {
    overlay.classList.add("fade-out");

    // 过渡结束后从 DOM 移除覆盖层，释放层级上下文
    overlay.addEventListener("transitionend", removeOverlay, { once: true });
    // 兜底：某些环境下 transitionend 可能不触发
    window.setTimeout(removeOverlay, 700);
  });
});
