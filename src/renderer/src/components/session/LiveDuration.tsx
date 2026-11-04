import { useEffect, useState } from "react";
import { formatDuration } from "./TimelineFormat";
import { useSessionPaneActive } from "./sessionPaneActive";

/**
 * 实时耗时（公共组件）：思考卡片 / 工具卡片共用。
 * 本轮整体的实时耗时在状态条（RespondingIndicator → statusFacts），不走这里：
 * 它是整轮读数，只该有一个且不与卡片内的小秒表混用。
 *
 * 语义：
 * - isStreaming（执行中）：每 100ms tick 一次，显示 now - startedAt（实时增长，秒表感）；
 * - 结束（endedAt > 0）：显示固定值 endedAt - startedAt（截止计数），不再 tick；
 * - 无 startedAt：不渲染。
 *
 * 性能：tick 只在本组件内 setState，React 只重渲染 LiveDuration 子树，
 * 不会拖累 TurnRow/卡片主体；isStreaming 为 false 时不启动定时器。
 * 100ms 粒度：formatDuration 显示到十分位（如 3.4s），若 1s 才跳一次会像坏秒表；
 * 每实例 10 次/秒的小 span 渲染开销可忽略（对比流式正文 ~50ms 一帧的重量级更新）。
 */
export function LiveDuration(props: {
	/** 开始时间戳；无则不渲染 */
	startedAt?: number;
	/** 结束时间戳；执行中（流式）传 0/undefined，由 isStreaming 驱动实时刷新 */
	endedAt?: number;
	/** 是否仍在执行：true 时启动 100ms tick（与 formatDuration 的十分位精度对齐） */
	isStreaming?: boolean;
}) {
	const [now, setNow] = useState(() => Date.now());
	// 非激活栏不跑秒表：每实例 10 次/秒的 setState 在后台栏是纯浪费。
	// 恢复时立刻取一次当前时间，避免秒表停在暂停瞬间直到下一个 tick。
	const active = useSessionPaneActive();
	useEffect(() => {
		if (!props.isStreaming || !active) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 100);
		return () => window.clearInterval(timer);
	}, [props.isStreaming, active]);

	const started = props.startedAt;
	if (started == null || started <= 0) return null;
	const ended = props.endedAt && props.endedAt > 0 ? props.endedAt : null;
	const ms = Math.max(0, (ended ?? now) - started);
	return <>{formatDuration(ms)}</>;
}
