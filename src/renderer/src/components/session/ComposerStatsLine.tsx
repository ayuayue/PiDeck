import { Fragment, memo, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { t } from "../../i18n";
import type { AgentRuntimeState, TpsDisplayMode } from "../../../../shared/types";
import { useAtomValue } from "jotai";
import { tpsDisplayModeAtom } from "../../atoms/tps-atoms";
import { buildTpsDisplay } from "../../utils/tpsDisplay";
import { formatDuration } from "./TimelineFormat";
import { formatTokens } from "./SessionContextMeter";

/**
 * 输入卡正下方的会话指标条（dsh-web StatsLine / conversation.composer.dock）。
 *
 * DSH：整段日志的回合/步骤、LLM/工具墙钟、平均首字、生成速度 + 累计 token。
 * pi：没有 sessionStats 投影，改用「上次回复」性能组（TTFT / 总耗时 / tps）+ 累计 token。
 * 无任何可展示数字时整条卸载（含底距），有数字才占 12px 行高 + pt/pb。
 */
/** 单个可悬停指标：text 为展示文本，hint 为悬停说明（计算口径），缺省不渲染 title。 */
export type ComposerStatPart = { text: string; hint?: string };

export function buildComposerStatsSegments(state: Pick<AgentRuntimeState, "dshSessionStats" | "inputTokens" | "outputTokens" | "cacheHitPercent" | "ttftMs" | "totalMs" | "tps" | "endToEndTps"> | undefined, turnCount = 0, tpsMode: TpsDisplayMode = "streaming"): ComposerStatPart[][] {
	if (!state) return [];
	const groups: ComposerStatPart[][] = [];
	const sessionStats = state.dshSessionStats;
	// 门控用 turns（完成对话轮）而非 steps：纯工具执行轮没有投影出的 assistant 消息，
	// steps 会为 0，但模型已执行、官方 sessionStats 也会计入（对齐 dsh-web 的显示时机）。
	if (sessionStats && sessionStats.turns > 0) {
		// 步数只在 >0 时拼接（官方投影 steps≥1 恒有值；兜底 fallback 的纯工具轮
		// steps=0，此时只显示轮数，避免「1 轮 · 0 步」）。
		groups.push([
			{
				text:
					sessionStats.steps > 0
						? t("composerStats.counts", {
								turns: sessionStats.turns,
								steps: sessionStats.steps,
							})
						: t("composerStats.turns", { turns: sessionStats.turns }),
				hint: t("ctx.detail.turnsStepsHint"),
			},
		]);
		const durations: ComposerStatPart[] = [];
		if (sessionStats.llmMs > 0) {
			durations.push({ text: t("composerStats.llm", { duration: formatDuration(sessionStats.llmMs) }), hint: t("ctx.detail.llmDurationHint") });
		}
		if (sessionStats.toolMs > 0) {
			durations.push({ text: t("composerStats.toolCall", { duration: formatDuration(sessionStats.toolMs) }), hint: t("ctx.detail.toolDurationHint") });
		}
		if (durations.length > 0) groups.push(durations);
		const speeds: ComposerStatPart[] = [];
		if (sessionStats.ttftAvgMs != null) {
			speeds.push({ text: t("composerStats.ttftAverage", { duration: formatDuration(sessionStats.ttftAvgMs) }), hint: t("ctx.detail.ttftAverageHint") });
		}
		const throughput = buildTpsDisplay(tpsMode, sessionStats.tokensPerSecond, sessionStats.endToEndTokensPerSecond, "session");
		speeds.push({ text: throughput.text, hint: throughput.hint });
		if (speeds.length > 0) groups.push(speeds);
	} else {
		// pi 没有 DSH 的 sessionStats：轮次由 SessionView 用 countUserTurns 传入
		// （发言权周期，与内部分页/缓存协议同口径），保证历史/实时一致。
		if (turnCount > 0) groups.push([{ text: t("composerStats.turns", { turns: turnCount }), hint: t("composerStats.turnsHint") }]);
		// pi 无整段 sessionStats：用最近一条回复的性能组填同一条带，语义在文案里标清。
		const lastReply: ComposerStatPart[] = [];
		if (state.ttftMs != null) {
			lastReply.push({ text: t("composerStats.ttft", { duration: formatDuration(state.ttftMs) }), hint: t("ctx.detail.ttftHint") });
		}
		if (state.totalMs != null) {
			lastReply.push({ text: t("composerStats.reply", { duration: formatDuration(state.totalMs) }), hint: t("ctx.detail.totalHint") });
		}
		if (state.tps != null || state.endToEndTps != null || state.totalMs != null) {
			const throughput = buildTpsDisplay(tpsMode, state.tps, state.endToEndTps, "reply");
			lastReply.push({ text: throughput.text, hint: throughput.hint });
		}
		if (lastReply.length > 0) groups.push(lastReply);
	}
	const input = state.inputTokens ?? 0;
	const output = state.outputTokens ?? 0;
	if (input > 0 || output > 0) {
		if (state.cacheHitPercent != null) {
			groups.push([{ text: t("composerStats.cacheHit", { percent: Math.round(state.cacheHitPercent) }), hint: t("ctx.detail.hitLatestHint") }]);
		}
		groups.push([
			{
				text: t("composerStats.tokens", {
					input: formatTokens(input),
					output: formatTokens(output),
				}),
				hint: t("ctx.detail.tokensHint"),
			},
		]);
	}
	return groups;
}

/** 字符串版（兼容既有调用/测试）：每组用「 · 」拼接成单段文本。 */
export function buildComposerStatsGroups(state: Pick<AgentRuntimeState, "dshSessionStats" | "inputTokens" | "outputTokens" | "cacheHitPercent" | "ttftMs" | "totalMs" | "tps" | "endToEndTps"> | undefined, turnCount = 0, tpsMode: TpsDisplayMode = "streaming"): string[] {
	return buildComposerStatsSegments(state, turnCount, tpsMode).map((parts) => parts.map((part) => part.text).join(" · "));
}

export const ComposerStatsLine = memo(function ComposerStatsLine(props: { state?: AgentRuntimeState; turnCount?: number; contextMeter?: ReactNode }) {
	const tpsMode = useAtomValue(tpsDisplayModeAtom);
	const segments = buildComposerStatsSegments(props.state, props.turnCount, tpsMode);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [truncated, setTruncated] = useState(false);
	const line = segments.map((parts) => parts.map((part) => part.text).join(" · ")).join(" | ");

	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		const measure = () => {
			setTruncated(el.scrollWidth > el.clientWidth);
		};
		measure();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(measure);
		observer.observe(el);
		return () => observer.disconnect();
	}, [line]);

	// 首轮尚未产生统计数据时不单独显示圆环，避免输入框下方只剩一个孤立图标。
	// 有轮次、性能或 token 数据后，再把圆环作为同一条统计栏的交互入口挂入。
	if (segments.length === 0) return null;
	return (
		<div ref={rootRef} className="flex w-full min-w-0 items-center justify-center gap-2 px-1 pb-0 pt-1 text-caption leading-5 text-text-tertiary" title={truncated ? line : undefined} data-testid="composer-stats-line">
			<div className="min-w-0 truncate text-center">
				{segments.map((parts, i) => (
					<Fragment key={parts.map((part) => part.text).join("|") + i}>
						{i > 0 && (
							<>
								<span className="mx-2.5 text-border-strong" aria-hidden>
									|
								</span>{" "}
							</>
						)}
						{parts.map((part, j) => (
							<Fragment key={part.text + j}>
								{j > 0 && <span aria-hidden> · </span>}
								{/* 每个数字悬停可看计算口径（title 不改变布局，缺 hint 时不渲染属性） */}
								<span title={part.hint}>{part.text}</span>
							</Fragment>
						))}
					</Fragment>
				))}
			</div>
			<span className="shrink-0">{props.contextMeter}</span>
		</div>
	);
});
