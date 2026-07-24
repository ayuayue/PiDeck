/**
 * 轻量通知机制：组件订阅，任意模块触发。
 * 替代 sonner toast，所有通知统一在 app-notice 位置显示。
 *
 * 若 App 尚未挂载 / 渲染树崩溃导致 listener 丢失，则回退到 DOM toast，
 * 保证全局错误处理仍能给用户可见反馈。
 */

type NoticeData = {
  message: string;
  duration: number;
  kind?: "info" | "error" | "warning";
};

type Listener = (data: NoticeData | null) => void;

let listener: Listener | null = null;
let fallbackHost: HTMLDivElement | null = null;

export function subscribeToNotice(cb: Listener) {
  listener = cb;
  return () => {
    if (listener === cb) listener = null;
  };
}

function ensureFallbackHost() {
  if (fallbackHost && document.body.contains(fallbackHost)) return fallbackHost;
  const host = document.createElement("div");
  host.id = "app-notice-fallback-host";
  host.setAttribute("aria-live", "polite");
  host.style.cssText = [
    "position:fixed",
    "left:50%",
    "bottom:28px",
    "transform:translateX(-50%)",
    "z-index:2147483000",
    "display:flex",
    "flex-direction:column",
    "gap:8px",
    "pointer-events:none",
    "max-width:min(520px, calc(100vw - 32px))",
  ].join(";");
  document.body.appendChild(host);
  fallbackHost = host;
  return host;
}

/** App 未订阅时的 DOM 兜底 toast，避免全局异常完全静默。 */
function showFallbackNotice(message: string, duration: number, kind: NoticeData["kind"] = "info") {
  if (typeof document === "undefined") return;
  const host = ensureFallbackHost();
  const item = document.createElement("div");
  const accent =
    kind === "error" ? "#b42318" : kind === "warning" ? "#b7791f" : "#238636";
  item.style.cssText = [
    "pointer-events:auto",
    "padding:10px 14px",
    "border-radius:8px",
    "background:rgba(17,19,21,0.92)",
    "color:#f3f4f6",
    "box-shadow:0 10px 30px rgba(0,0,0,0.28)",
    "border-left:3px solid " + accent,
    "font:500 13px/1.4 system-ui,-apple-system,Segoe UI,sans-serif",
    "word-break:break-word",
  ].join(";");
  item.textContent = message;
  host.appendChild(item);
  window.setTimeout(() => {
    item.remove();
    if (host.childElementCount === 0) {
      host.remove();
      if (fallbackHost === host) fallbackHost = null;
    }
  }, Math.max(1200, duration));
}

export function showNotice(message: string, duration = 3500, kind?: "info" | "error" | "warning") {
  const text = String(message ?? "").trim();
  if (!text) return;
  if (listener) {
    listener({ message: text, duration, kind });
    return;
  }
  showFallbackNotice(text, duration, kind);
}
