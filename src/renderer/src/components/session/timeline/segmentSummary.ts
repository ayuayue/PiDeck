/**
 * 执行过程折叠汇总统计（纯函数，可单测）。
 *
 * 折叠态只显示纯数字，不显示内容预览（与用户确认）。
 * 文案拼接（i18n）放在展示组件层，本模块只负责统计，保持零副作用。
 */
import type { TurnDisplayItem } from "./types";

export type ProcessSummary = {
	toolCount: number;
	thinkingCount: number;
	interimCount: number;
	/** 本轮自动重试次数（过程行条数）：>0 时汇总按钮追加「N次重试」 */
	retryCount: number;
};

export function buildProcessSummary(items: TurnDisplayItem[]): ProcessSummary {
	let toolCount = 0;
	let thinkingCount = 0;
	let interimCount = 0;
	let retryCount = 0;
	for (const item of items) {
		if (item.kind === "process-entry") {
			if (item.entry.kind === "tool-entry") toolCount += 1;
			else if (item.entry.kind === "retry-entry") retryCount += 1;
			else thinkingCount += 1;
		} else if (item.kind === "interim-answer") {
			// 只数有文本的中间回复：空文本骨架是 live 挂载点 / 模型 error 占位
			// （如连续多条 stopReason=error 的空消息），不是真实中间回复，
			// 计入会虚增「N 段中间回复」计数（用户反馈：5 条 error 空消息显示成 5 段）。
			if (item.message.text.trim()) interimCount += 1;
		}
	}
	return { toolCount, thinkingCount, interimCount, retryCount };
}

export function isEmptySummary(summary: ProcessSummary): boolean {
	return summary.toolCount === 0 && summary.thinkingCount === 0 && summary.interimCount === 0 && summary.retryCount === 0;
}
