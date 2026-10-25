/**
 * 执行过程折叠汇总统计（纯函数，可单测）。
 *
 * 折叠态只显示纯数字，不显示内容预览（与用户确认）。
 * 文案拼接（i18n）放在展示组件层，本模块只负责统计，保持零副作用。
 */
import type { TurnDisplayItem } from "./types";
import { cleanAnswerText } from "./answerText.ts";

export type ProcessSummary = {
	toolCount: number;
	thinkingCount: number;
	interimCount: number;
	/** 本轮自动重试次数（过程行条数）：>0 时汇总按钮追加「N次重试」 */
	retryCount: number;
	/** 本轮错误诊断次数（过程行条数）：>0 时汇总按钮追加「N个错误」 */
	errorCount: number;
};

export function buildProcessSummary(items: TurnDisplayItem[]): ProcessSummary {
	let toolCount = 0;
	let thinkingCount = 0;
	let interimCount = 0;
	let retryCount = 0;
	let errorCount = 0;
	for (const item of items) {
		if (item.kind === "process-entry") {
			if (item.entry.kind === "tool-entry") toolCount += 1;
			else if (item.entry.kind === "retry-entry") retryCount += 1;
			else if (item.entry.kind === "error-entry") errorCount += 1;
			else thinkingCount += 1;
		} else if (item.kind === "interim-answer") {
			// 与 AnswerOutput 一样按清理后的正文计数：live 骨架、error 空占位、
			// 仅思考标签或控制码的消息都没有可展示正文，不能虚增中间回复数量。
			if (cleanAnswerText(item.message.text)) interimCount += 1;
		}
	}
	return { toolCount, thinkingCount, interimCount, retryCount, errorCount };
}

export function isEmptySummary(summary: ProcessSummary): boolean {
	return summary.toolCount === 0 && summary.thinkingCount === 0 && summary.interimCount === 0 && summary.retryCount === 0 && summary.errorCount === 0;
}
