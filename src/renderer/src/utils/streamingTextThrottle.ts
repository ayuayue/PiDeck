import { useEffect, useRef, useState } from "react";

/**
 * 流式文本展示节流（渲染流畅优化，2026-08）。
 *
 * 背景：主进程消息 flush 间隔 50ms，流式中的 assistant 消息每次 flush 都触发
 * streamdown 全量解析；文本越长解析越贵，长回答（几千字）时每 50ms 一次全量解析
 * 会持续占用主线程，表现为流式输出期间界面卡顿、滚动掉帧。
 *
 * 策略：streaming 期间展示文本最多每 intervalMs 更新一次（合并窗口内的多次 flush），
 * 解析次数降低一半以上；streaming 结束（isStreaming 变 false）立即同步最终文本，
 * 保证不丢尾、不停在中间态。非流式场景（isStreaming=false/undefined）直出，零开销。
 *
 * 注意：只节流"展示"，atom 中的权威消息文本不受影响（复制/导出仍拿全文）。
 */
export function useThrottledStreamingText(
  text: string,
  isStreaming: boolean | undefined,
  intervalMs = 120,
): string {
  const [displayText, setDisplayText] = useState(text);
  const lastFlushRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    // 非流式：直接同步（静态消息、历史消息不走节流路径）
    if (!isStreaming) {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
      setDisplayText(text);
      return;
    }
    // 流式结束瞬间（text 已是最终态）：立即同步，保证完整消息及时可见
    const now = Date.now();
    const elapsed = now - lastFlushRef.current;
    if (elapsed >= intervalMs) {
      lastFlushRef.current = now;
      setDisplayText(text);
      return;
    }
    // 窗口内合并：只保留最近一次更新，到点后取最新 text
    if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      lastFlushRef.current = Date.now();
      setDisplayText(text);
    }, intervalMs - elapsed);
    return () => {
      if (timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
        timerRef.current = undefined;
      }
    };
  }, [text, isStreaming, intervalMs]);

  return isStreaming ? displayText : text;
}
