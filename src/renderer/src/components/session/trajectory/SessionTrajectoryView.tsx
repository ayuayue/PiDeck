import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useAtomValue } from "jotai";
import { Loader2, Activity, ArrowLeft, Check, Clock, Copy, CornerUpLeft, FileJson, Hash, Wrench } from "lucide-react";
import type { AgentRuntimeState, ChatMessage } from "../../../../../shared/types";
import type { SessionProcessEvent, SessionPromptSnapshot } from "../../../../../shared/types/trajectory";
import type { ModelTraceLogData } from "../../../../../shared/types/rpcLog";
import { sessionRuntimeBySessionIdAtomFamily } from "../../../atoms";
import { tpsDisplayModeAtom } from "../../../atoms/tps-atoms";
import { buildTpsDisplay } from "../../../utils/tpsDisplay";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { writeClipboard } from "../../../utils/clipboard";
import { formatModelRef } from "../../../utils/modelPendingDisplay";
import { formatDuration, formatTime } from "../TimelineFormat";
import { buildTrajectory, filterRecordsByRange, traceSizeLabel, type TrajectoryLane, type TrajectoryModelTraceSummary, type TrajectoryRecord, type TrajectoryTimeRange, type TrajectoryTurn } from "./buildTrajectory";
import type { SessionFactsCoverage } from "../../../../../shared/types/trajectory";
import { bucketOverviewTicks, buildTrajectoryWindow } from "./trajectoryWindow";
import { VirtualStack, VIRTUAL_STACK_MIN_ROWS } from "../../ui-shadcn/virtual-stack";
import { defaultFoldedTurns, foldedTurnPeek, foldTurnRecords, summarizeTurn } from "./trajectoryFold";
import { ModelTraceDetail } from "../../workspace/ModelTraceDetail";
import { countUserTurns } from "../timeline/turnRenderWindow";

const LANE_ORDER: TrajectoryLane[] = ["input", "model", "tools", "process"];
const MIN_DRAG_PX = 4;
const MIN_ZOOM_SPAN_MS = 40;

/**
 * 轨迹账本滚动位置的按会话记忆：抽屉 tab 切换会卸载本面板，卸载前把
 * scrollTop 写入模块级 store（组件外），重挂载且内容就绪后再恢复，
 * 避免每次切回 tab 都回到第一行。key 用 sessionId，切会话互不串扰。
 */
const trajectoryLedgerScrollStore = new Map<string, number>();

function laneLabel(lane: TrajectoryLane): string {
	if (lane === "input") return t("session.trajectory.lane.input");
	if (lane === "tools") return t("session.trajectory.lane.tools");
	if (lane === "process") return t("session.trajectory.lane.process");
	return t("session.trajectory.lane.model");
}

function kindLabel(record: TrajectoryRecord): string {
	if (record.kind === "user") {
		return record.isInitialPrompt ? t("session.trajectory.kind.initialPrompt") : t("session.trajectory.kind.user");
	}
	if (record.kind === "assistant") return t("session.trajectory.kind.assistant");
	if (record.kind === "thinking") return t("session.trajectory.kind.thinking");
	if (record.kind === "tool") return t("session.trajectory.kind.tool");
	if (record.kind === "modelRequest") return t("session.trajectory.kind.modelRequest");
	if (record.kind === "error") return t("session.trajectory.kind.error");
	if (record.kind === "systemPrompt") {
		if (record.promptKind === "initial") return t("session.trajectory.kind.systemPromptInitial");
		if (record.promptKind === "update") return t("session.trajectory.kind.systemPromptUpdate");
		if (record.promptKind === "snapshot") return t("session.trajectory.kind.systemPromptSnapshot");
		return t("session.trajectory.kind.systemPrompt");
	}
	if (record.kind === "process") {
		if (record.processKind === "session") return t("session.trajectory.kind.sessionHeader");
		if (record.processKind === "sessionInfo") return t("session.trajectory.kind.sessionInfo");
		if (record.processKind === "modelChange") return t("session.trajectory.kind.modelChange");
		if (record.processKind === "thinkingChange") return t("session.trajectory.kind.thinkingChange");
		if (record.processKind === "compaction") return t("session.trajectory.kind.compaction");
		if (record.processKind === "custom") return t("session.trajectory.kind.custom");
		if (record.processKind === "import") return t("session.trajectory.kind.import");
		if (record.processKind === "retry") return t("session.trajectory.kind.retry");
		if (record.processKind === "usage") return t("session.trajectory.kind.usage");
		return t("session.trajectory.kind.process");
	}
	return t("session.trajectory.kind.system");
}

function laneTone(lane: TrajectoryLane): string {
	if (lane === "input") return "bg-primary/70";
	if (lane === "tools") return "bg-warning/75 dark:bg-warning/70";
	// 轨迹泳道要的是实色带（70% 不透明），不是 chip 的淡底
	if (lane === "process") return "bg-[var(--color-identity-agent)] opacity-70";
	return "bg-[var(--color-identity-tool)] opacity-70";
}

function projectLeft(start: number, domainStart: number, span: number): number {
	if (span <= 0) return 0;
	return ((start - domainStart) / span) * 100;
}

function projectWidth(start: number, end: number, domainStart: number, span: number): number {
	if (span <= 0) return 100;
	return Math.max(((end - start) / span) * 100, 0.35);
}

function formatClock(ts: number): string {
	return new Date(ts).toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	});
}

/** 进行中 / 未测到 / 真实耗时 三分：0ms 不得再冒充「瞬间完成」；
 *  模型请求快照是时间点，时长列改显请求体体积（信息量更大）。 */
function durationLabel(record: TrajectoryRecord): string {
	if (record.kind === "modelRequest") return traceSizeLabel(record.modelTrace?.payloadBytes) || "—";
	if (record.endedAt === undefined) return t("session.trajectory.inFlight");
	if (record.durationMs === undefined) return t("session.trajectory.durationUnknown");
	return formatDuration(record.durationMs);
}

/** 账本行的时间列：有区间的显示耗时，时间点记录（用户/过程/系统提示词/错误）显示发生时刻。
 *  「未测到」只用于有区间但没测到的记录，不给点记录冒充。 */
function rowTimeLabel(record: TrajectoryRecord): string {
	if (record.kind === "modelRequest") return traceSizeLabel(record.modelTrace?.payloadBytes) || "—";
	if (record.endedAt === undefined) return t("session.trajectory.inFlight");
	if (record.durationMs === undefined) return record.startedAt > 0 ? formatClock(record.startedAt) : "—";
	return formatDuration(record.durationMs);
}

/** 紧凑 token 数（账本列窄，完整值走 hover 提示与检查器）。 */
function compactTokens(value: number): string {
	if (value >= 10_000) return `${Math.round(value / 1000)}k`;
	if (value >= 1_000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

/** 账本行内的「输入→输出」用量摘要；无用量（旧数据/未上报）不占位。 */
function usageSummary(record: TrajectoryRecord): string | undefined {
	if (!record.usage) return undefined;
	return `${compactTokens(record.usage.inputTokens)}→${compactTokens(record.usage.outputTokens)}`;
}

/** 用量 hover 提示：完整数字（含缓存/推理），键名走 i18n。 */
function usageTitle(record: TrajectoryRecord): string | undefined {
	const usage = record.usage;
	if (!usage) return undefined;
	return [
		`${t("session.trajectory.field.inputTokens")} ${usage.inputTokens}`,
		`${t("session.trajectory.field.outputTokens")} ${usage.outputTokens}`,
		usage.reasoningTokens !== undefined ? `${t("session.trajectory.field.reasoningTokens")} ${usage.reasoningTokens}` : undefined,
		usage.cacheReadTokens !== undefined ? `${t("session.trajectory.field.cacheRead")} ${usage.cacheReadTokens}` : undefined,
		usage.cacheWriteTokens !== undefined ? `${t("session.trajectory.field.cacheWrite")} ${usage.cacheWriteTokens}` : undefined,
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * 会话轨迹复盘：3-lane 时间线 + turn 账本 + 选中 inspector。
 * 数据来自当前栏已加载的 ChatMessage（含历史页），不另开 IPC。
 * drawer 变体改为竖排：概览 / 账本 / inspector 叠放，适配右侧窄栏。
 */
export function SessionTrajectoryView(props: {
	sessionId: string;
	messages: ChatMessage[];
	processEvents?: SessionProcessEvent[];
	/** 会话是否 DSH 后端（系统提示说明文案按后端区分）。 */
	isDsh?: boolean;
	/** 模型请求快照摘要（pi 会话；每个请求一行，可回读完整请求体）。 */
	modelTraces?: TrajectoryModelTraceSummary[];
	/** 事实覆盖范围（面板传入）：DEV 指标与「不可用」提示用。 */
	coverage?: SessionFactsCoverage;
	/** 来源会话（fork/子代理的父会话）：显示在面板顶部，可跳转。 */
	sourceSession?: { sessionId: string; title: string };
	/** 点击来源会话行时打开父会话（跨项目时缺省，行退化为纯展示）。 */
	onOpenSourceSession?: () => void;
	hasMoreMessages?: boolean;
	isLoadingMoreMessages?: boolean;
	onLoadMore?: () => void;
	variant?: "page" | "drawer";
}) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	// 对外「N 轮」口径（统一轮次契约）：DSH 会话用 host sessionStats（官方，与
	// dsh-web 一致，含 goal 自动续跑轮）；pi 会话（及 DSH 投影未到时的兜底）按
	// 发言权周期计（countUserTurns，与分页/缓存协议同口径，开口即算一轮）。
	// 账本分组结构仍按 user 开轮（buildTrajectory），连发 user 时组数可能略多于
	// 发言权轮数——账本是结构展示，对外计数统一走 countUserTurns。
	const dialogueTurns = props.isDsh === true && runtime?.state?.dshSessionStats ? runtime.state.dshSessionStats.turns : countUserTurns(props.messages);
	const [now, setNow] = useState(() => Date.now());
	const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
	const [range, setRange] = useState<TrajectoryTimeRange | undefined>(undefined);
	// 轨迹账本滚动容器的 ref + 记忆位：本次挂载是否已为当前会话恢复过滚动位置。
	const ledgerScrollRef = useRef<HTMLDivElement | null>(null);
	const scrollRestoredForRef = useRef<string | undefined>(undefined);
	const model = useMemo(() => {
		const started = performance.now();
		const built = buildTrajectory(props.messages, now, {
			processEvents: props.processEvents,
			modelTraces: props.modelTraces,
		});
		if (import.meta.env.DEV) {
			DEV_METRICS.buildCalls = Number(DEV_METRICS.buildCalls ?? 0) + 1;
			DEV_METRICS.lastBuildMs = Math.round((performance.now() - started) * 10) / 10;
			DEV_METRICS.records = built.records.length;
		}
		return built;
	}, [props.messages, props.processEvents, props.modelTraces, now]);
	const visible = useMemo(() => filterRecordsByRange(model.records, range), [model.records, range]);
	// 渲染窗口：只挂载尾部 3 轮（单轮 ≤120 条），挂载量与会话长度脱钩（计划 §5）。
	// 滚到顶部再放 3 轮；选中更早的记录时自动扩到它所在轮，概览点击才能落到可见区。
	const [turnCount, setTurnCount] = useState(3);
	// 折叠状态放视图层：工具栏需要一个统一的「全部折叠/展开」入口。
	const [foldedTurns, setFoldedTurns] = useState<Set<number>>(() => new Set(defaultFoldedTurns(model.turns)));
	const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
	useEffect(() => {
		setFoldedTurns(new Set(defaultFoldedTurns(model.turns)));
		setExpandedGroups(new Set());
	}, [props.sessionId]);
	const toggleTurn = useCallback((turn: number) => {
		setFoldedTurns((current) => {
			const next = new Set(current);
			if (next.has(turn)) next.delete(turn);
			else next.add(turn);
			return next;
		});
	}, []);
	const toggleGroup = useCallback((key: string) => {
		setExpandedGroups((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	}, []);
	const allFolded = model.turns.length > 0 && model.turns.every((turn) => foldedTurns.has(turn.index));
	const toggleAllTurns = useCallback(() => {
		setFoldedTurns(allFolded ? new Set() : new Set(model.turns.map((turn) => turn.index)));
	}, [allFolded, model.turns]);
	useEffect(() => {
		setTurnCount(3);
	}, [props.sessionId]);
	const windowTurnCount = useMemo(() => {
		const selectedTurn = visible.find((record) => record.id === selectedId)?.turnIndex;
		const lastTurn = visible[visible.length - 1]?.turnIndex ?? 0;
		const needed = selectedTurn === undefined ? 0 : lastTurn - selectedTurn + 1;
		return Math.max(turnCount, needed);
	}, [turnCount, selectedId, visible]);
	const windowed = useMemo(() => buildTrajectoryWindow(visible, { turnCount: windowTurnCount }), [visible, windowTurnCount]);
	// 滚动事件会连发：200ms 内只放一轮，避免一次手势把预算打穿。
	const lastExpandRef = useRef(0);
	useEffect(() => {
		if (!import.meta.env.DEV) return;
		DEV_METRICS.sessionId = props.sessionId;
		DEV_METRICS.mountedRecords = windowed.records.length;
		DEV_METRICS.totalRecords = model.records.length;
		DEV_METRICS.mountedTurns = model.turns.length;
		DEV_METRICS.processEvents = props.processEvents?.length ?? 0;
		DEV_METRICS.processEventsType = Array.isArray(props.processEvents) ? "array" : typeof props.processEvents;
		DEV_METRICS.coverage = props.coverage ?? null;
		DEV_METRICS.processRecords = model.records.filter((record) => record.lane === "process").length;
		(globalThis as { __pideckTrajectoryMetrics?: Record<string, unknown> }).__pideckTrajectoryMetrics = DEV_METRICS;
	});
	const requestEarlier = useCallback(() => {
		const now = Date.now();
		if (now - lastExpandRef.current < 200) return;
		lastExpandRef.current = now;
		setTurnCount((current) => current + 3);
	}, []);
	const selected = visible.find((record) => record.id === selectedId) ?? model.records.find((record) => record.id === selectedId);

	// 活动时长用低频时钟推进：只在本轮进行中才起 1 秒定时器，静态历史完全不动。
	// 为什么不能在 hover 时刷新 now：轨迹模型依赖 now，悬停会把整份账本重算一遍。
	const hasInFlight = model.turns.some((turn) => turn.inFlight);
	useEffect(() => {
		if (!hasInFlight) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [hasInFlight]);

	// 卸载前把当前滚动位置写回 store（切 tab 后组件卸载，位置靠 store 兜底）。
	useEffect(() => {
		return () => {
			const el = ledgerScrollRef.current;
			if (el) trajectoryLedgerScrollStore.set(props.sessionId, el.scrollTop);
		};
	}, [props.sessionId]);

	// 内容就绪（有可见记录）后一次性恢复该会话上次的滚动位置；内容还没撑出高度时
	// 先不恢复，等 records 变化再试，避免恢复落在空列表上。scrollRestoredForRef
	// 保证同一挂载只恢复一次，内容后续刷新不会反复覆盖用户的新滚动位置。
	useLayoutEffect(() => {
		const el = ledgerScrollRef.current;
		if (!el) return;
		if (scrollRestoredForRef.current === props.sessionId) return;
		if (visible.length === 0) return;
		const saved = trajectoryLedgerScrollStore.get(props.sessionId);
		if (saved !== undefined && saved > 0) {
			el.scrollTop = Math.min(saved, el.scrollHeight);
		}
		scrollRestoredForRef.current = props.sessionId;
	}, [props.sessionId, visible]);

	const drawer = props.variant === "drawer";

	return (
		<div className="flex h-full min-h-0 flex-col bg-background" data-session-view="trajectory">
			<div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
				<div className="flex min-w-0 items-center gap-2 text-caption text-muted-foreground">
					<Activity size={14} aria-hidden="true" />
					<span>{t("session.trajectory.turns", { count: dialogueTurns })}</span>
					<span aria-hidden="true">·</span>
					<span>{t("session.trajectory.records", { count: visible.length })}</span>
					<button type="button" className="rounded-sm px-1.5 text-caption text-primary hover:underline" onClick={toggleAllTurns}>
						{allFolded ? t("session.trajectory.unfoldAll") : t("session.trajectory.foldAll")}
					</button>
					{range ? (
						<button type="button" className="rounded-sm px-1.5 text-caption text-primary hover:underline" onClick={() => setRange(undefined)}>
							{t("session.trajectory.clearRange")}
						</button>
					) : null}
				</div>
				{props.hasMoreMessages ? (
					<button type="button" className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 text-caption text-muted-foreground hover:text-foreground" disabled={props.isLoadingMoreMessages} onClick={props.onLoadMore}>
						{props.isLoadingMoreMessages ? <Loader2 size={11} className="animate-pideck-spin" aria-hidden="true" /> : null}
						{props.isLoadingMoreMessages ? t("session.trajectory.loadingOlder") : t("session.trajectory.loadOlder")}
					</button>
				) : null}
			</div>
			<TrajectoryOverview records={model.records} domainStart={model.domainStart} domainEnd={model.domainEnd} range={range} selectedId={selected?.id} onSelect={setSelectedId} onRangeChange={setRange} />
			{props.sourceSession ? (
				<div className="flex shrink-0 items-center gap-1.5 border-b border-border/60 px-3 py-1 text-caption text-muted-foreground">
					<CornerUpLeft size={12} className="shrink-0" aria-hidden="true" />
					<span className="shrink-0">{t("session.trajectory.sourceSession")}</span>
					<button type="button" disabled={!props.onOpenSourceSession} className={`min-w-0 truncate font-medium ${props.onOpenSourceSession ? "text-primary hover:underline" : "cursor-default"}`} onClick={props.onOpenSourceSession} title={props.sourceSession.title}>
						{props.sourceSession.title}
					</button>
				</div>
			) : null}
			<div className={drawer ? "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(140px,38%)]" : "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(220px,32%)]"}>
				<TrajectoryLedger
					records={windowed.records}
					turns={model.turns}
					now={now}
					selectedId={selected?.id}
					onSelect={setSelectedId}
					borderBottom={drawer}
					scrollRef={ledgerScrollRef}
					onRequestEarlier={windowed.hasEarlier ? requestEarlier : undefined}
					foldedTurns={foldedTurns}
					expandedGroups={expandedGroups}
					onToggleTurn={toggleTurn}
					onToggleGroup={toggleGroup}
				/>
				<TrajectoryInspector record={selected} runtimeState={runtime?.state} isDsh={props.isDsh} />
			</div>
		</div>
	);
}

function TrajectoryOverview(props: { records: TrajectoryRecord[]; domainStart: number; domainEnd: number; range?: TrajectoryTimeRange; selectedId?: string; onSelect: (id: string) => void; onRangeChange: (range: TrajectoryTimeRange | undefined) => void }) {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; start: number } | undefined>(undefined);
	const [draft, setDraft] = useState<TrajectoryTimeRange | undefined>(undefined);
	const span = Math.max(props.domainEnd - props.domainStart, 1);
	// 概览刻度按像素聚合：标记数服从面板宽度，记录再多也不线性增加 DOM。
	const [trackWidth, setTrackWidth] = useState(600);
	// 轨道几何缓存：拖选 pointermove 与滚轮缩放都是高频事件，每次读
	// getBoundingClientRect 会在「React 写高亮 → 下一事件读 rect」之间强制同步
	// 布局。拖选期间轨道几何不变（高亮是绝对定位覆盖层，不影响布局），
	// pointerdown 时刷一次即可；尺寸变化由下方 ResizeObserver 兜底刷新。
	const trackRectRef = useRef<{ left: number; width: number } | null>(null);
	const refreshTrackRect = useCallback(() => {
		const el = trackRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		trackRectRef.current = { left: rect.left, width: rect.width };
	}, []);
	useLayoutEffect(() => {
		const el = trackRef.current;
		if (!el) return;
		setTrackWidth(el.clientWidth);
		refreshTrackRect();
		// 尺寸变化时轨道 left/width 都可能变：几何缓存随 ResizeObserver 一起刷新
		const observer = new ResizeObserver(() => {
			setTrackWidth(el.clientWidth);
			refreshTrackRect();
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [refreshTrackRect]);
	const ticks = useMemo(() => bucketOverviewTicks(props.records, { lanes: LANE_ORDER, width: trackWidth, selectedId: props.selectedId }), [props.records, props.selectedId, trackWidth]);
	useEffect(() => {
		if (import.meta.env.DEV) DEV_METRICS.overviewTicks = ticks.length;
	}, [ticks.length]);

	const timeAt = useCallback(
		(clientX: number): number => {
			const el = trackRef.current;
			if (!el) return props.domainStart;
			const cached = trackRectRef.current ?? el.getBoundingClientRect();
			const ratio = cached.width <= 0 ? 0 : Math.min(1, Math.max(0, (clientX - cached.left) / cached.width));
			return props.domainStart + ratio * span;
		},
		[props.domainStart, span],
	);

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		refreshTrackRect();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { x: event.clientX, start: timeAt(event.clientX) };
		setDraft(undefined);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag) return;
		if (Math.abs(event.clientX - drag.x) < MIN_DRAG_PX && !draft) return;
		const end = timeAt(event.clientX);
		setDraft({ start: Math.min(drag.start, end), end: Math.max(drag.start, end) });
	};

	const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		dragRef.current = undefined;
		if (!drag) return;
		if (Math.abs(event.clientX - drag.x) < MIN_DRAG_PX) {
			setDraft(undefined);
			return;
		}
		const end = timeAt(event.clientX);
		props.onRangeChange({ start: Math.min(drag.start, end), end: Math.max(drag.start, end) });
		setDraft(undefined);
	};

	const onWheel = useCallback(
		(event: WheelEvent) => {
			if (props.records.length === 0) return;
			event.preventDefault();
			const current = props.range ?? { start: props.domainStart, end: props.domainEnd };
			const width = Math.max(current.end - current.start, MIN_ZOOM_SPAN_MS);
			const factor = event.deltaY > 0 ? 1.2 : 0.8;
			const nextWidth = Math.min(span, Math.max(MIN_ZOOM_SPAN_MS, width * factor));
			const anchor = timeAt(event.clientX);
			const leftRatio = (anchor - current.start) / width;
			let start = anchor - nextWidth * leftRatio;
			let end = start + nextWidth;
			if (start < props.domainStart) {
				start = props.domainStart;
				end = start + nextWidth;
			}
			if (end > props.domainEnd) {
				end = props.domainEnd;
				start = end - nextWidth;
			}
			props.onRangeChange({ start, end });
		},
		[props.domainStart, props.domainEnd, props.range, props.records.length, props.onRangeChange, span, timeAt],
	);

	// React 的 onWheel 是 passive 监听：preventDefault 会被忽略并打出
	// "Unable to preventDefault inside passive event listener" 警告，滚轮还会带着面板一起滚。
	// 这里显式注册非 passive 原生监听，缩放时才真正吃掉滚轮事件。
	const wheelRef = useRef(onWheel);
	wheelRef.current = onWheel;
	useLayoutEffect(() => {
		const el = trackRef.current;
		if (!el) return;
		const handler = (event: WheelEvent) => wheelRef.current(event);
		el.addEventListener("wheel", handler, { passive: false });
		return () => el.removeEventListener("wheel", handler);
	}, []);

	const highlight = draft ?? props.range;
	// 刻度悬停提示按 id 查记录：Map 化把渲染体从 O(ticks×records) 降到 O(ticks)
	const recordsById = useMemo(() => new Map(props.records.map((record) => [record.id, record])), [props.records]);

	return (
		<div className="shrink-0 border-b border-border/60 px-3 py-2">
			<div className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2">
				<div className="flex h-16 flex-col justify-between py-0.5 text-micro leading-none text-muted-foreground">
					{LANE_ORDER.map((lane) => (
						<span key={lane}>{laneLabel(lane)}</span>
					))}
				</div>
				<div
					ref={trackRef}
					className="relative h-16 cursor-crosshair touch-none rounded-sm bg-muted/40"
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={() => {
						dragRef.current = undefined;
						setDraft(undefined);
					}}
					onDoubleClick={() => props.onRangeChange(undefined)}
				>
					{highlight ? (
						<div
							className="pointer-events-none absolute inset-y-0 bg-primary/10"
							style={{
								left: `${projectLeft(highlight.start, props.domainStart, span)}%`,
								width: `${projectWidth(highlight.start, highlight.end, props.domainStart, span)}%`,
							}}
						/>
					) : null}
					{LANE_ORDER.map((lane, laneIndex) => (
						<div key={lane} className="pointer-events-none absolute right-0 left-0" style={{ top: `${(laneIndex / LANE_ORDER.length) * 100}%`, height: `${100 / LANE_ORDER.length}%` }}>
							{ticks
								.filter((tick) => tick.lane === lane)
								.map((tick) => {
									const record = recordsById.get(tick.recordId);
									return (
										<button
											key={`${tick.lane}:${tick.recordId}:${tick.startedAt}`}
											type="button"
											title={record ? `${kindLabel(record)}${tick.count > 1 ? ` ×${tick.count}` : ""} · ${record.summary}` : undefined}
											className={`pointer-events-auto absolute top-1/2 h-2 -translate-y-1/2 rounded-sm ${laneTone(lane)} ${tick.selected ? "ring-1 ring-foreground" : ""}`}
											style={{
												left: `${projectLeft(tick.startedAt, props.domainStart, span)}%`,
												width: `${Math.max(0.6, (100 / Math.max(1, props.records.length)) * Math.min(tick.count, 12))}%`,
											}}
											onClick={(event) => {
												event.stopPropagation();
												props.onSelect(tick.recordId);
											}}
										/>
									);
								})}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}

/**
 * 冒烟探针（开发构建专用）：只写内存对象，不进生产、不写日志。
 * DevTools 里读 `window.__pideckTrajectoryMetrics` 即可核对真实挂载量与重建次数。
 */
const DEV_METRICS: Record<string, unknown> = {};

function turnDurationLabel(turn: { inFlight: boolean; durationMs?: number; startedAt: number } | undefined, now: number): string | undefined {
	if (!turn) return undefined;
	if (turn.inFlight) {
		const elapsed = Math.max(0, now - turn.startedAt);
		return elapsed > 0 ? formatDuration(elapsed) : t("session.trajectory.inFlight");
	}
	if (turn.durationMs === undefined) return undefined;
	return formatDuration(turn.durationMs);
}

function TrajectoryLedger(props: {
	records: TrajectoryRecord[];
	turns: TrajectoryTurn[];
	now: number;
	selectedId?: string;
	onSelect: (id: string) => void;
	borderBottom?: boolean;
	/** 滚动容器 ref：切 tab 卸载前保存、重挂载后恢复滚动位置。 */
	scrollRef?: RefObject<HTMLDivElement | null>;
	/** 滚到顶时再放一轮窗口；未裁剪时缺省（不显示「更早」入口）。 */
	onRequestEarlier?: () => void;
	/** 折叠状态由视图层持有：工具栏的统一折叠入口要能改它。 */
	foldedTurns: Set<number>;
	expandedGroups: Set<string>;
	onToggleTurn: (turn: number) => void;
	onToggleGroup: (key: string) => void;
}) {
	// 滚动窗必须有一个确定存在的 ref：容器与虚拟栈得指向同一个对象。外部传的 ref 只用于
	// 「切 tab 卸载前保存、重挂载后恢复滚动位置」，是可选的；缺省时用内部兜底，
	// 这样 VirtualStack 的 scrollRef（必填）永远拿得到真实元素（2026-10 审查后收窄）。
	const localScrollRef = useRef<HTMLDivElement | null>(null);
	const scrollRef = props.scrollRef ?? localScrollRef;
	const byTurn = useMemo(() => {
		const map = new Map<number, TrajectoryRecord[]>();
		for (const record of props.records) {
			const bucket = map.get(record.turnIndex);
			if (bucket) bucket.push(record);
			else map.set(record.turnIndex, [record]);
		}
		return map;
	}, [props.records]);

	const row = (record: TrajectoryRecord) => (
		<button type="button" className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-caption hover:bg-muted/50 ${record.id === props.selectedId ? "bg-muted" : ""}`} onClick={() => props.onSelect(record.id)}>
			<span className={`mt-1 size-1.5 shrink-0 rounded-full ${laneTone(record.lane)}`} />
			<span className="w-20 shrink-0 font-medium text-foreground">{kindLabel(record)}</span>
			<span className="min-w-0 flex-1 truncate text-muted-foreground">{record.summary || "—"}</span>
			{usageSummary(record) ? (
				<span className="shrink-0 tabular-nums text-micro text-muted-foreground" title={usageTitle(record)}>
					{usageSummary(record)}
				</span>
			) : null}
			<span className="shrink-0 tabular-nums text-muted-foreground">{rowTimeLabel(record)}</span>
		</button>
	);

	// ── 扁平化（虚拟化的前提）──────────────────────────────────────────────
	// 虚拟栈只吃扁平数组，所以把「轮标题 / 记录行 / 组折叠行」压成同一层。
	// 原树形 DOM 的唯一消费者是父级的 `divide-y`，改为行自带 border-b ——
	// 虚拟化后行是 absolute、彼此不是兄弟，兄弟选择器不再生效。
	type TrajectoryRow = { kind: "turn"; key: string; index: number; steps: number; tools: number; tokens: string | null; duration: string | null } | { kind: "record"; key: string; record: TrajectoryRecord } | { kind: "group-fold"; key: string; count: number; toolCalls: number };

	// 轮头数据单独 memo：短列表分支要按基线两层结构渲染，必须与扁平化分支用同一份计算，
	// 不能各算一遍（两份算法迟早走偏，而走偏的表现只是「展开后数字对不上」）。
	const turnHeadByIndex = useMemo(() => {
		const map = new Map<number, { steps: number; tools: number; tokens: string | null; duration: string | null }>();
		for (const [turnIndex, turnRecords] of byTurn) {
			const summary = summarizeTurn(props.turns[turnIndex], props.turns[turnIndex]?.records ?? turnRecords);
			const totalTokens = summary.inputTokens + summary.outputTokens;
			map.set(turnIndex, {
				steps: summary.steps,
				tools: summary.toolCalls,
				tokens: totalTokens > 0 ? `${compactTokens(summary.inputTokens)}→${compactTokens(summary.outputTokens)}` : null,
				duration: turnDurationLabel(props.turns[turnIndex], props.now) ?? null,
			});
		}
		return map;
	}, [byTurn, props.turns, props.now]);

	const rows = useMemo<TrajectoryRow[]>(() => {
		const out: TrajectoryRow[] = [];
		for (const [turnIndex, turnRecords] of byTurn) {
			const folded = props.foldedTurns.has(turnIndex);
			const head = turnHeadByIndex.get(turnIndex);
			out.push({ kind: "turn", key: `turn:${turnIndex}`, index: turnIndex, steps: head?.steps ?? 0, tools: head?.tools ?? 0, tokens: head?.tokens ?? null, duration: head?.duration ?? null });
			if (folded) {
				const peek = foldedTurnPeek(turnRecords);
				if (peek) out.push({ kind: "record", key: `peek:${peek.id}`, record: peek });
				continue;
			}
			for (const item of foldTurnRecords(turnRecords)) {
				if (item.type === "record") {
					out.push({ kind: "record", key: item.record.id, record: item.record });
					continue;
				}
				if (props.expandedGroups.has(item.key)) {
					for (const record of item.records) out.push({ kind: "record", key: record.id, record });
					continue;
				}
				out.push({ kind: "group-fold", key: item.key, count: item.records.length, toolCalls: item.toolCalls });
			}
		}
		return out;
	}, [byTurn, props.foldedTurns, props.expandedGroups, turnHeadByIndex]);

	// 三种扁平行的渲染：虚拟化分支与短列表分支共用这一份，避免两份 JSX 走偏。
	const renderRow = (item: TrajectoryRow) => {
		if (item.kind === "turn") {
			return (
				<button type="button" className="flex w-full items-center justify-between gap-2 bg-muted/40 px-3 py-1 text-micro font-medium tracking-wide text-muted-foreground uppercase hover:bg-muted/60" onClick={() => props.onToggleTurn(item.index)}>
					<span>{t("session.trajectory.turn", { index: item.index + 1 })}</span>
					<span className="flex items-center gap-2 tabular-nums normal-case">
						<span>{t("session.trajectory.turnSteps", { steps: item.steps, tools: item.tools })}</span>
						{item.tokens ? <span>{item.tokens}</span> : null}
						{item.duration ? <span>{item.duration}</span> : null}
					</span>
				</button>
			);
		}
		if (item.kind === "group-fold") {
			return (
				<button type="button" className="w-full px-3 py-1.5 text-left text-caption text-muted-foreground hover:bg-muted/50" onClick={() => props.onToggleGroup(item.key)}>
					{t("session.trajectory.groupFold", { steps: item.count, tools: item.toolCalls })}
				</button>
			);
		}
		// 记录行：row(record) 只产出按钮本体，外层 li 由两条渲染路径各自提供
		// （短列表 ul>li，虚拟列表 div[role=list]>div[role=listitem]）。
		return row(item.record);
	};

	return (
		<div
			ref={scrollRef}
			className={`min-h-0 overflow-auto ${props.borderBottom ? "border-b border-border/60" : "border-r border-border/60"}`}
			onScroll={(event) => {
				// 顶部 48px 内继续上滚 → 放下一轮窗口（滑动窗口，不累加挂载）。
				if (event.currentTarget.scrollTop > 48) return;
				props.onRequestEarlier?.();
			}}
		>
			{props.records.length === 0 ? (
				<div className="px-3 py-6 text-center text-caption text-muted-foreground">{t("session.trajectory.empty")}</div>
			) : rows.length <= VIRTUAL_STACK_MIN_ROWS ? (
				// 短列表不走虚拟栈（虚拟栈对 ≤16 行走直出路径），并且**结构与接入虚拟化前逐字节一致**：
				// 两层 ul —— 外层 divide-y /50 分隔「轮」，内层 divide-y /40 分隔「记录行」。
				//
				// 这一条是被维护者打回过的：上一版为了复用扁平化数据把它拍成一层 ul（记录行直接成
				// 外层的 li），结果记录行的分隔线从基线内层的 /40 变成外层的 /50，而「轮 → 记录」
				// 的嵌套列表语义也没了。拍平是虚拟路径的必要代价（虚拟栈只吃一维数组），但不能
				// 顺手把短列表也拍平 —— 短列表路径的全部价值就是「DOM 与改前一致」。
				//
				// 虚拟路径的差异登记在 docs/virtualization-audit.md 与交付 README 的「已知的差异」。
				<ul className="divide-y divide-border/50">
					{[...byTurn.entries()].map(([turnIndex, turnRecords]) => {
						const folded = props.foldedTurns.has(turnIndex);
						const peek = folded ? foldedTurnPeek(turnRecords) : undefined;
						const head = turnHeadByIndex.get(turnIndex);
						return (
							<li key={`turn:${turnIndex}`}>
								{renderRow({
									kind: "turn",
									key: `turn:${turnIndex}`,
									index: turnIndex,
									steps: head?.steps ?? 0,
									tools: head?.tools ?? 0,
									tokens: head?.tokens ?? null,
									duration: head?.duration ?? null,
								})}
								<ul className="divide-y divide-border/40">
									{folded
										? peek
											? [<li key={peek.id}>{renderRow({ kind: "record", key: peek.id, record: peek })}</li>]
											: null
										: foldTurnRecords(turnRecords).map((item) => {
												if (item.type === "record") return <li key={item.record.id}>{renderRow({ kind: "record", key: item.record.id, record: item.record })}</li>;
												if (props.expandedGroups.has(item.key)) return item.records.map((record) => <li key={record.id}>{renderRow({ kind: "record", key: record.id, record })}</li>);
												return <li key={item.key}>{renderRow({ kind: "group-fold", key: item.key, count: item.records.length, toolCalls: item.toolCalls })}</li>;
											})}
								</ul>
							</li>
						);
					})}
				</ul>
			) : (
				<VirtualStack
					items={rows}
					getKey={(item) => item.key}
					scrollRef={scrollRef}
					minRows={VIRTUAL_STACK_MIN_ROWS}
					// 轮标题 22px、记录行 26px、组折叠行 28px，取中间档；实测随即覆盖。
					// 虚拟路径把两层列表压平（虚拟栈只吃一维数组），行间分隔线只能统一取记录行那一档
					// /40（基线里轮与轮之间是 /50、轮内记录行是 /40）。短列表路径保留基线两层结构。
					rowClassName="border-b border-border/40"
					// 虚拟行是 div，列表语义靠 role 补：内容盒 role="list"、每行 role="listitem"。
					// 短列表路径不用这两个 prop（那一支是 ul > li 两层）。
					containerProps={{ role: "list" }}
					rowProps={() => ({ role: "listitem" })}
					renderItem={(item) => renderRow(item)}
				/>
			)}
		</div>
	);
}

/**
 * dsh-web 详情面板的复制控件（CodeBlock / JsonTree）：
 * 工具入参、结果、思考正文各自一块，点复制写整段。
 */
function CopyableBlock(props: { label?: string; text: string }) {
	const [copied, setCopied] = useState(false);
	const onCopy = async () => {
		if (!props.text || copied) return;
		await writeClipboard(props.text);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	};
	return (
		<div className="mt-3">
			<div className="mb-1 flex items-center justify-between gap-2">
				{props.label ? <span className="text-micro font-medium tracking-wide text-muted-foreground uppercase">{props.label}</span> : <span />}
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-micro text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
					onClick={() => {
						void onCopy();
					}}
					title={t("common.copy")}
				>
					{copied ? <Check size={11} /> : <Copy size={11} />}
					{copied ? t("common.copied") : t("common.copy")}
				</button>
			</div>
			{/* scroll-ok: text —— 单一文本块（复制出来的记录详情），没有行列表可虚拟化 */}
			<pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-2 text-micro leading-relaxed wrap-break-word whitespace-pre-wrap">{props.text}</pre>
		</div>
	);
}

/**
 * 系统提示词快照详情：全文 + 当前工具目录 + 相对上一份的变更。
 * 数据只来自会话事实（pi 的 system 条目重放 / dsh 的 system.message 与请求头），
 * 没有事实就不渲染（不再用 pi-system 模板冒充）。
 */
function PromptSnapshotDetail(props: { prompt: SessionPromptSnapshot }) {
	const prompt = props.prompt;
	const changes = [
		[t("session.trajectory.prompt.sectionsAdded"), prompt.sectionsAdded],
		[t("session.trajectory.prompt.sectionsUpdated"), prompt.sectionsUpdated],
		[t("session.trajectory.prompt.sectionsRemoved"), prompt.sectionsRemoved],
		[t("session.trajectory.prompt.toolsAdded"), prompt.toolsAdded],
		[t("session.trajectory.prompt.toolsRemoved"), prompt.toolsRemoved],
	].filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].length > 0);
	return (
		<div className="mt-2 border-t border-border/60 pt-3">
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
				<dt className="text-muted-foreground">{t("session.trajectory.prompt.chars")}</dt>
				<dd className="tabular-nums">{prompt.text.length}</dd>
				<dt className="text-muted-foreground">{t("session.trajectory.prompt.tools")}</dt>
				<dd className="tabular-nums">{prompt.tools.length}</dd>
			</dl>
			{changes.length > 0 ? (
				<ul className="mt-2 space-y-1 text-caption">
					{changes.map(([label, names]) => (
						<li key={label} className="flex gap-1.5">
							<span className="shrink-0 text-muted-foreground">{label}</span>
							<span className="min-w-0 font-mono text-micro wrap-break-word">{names.join(", ")}</span>
						</li>
					))}
				</ul>
			) : null}
			{prompt.tools.length > 0 ? (
				<div className="mt-2">
					<p className="mb-1 text-micro font-medium tracking-wide text-muted-foreground uppercase">{t("session.trajectory.prompt.toolList")}</p>
					<p className="font-mono text-micro leading-relaxed text-muted-foreground wrap-break-word">{prompt.tools.join(", ")}</p>
				</div>
			) : null}
			{prompt.truncated ? <p className="mt-2 text-caption text-warning">{t("session.trajectory.prompt.truncated")}</p> : null}
			<CopyableBlock label={t("session.trajectory.prompt.fullText")} text={prompt.text} />
		</div>
	);
}

function TrajectoryInspector(props: {
	record?: TrajectoryRecord;
	runtimeState?: AgentRuntimeState;
	/** 会话是否 DSH 后端（系统提示说明文案按后端区分）。 */
	isDsh?: boolean;
}) {
	const record = props.record;
	const state = props.runtimeState;
	const tpsMode = useAtomValue(tpsDisplayModeAtom);
	const sessionStats = state?.dshSessionStats;
	// 最近一次回复的模型：结算时记账的 perfModel*（切模型后仍归属发起这次回复的那个模型）。
	const perfModelLabel = state?.perfModelId || state?.perfModelName ? formatModelRef({ provider: state.perfProvider ?? "", modelId: state.perfModelId ?? "", modelName: state.perfModelName }) : undefined;
	const throughput = buildTpsDisplay(tpsMode, sessionStats ? sessionStats.tokensPerSecond : state?.tps, sessionStats ? sessionStats.endToEndTokensPerSecond : state?.endToEndTps, sessionStats ? "session" : "reply", 1);
	// modelRequest 检查器的完整请求体回读：按记录隔离，切换选中即清空。
	const [traceView, setTraceView] = useState<{ traceId: string; status: "loading" | "loaded" | "missing"; payloadJson?: string } | undefined>(undefined);
	useEffect(() => {
		setTraceView(undefined);
	}, [record?.id]);
	const openTrace = useCallback(() => {
		const target = record?.modelTrace;
		if (!target?.agentId) return;
		setTraceView({ traceId: target.traceId, status: "loading" });
		void desktopApi.rpcLogs
			.getModelTrace({ agentId: target.agentId, traceId: target.traceId })
			.then((result) => {
				setTraceView(result ? { traceId: target.traceId, status: "loaded", payloadJson: result.payloadJson } : { traceId: target.traceId, status: "missing" });
			})
			.catch(() => {
				setTraceView({ traceId: target.traceId, status: "missing" });
			});
	}, [record?.modelTrace]);
	if (!record) {
		// scroll-ok: text —— 没选中记录时的一行提示文案，没有行列表。
		return <div className="min-h-0 overflow-auto px-3 py-4 text-caption text-muted-foreground">{t("session.trajectory.inspectHint")}</div>;
	}
	// 请求体回读视图接管检查器：结构与 RPC 面板的模型行展开共用 ModelTraceDetail。
	if (record.kind === "modelRequest" && traceView) {
		const summary: ModelTraceLogData | undefined = record.modelTrace
			? {
					kind: "request",
					traceId: record.modelTrace.traceId,
					model: record.modelId,
					provider: record.provider,
					messageCount: record.modelTrace.messageCount,
					toolCount: record.modelTrace.toolCount,
					payloadBytes: record.modelTrace.payloadBytes,
					truncated: record.modelTrace.truncated,
				}
			: undefined;
		return (
			<div className="flex h-full min-h-0 flex-col px-3 py-2">
				<button type="button" className="mb-2 inline-flex w-fit items-center gap-1 rounded-sm px-1.5 py-0.5 text-caption text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => setTraceView(undefined)}>
					<ArrowLeft size={12} />
					{t("session.trajectory.backToRecord")}
				</button>
				<div
					/* scroll-ok: text —— 整块交给 ModelTraceDetail（一次请求体回读的单一载荷视图），没有可枚举的行列表。 */
					className="min-h-0 flex-1 overflow-auto"
				>
					{traceView.status === "loading" ? <p className="py-4 text-center text-caption text-muted-foreground">{t("session.trajectory.traceLoading")}</p> : null}
					{traceView.status === "missing" ? <p className="py-4 text-center text-caption text-muted-foreground">{t("session.trajectory.traceMissing")}</p> : null}
					{traceView.status === "loaded" && summary ? <ModelTraceDetail payloadJson={traceView.payloadJson ?? ""} summary={summary} /> : null}
				</div>
			</div>
		);
	}
	// scroll-ok: bounded —— 单条记录的固定字段表（dl 网格，字段由 record 形状决定），行数不随会话增长。
	return (
		<div className="min-h-0 overflow-auto px-3 py-3">
			<div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
				{record.kind === "tool" ? <Wrench size={14} /> : record.kind === "modelRequest" ? <FileJson size={14} /> : <Hash size={14} />}
				{record.kind === "tool" ? record.toolName : kindLabel(record)}
			</div>
			{record.kind === "systemPrompt" ? <p className="mb-2 text-caption text-muted-foreground">{props.isDsh ? t("session.trajectory.systemPromptHintDsh") : t("session.trajectory.systemPromptHint")}</p> : null}
			{record.prompt ? <PromptSnapshotDetail prompt={record.prompt} /> : null}
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
				{record.startedAt > 0 ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.time")}</dt>
						<dd className="tabular-nums">
							{formatTime(record.startedAt)} · {formatClock(record.startedAt)}
						</dd>
					</>
				) : null}
				<dt className="text-muted-foreground">{t("session.trajectory.field.duration")}</dt>
				<dd className="tabular-nums">{durationLabel(record)}</dd>
				{record.status && record.kind !== "process" ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.status")}</dt>
						<dd>{record.status}</dd>
					</>
				) : null}
				{record.toolCallId ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.callId")}</dt>
						<dd className="truncate font-mono text-micro">{record.toolCallId}</dd>
					</>
				) : null}
				{record.cwd ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.cwd")}</dt>
						<dd className="truncate font-mono text-micro">{record.cwd}</dd>
					</>
				) : null}
				{record.provider || record.modelId ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.model")}</dt>
						<dd className="truncate">{[record.provider, record.modelId].filter(Boolean).join("/")}</dd>
					</>
				) : null}
				{record.thinkingLevel ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.thinkingLevel")}</dt>
						<dd>{record.thinkingLevel}</dd>
					</>
				) : null}
				{record.usage ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.inputTokens")}</dt>
						<dd className="tabular-nums">{record.usage.inputTokens}</dd>
						<dt className="text-muted-foreground">{t("session.trajectory.field.outputTokens")}</dt>
						<dd className="tabular-nums">{record.usage.outputTokens}</dd>
						{record.usage.reasoningTokens !== undefined ? (
							<>
								<dt className="text-muted-foreground">{t("session.trajectory.field.reasoningTokens")}</dt>
								<dd className="tabular-nums">{record.usage.reasoningTokens}</dd>
							</>
						) : null}
						{record.usage.cacheReadTokens !== undefined ? (
							<>
								<dt className="text-muted-foreground">{t("session.trajectory.field.cacheRead")}</dt>
								<dd className="tabular-nums">{record.usage.cacheReadTokens}</dd>
							</>
						) : null}
						{record.usage.cacheWriteTokens !== undefined ? (
							<>
								<dt className="text-muted-foreground">{t("session.trajectory.field.cacheWrite")}</dt>
								<dd className="tabular-nums">{record.usage.cacheWriteTokens}</dd>
							</>
						) : null}
					</>
				) : null}
				{record.modelTrace ? (
					<>
						{record.modelTrace.messageCount !== undefined ? (
							<>
								<dt className="text-muted-foreground">{t("session.trajectory.field.traceMessages")}</dt>
								<dd className="tabular-nums">{record.modelTrace.messageCount}</dd>
							</>
						) : null}
						{record.modelTrace.toolCount !== undefined ? (
							<>
								<dt className="text-muted-foreground">{t("session.trajectory.field.traceTools")}</dt>
								<dd className="tabular-nums">{record.modelTrace.toolCount}</dd>
							</>
						) : null}
						{record.modelTrace.payloadBytes !== undefined ? (
							<>
								<dt className="text-muted-foreground">{t("session.trajectory.field.traceSize")}</dt>
								<dd className="tabular-nums">{traceSizeLabel(record.modelTrace.payloadBytes) || "—"}</dd>
							</>
						) : null}
						{record.modelTrace.truncated ? (
							<>
								<dt className="text-muted-foreground">{t("session.trajectory.field.traceTruncated")}</dt>
								<dd>{t("session.trajectory.traceTruncatedYes")}</dd>
							</>
						) : null}
					</>
				) : null}
				{record.customType ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.customType")}</dt>
						<dd className="truncate font-mono text-micro">{record.customType}</dd>
					</>
				) : null}
				{record.retry !== undefined ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.retry")}</dt>
						<dd className="tabular-nums">{record.maxRetries !== undefined ? `${record.retry}/${record.maxRetries}` : record.retry}</dd>
					</>
				) : null}
				{record.retryDelayMs !== undefined ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.retryDelay")}</dt>
						<dd className="tabular-nums">{formatDuration(record.retryDelayMs)}</dd>
					</>
				) : null}
			</dl>
			{record.inputDetail ? <CopyableBlock label={t("session.trajectory.field.payload")} text={record.inputDetail} /> : null}
			{record.outputDetail ? <CopyableBlock label={t("session.trajectory.field.result")} text={record.outputDetail} /> : null}{" "}
			{record.kind === "modelRequest" && record.modelTrace?.agentId ? (
				<button type="button" className="mt-3 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border/70 px-2 py-1.5 text-caption hover:bg-muted" onClick={openTrace}>
					<FileJson size={13} />
					{t("session.trajectory.viewFullRequest")}
				</button>
			) : null}
			{!record.prompt && !record.inputDetail && !record.outputDetail && (record.detail || record.text) ? <CopyableBlock text={record.detail || record.text || ""} /> : null}
			{state && (state.ttftMs !== undefined || state.inputTokens !== undefined || state.totalMs !== undefined || state.dshSessionStats !== undefined) ? (
				<div className="mt-4 border-t border-border/60 pt-3">
					<div className="mb-1 flex items-center gap-1 text-caption font-medium">
						<Clock size={12} />
						{t("session.trajectory.runtime")}
					</div>
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption text-muted-foreground">
						{perfModelLabel ? (
							<>
								<dt>{t("session.trajectory.field.provider")}</dt>
								<dd className="truncate">{state.perfProvider || "—"}</dd>
								<dt>{t("session.trajectory.field.model")}</dt>
								<dd className="truncate">{perfModelLabel}</dd>
							</>
						) : null}
						{state.ttftMs !== undefined ? (
							<>
								<dt>TTFT</dt>
								<dd className="tabular-nums">{formatDuration(state.ttftMs)}</dd>
							</>
						) : null}
						{state.totalMs !== undefined ? (
							<>
								<dt>{t("session.trajectory.field.total")}</dt>
								<dd className="tabular-nums">{formatDuration(state.totalMs)}</dd>
							</>
						) : null}
						{state.tps !== undefined || state.endToEndTps !== undefined || state.totalMs !== undefined || sessionStats !== undefined ? (
							<>
								<dt title={throughput.hint}>{throughput.label}</dt>
								<dd className="tabular-nums">{throughput.value}</dd>
							</>
						) : null}
						{state.inputTokens !== undefined ? (
							<>
								<dt>{t("session.trajectory.field.inputTokens")}</dt>
								<dd className="tabular-nums">{state.inputTokens}</dd>
							</>
						) : null}
						{state.outputTokens !== undefined ? (
							<>
								<dt>{t("session.trajectory.field.outputTokens")}</dt>
								<dd className="tabular-nums">{state.outputTokens}</dd>
							</>
						) : null}
						{state.cacheRead !== undefined ? (
							<>
								<dt>{t("session.trajectory.field.cacheRead")}</dt>
								<dd className="tabular-nums">{state.cacheRead}</dd>
							</>
						) : null}
					</dl>
				</div>
			) : null}
		</div>
	);
}
