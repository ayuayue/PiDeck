import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { t } from "../../i18n";
import { useShortcutBindings } from "../../hooks/useShortcutBindings";
import { formatAccelerator } from "../../../../shared/shortcuts";
import { Button } from "../ui-shadcn/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui-shadcn/popover";
import { Slider } from "../ui-shadcn/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { clampThinkingLevelToAllowed } from "../../utils/thinkingDisplay";
import { THINKING_LEVELS, type ThinkingPickerLevel } from "./sessionPickerOptions";
import { accumulateWheelStep, type WheelStepState } from "./thinkingWheelStep";

/**
 * 紧凑的模型/思考组合：模型直接打开完整选择器，思考保留独立的就地入口。
 * modelLabel 只放模型名；modelTitle 是悬停展示的完整标识（provider/model）。
 * 芯片宽度有上限（模型名长时会省略），所以完整标识交给悬停气泡——原生 title 要
 * 等系统延迟、且和底栏其它控件（增强/上下文圆环）的气泡风格不一致，改成同一套 Tooltip。
 */
export function ModelThinkingChip(props: { modelLabel: string; modelTitle?: string; modelPendingTo?: string; modelPendingTitle?: string; disabled?: boolean; onPickModel: () => void; thinkingControl: ReactNode; startSurface?: boolean }) {
	const modelValue = props.modelPendingTo ? `${props.modelLabel} → ${props.modelPendingTo}` : props.modelLabel;
	const modelHint = props.modelPendingTitle ?? props.modelTitle ?? t("app.modelPickerTitle");
	return (
		<div className={`composer-bar-btn model-thinking inline-flex h-7 min-w-0 max-w-[30ch] items-center rounded-md text-control ${props.startSurface ? "font-normal" : "font-medium"}`}>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						variant="ghost"
						size="sm"
						// shadcn Button 基类带 shrink-0（按钮按内容取宽、永不收缩），模型名很长时会撑出外层
						// max-w-[30ch]，把文字画过右侧「思考」与 git 分支/发送按钮（视觉上分支被压没、文字硬截断
						// 且没有省略号）。行内 flexShrink 优先于任何 class 的层叠顺序，让名称在芯片内省略。
						style={{ flexShrink: 1 }}
						className={`h-7 min-w-0 rounded-md px-2 text-control hover:bg-muted/60 ${props.startSurface ? "font-normal text-text-secondary" : "font-medium text-foreground"}`}
						disabled={props.disabled}
						onClick={props.onPickModel}
						aria-label={t("app.modelPickerTitle")}
					>
						<span className="min-w-0 truncate">{modelValue}</span>
					</Button>
				</TooltipTrigger>
				<TooltipContent className="max-w-80 break-words">{modelHint}</TooltipContent>
			</Tooltip>
			<span className="shrink-0 text-muted-foreground/70" aria-hidden="true">
				·
			</span>
			{props.thinkingControl}
		</div>
	);
}

/** 档位刻度点：轨道上每个档位一个点（ZCode 同款），填充段内亮点 / 未选段暗点。
 *  坐标与 Radix thumb 中心同源：thumb 是 size-4（16px），getThumbInBoundsOffset 把
 *  中心压在 [8, 轨道宽-8] 区间，所以点层也内缩同量，首尾点才不贴到圆角外。
 *  注意：点必须放在 <Slider> 外层的相对容器里——Radix Slider.Root 会丢弃 children
 *  （只渲染 Track/Range/Thumb），塞进 Slider 里的装饰节点根本不会出现在 DOM。 */
const TRACK_DOT_SIZE = 3;
const THUMB_HALF = 8;

function ThinkingWheelZone(props: { disabled?: boolean; levels: ThinkingPickerLevel[]; onStep: (step: number) => void; children: ReactNode }) {
	const zoneRef = useRef<HTMLDivElement | null>(null);
	const stateRef = useRef<WheelStepState>({ accumulated: 0, at: 0 });
	const latestRef = useRef(props);
	latestRef.current = props;
	useEffect(() => {
		const node = zoneRef.current;
		if (!node) return;
		const onWheel = (event: WheelEvent) => {
			// ctrl/meta + 滚轮 = 系统缩放 / 触控板捏合：既不当成调档，也不吞默认动作。
			if (event.ctrlKey || event.metaKey) return;
			// 标记区无条件接管：guard 已为 data-wheel-owned 放行（不再 stopPropagation），
			// 事件会一路冒到 document，这里不 preventDefault 就可能让别人二次处理
			//（例：morphing-search 的背景滚轮锁、react-remove-scroll 的 document 监听）。
			// 「禁用 / 单档位」只是不改值，不是不接管——否则这两种情况下本行区反而成了 document 级滚轮的漏口。
			event.preventDefault();
			const { disabled, levels, onStep } = latestRef.current;
			if (disabled || levels.length <= 1) return;
			const { step, next } = accumulateWheelStep(stateRef.current, event.deltaY, event.timeStamp, event.deltaMode);
			stateRef.current = next;
			if (step !== 0) onStep(step);
		};
		node.addEventListener("wheel", onWheel, { passive: false });
		return () => node.removeEventListener("wheel", onWheel);
	}, []);
	return (
		<div ref={zoneRef} data-wheel-owned className="flex min-w-0 flex-col gap-2.5">
			{props.children}
		</div>
	);
}

/**
 * 思考强度选择：ZCode 同款渐变强度条（beUI 口径：shadcn Slider 原语 + 语义 token）。
 * 离散档位吸附（step=1）而非连续值——模型只认 off…max 的枚举；刻度标签行兼作点击入口，
 * 方向键在滑条上原生平移档位。壳从 DropdownMenu 换成 Popover：Radix Menu 会劫持
 * 方向键（typeahead/导航），滑条键盘操作会被吞；Popover 不拦截，滑条键盘可达。
 */
export function ThinkingLevelDropdown(props: { current?: string; levels?: ThinkingPickerLevel[]; open: boolean; onOpenChange: (open: boolean) => void; disabled?: boolean; onPick: (level: string) => void }) {
	// undefined 表示能力尚未知，沿用旧版全量回退；[] 则是后端明确表示不支持。
	const levels = props.levels ?? THINKING_LEVELS;
	const effectiveLevel = levels.some((level) => level.value === props.current) ? props.current : clampThinkingLevelToAllowed(props.current, levels);
	const currentIndex = Math.max(
		0,
		levels.findIndex((level) => level.value === (effectiveLevel ?? props.current)),
	);
	const currentLevel = levels[currentIndex];
	const thinkingText = currentLevel?.labelKey ? t(currentLevel.labelKey) : (currentLevel?.label ?? effectiveLevel ?? props.current ?? t("app.think"));
	const { bindings: shortcutTable, platform } = useShortcutBindings();
	const cycleThinkingShortcut = useMemo(() => (shortcutTable ? formatAccelerator(shortcutTable.cycleThinking, platform) : undefined), [shortcutTable, platform]);
	// 拖拽预览值：外部 current 变化（快捷键 Ctrl+T 循环、模型切换 clamp、RPC 应用回执）时同步；
	// 头行/说明实时跟随预览档位，触发按钮保持「已应用」档位。
	// ref 是提交逻辑的真值源（关闭时读到拖拽终点，SSR 单渲染内同样即时可见），
	// state 只驱动渲染（thumb/标签高亮）。appliedIndexRef 记录「后端已应用」的基准：
	// 关闭时只有 draft 与它不同才提交，打开又原样关闭不发无意义 RPC。
	const draftIndexRef = useRef(currentIndex);
	const appliedIndexRef = useRef(currentIndex);
	const [draftIndexState, setDraftIndexState] = useState(currentIndex);
	useEffect(() => {
		draftIndexRef.current = currentIndex;
		appliedIndexRef.current = currentIndex;
		setDraftIndexState(currentIndex);
	}, [currentIndex]);
	const setDraftIndex = (value: number) => {
		draftIndexRef.current = value;
		setDraftIndexState(value);
	};
	const draftIndex = draftIndexState;

	const previewLevel = levels[draftIndex] ?? currentLevel;
	// 填充比例（0…1）交给 CSS 的 background-size：轨道为 0 时兜底 1，避免除零。
	const progress = levels.length > 1 ? draftIndex / (levels.length - 1) : 1;
	/** 退出选择 = 唯一提交点。
	 *  拖拽/点刻度/方向键全程只改本地 draft：底栏触发器始终显示已应用档位
	 *  （off/minimal/…/max 字母长度不同，实时回写会让底栏宽度来回漂移），
	 *  后端命令也只在关闭这一刻发一次，不在中途乱点/滑动时反复发。
	 *  打开时把 draft/基准同步回当前已应用值：上次提交失败或 RPC 未落地时，
	 *  不能带着旧预览开弹层（否则一关闭就把旧值当新选择发回去）。 */
	const handleOpenChange = (next: boolean) => {
		if (next) {
			setDraftIndex(currentIndex);
			appliedIndexRef.current = currentIndex;
			props.onOpenChange(true);
			return;
		}
		props.onOpenChange(false);
		const level = levels[draftIndexRef.current];
		if (level && draftIndexRef.current !== appliedIndexRef.current) {
			appliedIndexRef.current = draftIndexRef.current;
			props.onPick(level.value);
		}
	};
	return (
		<Popover open={props.open} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>
				<Button variant="ghost" size="sm" className="h-7 min-w-0 shrink-0 rounded-md px-2 text-control font-medium text-muted-foreground hover:bg-muted/60" disabled={props.disabled} title={t("app.thinkingPickerTitle")} aria-label={t("app.thinkingPickerTitle")}>
					<span className="max-w-[16ch] truncate">{thinkingText}</span>
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" side="top" className="w-72 min-w-64 max-w-[min(320px,calc(100vw-24px))] p-3" aria-label={t("app.thinkingPickerTitle")}>
				{levels.length === 0 ? (
					<div className="px-1 py-2 text-caption text-muted-foreground">{t("app.thinkingPickerUnsupported")}</div>
				) : (
					<div className="flex min-w-0 flex-col gap-2.5">
						{/* 头行：强度标签 + 预览档位（拖拽实时跟随，仅弹层内可见）+ 全局快捷键提示 */}
						<div className="flex min-w-0 items-center gap-2">
							<span className="shrink-0 text-caption text-muted-foreground">{t("thinking.pickerIntensityLabel")}</span>
							<span className="min-w-0 truncate text-control font-semibold text-foreground">{previewLevel?.labelKey ? t(previewLevel.labelKey) : (previewLevel?.label ?? previewLevel?.value)}</span>
							{cycleThinkingShortcut ? (
								<kbd className="ml-auto shrink-0 rounded-sm border border-border-subtle bg-bg-muted px-1.5 py-0.5 font-mono text-micro leading-none text-muted-foreground" aria-hidden="true">
									{cycleThinkingShortcut}
								</kbd>
							) : null}
						</div>
						<ThinkingWheelZone disabled={props.disabled} levels={levels} onStep={(step) => setDraftIndex(Math.min(levels.length - 1, Math.max(0, draftIndexRef.current + step)))}>
							{/* 渐变强度条：拖拽/点刻度只更新本地预览（draftIndex），关闭弹层才提交 onPick——
						    中途每过一档就发命令会让底栏文字不断变长变短，且产生一串无效 RPC。
						    键盘方向键同样只预览，Enter/空格 = 确认并关闭（关闭即提交）。
						    档位点与滑条共用一个相对容器：点绝对定位、pointer-events-none 不吃拖拽；
						    颜色按填充段切换（白浮在彩色填充上 / 墨色浮在灰轨上），否则浅灰上的白点消失。 */}
							<div className="relative flex w-full items-center">
								<Slider
									value={[draftIndex]}
									min={0}
									max={levels.length - 1}
									step={1}
									disabled={props.disabled}
									onValueChange={(values) => setDraftIndex(values[0] ?? currentIndex)}
									onKeyDown={(event) => {
										if (event.key === "Enter" || event.key === " ") {
											event.preventDefault();
											handleOpenChange(false);
										}
									}}
									aria-label={t("thinking.pickerIntensityAria")}
									className="thinking-intensity-slider [&_[data-slot=slider-track]]:h-2.5"
									style={{ "--thinking-progress": progress } as CSSProperties}
								/>
								{/* 点层：与 Radix thumb 中心严格重合。thumb 中心 = calc(p% + offset)，
							    offset 把首尾中心夹在 [8, W-8]；等价于 8 + p*(W-16)，故直接用该式定位。 */}
								<div aria-hidden="true" className="pointer-events-none absolute inset-0">
									{levels.map((level, index) => {
										const percent = levels.length > 1 ? index / (levels.length - 1) : 0;
										return (
											<span
												key={level.value}
												data-track-dot={index <= draftIndex ? "filled" : "idle"}
												className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors ${index <= draftIndex ? "bg-white/70" : "bg-foreground/25"}`}
												style={{ left: `calc((100% - ${THUMB_HALF * 2}px) * ${percent} + ${THUMB_HALF}px)`, width: TRACK_DOT_SIZE, height: TRACK_DOT_SIZE }}
											/>
										);
									})}
								</div>
							</div>
							{/* 档位标签行：兼作点击入口，点击只改预览（与拖拽同一套 draft），关闭时统一提交 */}
							<div className="flex min-w-0 items-start justify-between gap-1">
								{levels.map((level, index) => (
									<Button
										key={level.value}
										type="button"
										variant="ghost"
										data-tick-value={level.value}
										className={`h-auto min-w-0 max-w-full truncate rounded-sm px-0.5 py-0 text-micro leading-4 font-normal shadow-none transition-colors hover:bg-transparent ${index === draftIndex ? "font-semibold text-foreground" : "text-muted-foreground"}`}
										disabled={props.disabled}
										title={level.descriptionKey ? t(level.descriptionKey) : level.description}
										onClick={() => setDraftIndex(index)}
									>
										{level.labelKey ? t(level.labelKey) : (level.label ?? level.value)}
									</Button>
								))}
							</div>
						</ThinkingWheelZone>
					</div>
				)}
			</PopoverContent>
		</Popover>
	);
}
