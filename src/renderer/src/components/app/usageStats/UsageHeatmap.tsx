/**
 * GitHub 风格活跃热力图（自绘 SVG，无图表库依赖）。
 *
 * 数据：聚合器输出的 53 周 × 7 天网格（周一起始，index = week * 7 + day）。
 * 网格起点以聚合器下发的 heatmapStart 为准（单一来源，避免渲染层自行推算错位）。
 * level 0-4 由主进程按固定阈值算好（跨天可比）；色阶用语义 token（color-mix 于 accent）。
 *
 * 步长按容器实测宽度算（ResizeObserver），不是固定 634px：设置面板内容列约 1000px，
 * 固定宽度会在右侧留下一大片空白。格子始终保持正方形，铺满只改变边长、不改变网格比例。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { UsageAggregated } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { formatDayKeyPlusOffset, formatTokens } from "./format";

const GAP = 2;
const WEEKS = 53;
const DAYS = 7;
/** 左侧周名标签列宽。标签必须画在 viewBox 内，否则（原先的 x=-4）会被裁掉。 */
const LABEL_GUTTER = 26;
/** 首帧尚未实测到宽度时的兜底步长，避免 0 宽闪一下。 */
const FALLBACK_STEP = 12;

/** 色阶 class：0（无数据）→ 4（最高档）；token 化于 styles.css（暗色自动适配）。 */
const LEVEL_CLASSES = ["usage-heatmap-l0", "usage-heatmap-l1", "usage-heatmap-l2", "usage-heatmap-l3", "usage-heatmap-l4"];

const WEEK_LABELS = ["Mon", "Wed", "Fri"];

export function UsageHeatmap(props: { data: UsageAggregated }) {
	const { heatmap, heatmapStart } = props.data;
	const hostRef = useRef<HTMLDivElement>(null);
	// 单格步长（含间隙）：0 表示还没测到宽度
	const [step, setStep] = useState(0);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const measure = () => {
			const gridWidth = host.clientWidth - LABEL_GUTTER;
			setStep(gridWidth > 0 ? gridWidth / WEEKS : 0);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(host);
		return () => observer.disconnect();
	}, []);

	// 渲染层不再推算网格起点：一律用聚合器下发的 heatmapStart
	const todayKey = useMemo(() => {
		const d = new Date();
		const m = String(d.getMonth() + 1).padStart(2, "0");
		const day = String(d.getDate()).padStart(2, "0");
		return `${d.getFullYear()}-${m}-${day}`;
	}, []);

	const cellStep = step > 0 ? step : FALLBACK_STEP;
	const cell = Math.max(2, cellStep - GAP);
	const width = LABEL_GUTTER + WEEKS * cellStep;
	const height = DAYS * cellStep - GAP;

	return (
		<div ref={hostRef} className="w-full">
			<svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t("usageStats.heatmap.title")}>
				{heatmap.map((item, index) => {
					const week = Math.floor(index / DAYS);
					const day = index % DAYS;
					const date = formatDayKeyPlusOffset(heatmapStart, index);
					// 未来日期（超出当前时间）置为无数据色；正常场景 53 周窗口覆盖至今
					const isFuture = date > todayKey;
					const colorClass = isFuture ? LEVEL_CLASSES[0] : LEVEL_CLASSES[item.level];
					const x = LABEL_GUTTER + week * cellStep;
					const y = day * cellStep;
					return (
						<rect key={index} x={x} y={y} width={cell} height={cell} rx={2} className={colorClass}>
							<title>
								{t("usageStats.heatmap.tooltip", {
									date,
									tokens: formatTokens(item.tokens),
									turns: String(item.turns),
								})}
							</title>
						</rect>
					);
				})}
				{/* 周名只标三行，避免 7 行标签把网格挤窄；垂直居中于所在行 */}
				{WEEK_LABELS.map((label, i) => (
					<text key={label} x={LABEL_GUTTER - 6} y={i * 2 * cellStep + cell / 2} fontSize={9} fill="var(--color-text-tertiary)" textAnchor="end" dominantBaseline="middle">
						{label}
					</text>
				))}
			</svg>
		</div>
	);
}
