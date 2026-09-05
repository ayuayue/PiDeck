import { Fragment, memo, useLayoutEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import type { AgentRuntimeState } from "../../../../shared/types";
import { formatDuration } from "./TimelineFormat";
import { formatTokens } from "./SessionContextMeter";

/**
 * 输入卡正下方的会话指标条（dsh-web StatsLine / conversation.composer.dock）。
 *
 * DSH：整段日志的回合/步骤、LLM/工具墙钟、平均首字、生成速度 + 累计 token。
 * pi：没有 sessionStats 投影，改用「上次回复」性能组（TTFT / 总耗时 / tps）+ 累计 token。
 * 无任何可展示数字时整条卸载（含底距），有数字才占 12px 行高 + pt/pb。
 */
export function buildComposerStatsGroups(
	state:
		| Pick<
				AgentRuntimeState,
				| "dshSessionStats"
				| "inputTokens"
				| "outputTokens"
				| "cacheHitPercent"
				| "ttftMs"
				| "totalMs"
				| "tps"
		  >
		| undefined,
	turnCount = 0,
): string[] {
	if (!state) return [];
	const groups: string[] = [];
	const sessionStats = state.dshSessionStats;
	// 门控用 turns（完成对话轮）而非 steps：纯工具执行轮没有投影出的 assistant 消息，
	// steps 会为 0，但模型已执行、官方 sessionStats 也会计入（对齐 dsh-web 的显示时机）。
	if (sessionStats && sessionStats.turns > 0) {
		// 步数只在 >0 时拼接（官方投影 steps≥1 恒有值；兜底 fallback 的纯工具轮
		// steps=0，此时只显示轮数，避免「1 轮 · 0 步」）。
		groups.push(
			sessionStats.steps > 0
				? t("composerStats.counts", {
					turns: sessionStats.turns,
					steps: sessionStats.steps,
				})
				: t("composerStats.turns", { turns: sessionStats.turns }),
		);
		const durations: string[] = [];
		if (sessionStats.llmMs > 0) {
			durations.push(t("composerStats.llm", { duration: formatDuration(sessionStats.llmMs) }));
		}
		if (sessionStats.toolMs > 0) {
			durations.push(t("composerStats.toolCall", { duration: formatDuration(sessionStats.toolMs) }));
		}
		if (durations.length > 0) groups.push(durations.join(" · "));
		const speeds: string[] = [];
		if (sessionStats.ttftAvgMs != null) {
			speeds.push(t("composerStats.ttftAverage", { duration: formatDuration(sessionStats.ttftAvgMs) }));
		}
		if (sessionStats.tokensPerSecond != null) {
			speeds.push(t("composerStats.tps", { throughput: String(Math.round(sessionStats.tokensPerSecond)) }));
		}
		if (speeds.length > 0) groups.push(speeds.join(" · "));
	} else {
		// pi 没有 DSH 的 sessionStats：轮次由 SessionView 用 countUserTurns 传入
		// （发言权周期，与内部分页/缓存协议同口径），保证历史/实时一致。
		if (turnCount > 0) groups.push(t("composerStats.turns", { turns: turnCount }));
		// pi 无整段 sessionStats：用最近一条回复的性能组填同一条带，语义在文案里标清。
		const lastReply: string[] = [];
		if (state.ttftMs != null) {
			lastReply.push(t("composerStats.ttft", { duration: formatDuration(state.ttftMs) }));
		}
		if (state.totalMs != null) {
			lastReply.push(t("composerStats.reply", { duration: formatDuration(state.totalMs) }));
		}
		if (state.tps != null) {
			lastReply.push(t("composerStats.tps", { throughput: String(Math.round(state.tps)) }));
		}
		if (lastReply.length > 0) groups.push(lastReply.join(" · "));
	}
	const input = state.inputTokens ?? 0;
	const output = state.outputTokens ?? 0;
	if (input > 0 || output > 0) {
		if (state.cacheHitPercent != null) {
			groups.push(t("composerStats.cacheHit", { percent: Math.round(state.cacheHitPercent) }));
		}
		groups.push(
			t("composerStats.tokens", {
				input: formatTokens(input),
				output: formatTokens(output),
			}),
		);
	}
	return groups;
}

export const ComposerStatsLine = memo(function ComposerStatsLine(props: {
	state?: AgentRuntimeState;
	turnCount?: number;
}) {
	const groups = buildComposerStatsGroups(props.state, props.turnCount);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [truncated, setTruncated] = useState(false);
	const line = groups.join(" | ");

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

	if (groups.length === 0) return null;
	return (
		<div
			ref={rootRef}
			className="w-full min-w-0 truncate px-1 pb-0 pt-1 text-center text-[12px] leading-5 text-text-tertiary"
			title={truncated ? line : undefined}
			data-testid="composer-stats-line"
		>
			{groups.map((group, i) => (
				<Fragment key={group}>
					{i > 0 && (
						<>
							<span className="mx-2.5 text-border-strong" aria-hidden>
								|
							</span>{" "}
						</>
					)}
					<span>{group}</span>
				</Fragment>
			))}
		</div>
	);
});
