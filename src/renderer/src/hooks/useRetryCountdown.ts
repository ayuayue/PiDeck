import { useEffect, useState } from "react";
import type { ChatMessage } from "../../../shared/types";

/**
 * 只刷新重试行的剩余秒数，不改消息或实际重试调度。
 * 以主进程写入的消息时间 + delayMs 为截止时间，晚挂载/后台节流后也不会从头倒数。
 * null 表示不是已知延迟的等待态；0 表示等待结束，应显示「正在重试」而非负数。
 */
export function useRetryCountdown(message: ChatMessage, hidden: boolean): number | null {
	const delayMs = message.meta?.delayMs;
	const deadline = message.meta?.status === "running" && message.meta?.i18nKey === "diagnostic.retryScheduledAfterDelay" && typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0 && Number.isFinite(message.timestamp) ? message.timestamp + delayMs : null;
	const retryAt = deadline !== null && Number.isFinite(deadline) ? deadline : null;
	const [, refresh] = useState(0);

	useEffect(() => {
		if (hidden || retryAt === null) return;
		let timer: number | undefined;
		/** 下一次更新对齐剩余秒数的边界；每次重新读时钟，避免延迟 tick 积累漂移。 */
		const schedule = () => {
			const remainingMs = retryAt - Date.now();
			if (remainingMs <= 0) return;
			const seconds = Math.ceil(remainingMs / 1000);
			const nextTickMs = Math.max(1, remainingMs - (seconds - 1) * 1000);
			timer = window.setTimeout(() => {
				refresh((value) => value + 1);
				schedule();
			}, nextTickMs);
		};
		schedule();
		// 隐藏、切换退避/终态或卸载都在同一处清理，不为历史消息保留后台计时器。
		return () => {
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [hidden, retryAt]);

	// 新消息/重新展开时直接用当前截止时间，不闪现上一轮或折叠前的秒数。
	return retryAt === null ? null : Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}
