/**
 * 轻量通知机制：组件订阅，任意模块触发。
 * 替代 sonner toast，所有通知统一在 ponytail-notice 位置显示。
 */

type NoticeData = {
  message: string;
  duration: number;
  kind?: "info" | "error" | "warning";
};

type Listener = (data: NoticeData | null) => void;

let listener: Listener | null = null;

export function subscribeToNotice(cb: Listener) {
  listener = cb;
  return () => {
    listener = null;
  };
}

export function showNotice(message: string, duration = 3500, kind?: "info" | "error" | "warning") {
  listener?.({ message, duration, kind });
}
