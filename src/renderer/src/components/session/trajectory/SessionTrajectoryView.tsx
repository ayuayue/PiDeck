import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { useAtomValue } from "jotai";
import { Activity, Check, Clock, Copy, Hash, Wrench } from "lucide-react";
import type { AgentRuntimeState, ChatMessage } from "../../../../../shared/types";
import type { SessionProcessEvent } from "../../../../../shared/types/trajectory";
import { sessionRuntimeBySessionIdAtomFamily } from "../../../atoms";
import { t } from "../../../i18n";
import { writeClipboard } from "../../../utils/clipboard";
import { formatDuration, formatTime } from "../TimelineFormat";
import {
	buildTrajectory,
	filterRecordsByRange,
	type TrajectoryLane,
	type TrajectoryRecord,
	type TrajectoryTimeRange,
	type TrajectoryTurn,
} from "./buildTrajectory";
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
	if (record.kind === "error") return t("session.trajectory.kind.error");
	if (record.kind === "systemPrompt") return t("session.trajectory.kind.systemPrompt");
	if (record.kind === "process") {
		if (record.processKind === "session") return t("session.trajectory.kind.sessionHeader");
		if (record.processKind === "sessionInfo") return t("session.trajectory.kind.sessionInfo");
		if (record.processKind === "modelChange") return t("session.trajectory.kind.modelChange");
		if (record.processKind === "thinkingChange") return t("session.trajectory.kind.thinkingChange");
		if (record.processKind === "compaction") return t("session.trajectory.kind.compaction");
		if (record.processKind === "custom") return t("session.trajectory.kind.custom");
		if (record.processKind === "import") return t("session.trajectory.kind.import");
		if (record.processKind === "retry") return t("session.trajectory.kind.retry");
		return t("session.trajectory.kind.process");
	}
	return t("session.trajectory.kind.system");
}

function laneTone(lane: TrajectoryLane): string {
	if (lane === "input") return "bg-primary/70";
	if (lane === "tools") return "bg-amber-500/75 dark:bg-amber-400/70";
	if (lane === "process") return "bg-violet-500/70 dark:bg-violet-400/65";
	return "bg-sky-500/70 dark:bg-sky-400/65";
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

/** 进行中 / 未测到 / 真实耗时 三分：0ms 不得再冒充「瞬间完成」。 */
function durationLabel(record: TrajectoryRecord): string {
	if (record.endedAt === undefined) return t("session.trajectory.inFlight");
	if (record.durationMs === undefined) return t("session.trajectory.durationUnknown");
	return formatDuration(record.durationMs);
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
	systemPrompt?: string;
	/** 会话是否 DSH 后端（系统提示说明文案按后端区分）。 */
	isDsh?: boolean;
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
	const dialogueTurns =
		props.isDsh === true && runtime?.state?.dshSessionStats
			? runtime.state.dshSessionStats.turns
			: countUserTurns(props.messages);
	const [now, setNow] = useState(() => Date.now());
	const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
	const [range, setRange] = useState<TrajectoryTimeRange | undefined>(undefined);
	// 轨迹账本滚动容器的 ref + 记忆位：本次挂载是否已为当前会话恢复过滚动位置。
	const ledgerScrollRef = useRef<HTMLDivElement | null>(null);
	const scrollRestoredForRef = useRef<string | undefined>(undefined);
	const model = useMemo(
		() => buildTrajectory(props.messages, now, {
			processEvents: props.processEvents,
			systemPrompt: props.systemPrompt,
		}),
		[props.messages, props.processEvents, props.systemPrompt, now],
	);
	const visible = useMemo(() => filterRecordsByRange(model.records, range), [model.records, range]);
	const selected = visible.find((record) => record.id === selectedId) ?? model.records.find((record) => record.id === selectedId);

	const refreshNow = useCallback(() => {
		if (model.turns.some((turn) => turn.inFlight)) setNow(Date.now());
	}, [model.turns]);

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
					{range ? (
						<button
							type="button"
							className="rounded-sm px-1.5 text-caption text-primary hover:underline"
							onClick={() => setRange(undefined)}
						>
							{t("session.trajectory.clearRange")}
						</button>
					) : null}
				</div>
				{props.hasMoreMessages ? (
					<button
						type="button"
						className="shrink-0 rounded-sm px-1.5 text-caption text-muted-foreground hover:text-foreground"
						disabled={props.isLoadingMoreMessages}
						onClick={props.onLoadMore}
					>
						{props.isLoadingMoreMessages
							? t("session.trajectory.loadingOlder")
							: t("session.trajectory.loadOlder")}
					</button>
				) : null}
			</div>
			<TrajectoryOverview
				records={model.records}
				domainStart={model.domainStart}
				domainEnd={model.domainEnd}
				range={range}
				selectedId={selected?.id}
				onSelect={setSelectedId}
				onRangeChange={setRange}
				onHoverTick={refreshNow}
			/>
			<div
				className={
					drawer
						? "grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)_minmax(140px,38%)]"
						: "grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(220px,32%)]"
				}
			>
				<TrajectoryLedger
					records={visible}
					turns={model.turns}
					now={now}
					selectedId={selected?.id}
					onSelect={setSelectedId}
					borderBottom={drawer}
					scrollRef={ledgerScrollRef}
				/>
				<TrajectoryInspector record={selected} runtimeState={runtime?.state} isDsh={props.isDsh} />
			</div>
		</div>
	);
}

function TrajectoryOverview(props: {
	records: TrajectoryRecord[];
	domainStart: number;
	domainEnd: number;
	range?: TrajectoryTimeRange;
	selectedId?: string;
	onSelect: (id: string) => void;
	onRangeChange: (range: TrajectoryTimeRange | undefined) => void;
	onHoverTick: () => void;
}) {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ x: number; start: number } | undefined>(undefined);
	const [draft, setDraft] = useState<TrajectoryTimeRange | undefined>(undefined);
	const span = Math.max(props.domainEnd - props.domainStart, 1);

	const timeAt = useCallback((clientX: number): number => {
		const el = trackRef.current;
		if (!el) return props.domainStart;
		const rect = el.getBoundingClientRect();
		const ratio = rect.width <= 0 ? 0 : Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
		return props.domainStart + ratio * span;
	}, [props.domainStart, span]);

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { x: event.clientX, start: timeAt(event.clientX) };
		setDraft(undefined);
	};

	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		props.onHoverTick();
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

	const onWheel = (event: React.WheelEvent<HTMLDivElement>) => {
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
	};

	const highlight = draft ?? props.range;

	return (
		<div className="shrink-0 border-b border-border/60 px-3 py-2">
			<div className="grid grid-cols-[44px_minmax(0,1fr)] gap-x-2">
				<div className="flex h-16 flex-col justify-between py-0.5 text-[10px] leading-none text-muted-foreground">
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
					onWheel={onWheel}
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
						<div
							key={lane}
							className="pointer-events-none absolute right-0 left-0"
							style={{ top: `${(laneIndex / LANE_ORDER.length) * 100}%`, height: `${100 / LANE_ORDER.length}%` }}
						>
							{props.records
								.filter((record) => record.lane === lane)
								.map((record) => {
									const end = record.endedAt ?? props.domainEnd;
									const selected = record.id === props.selectedId;
									return (
										<button
											key={record.id}
											type="button"
											title={`${kindLabel(record)} · ${record.summary}`}
											className={`pointer-events-auto absolute top-1/2 h-2 -translate-y-1/2 rounded-sm ${laneTone(lane)} ${selected ? "ring-1 ring-foreground" : ""}`}
											style={{
												left: `${projectLeft(record.startedAt, props.domainStart, span)}%`,
												width: `${projectWidth(record.startedAt, end, props.domainStart, span)}%`,
											}}
											onClick={(event) => {
												event.stopPropagation();
												props.onSelect(record.id);
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

function turnDurationLabel(
	turn: { inFlight: boolean; durationMs?: number; startedAt: number } | undefined,
	now: number,
): string | undefined {
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
}) {
	let lastTurn = -1;
	return (
		<div ref={props.scrollRef} className={`min-h-0 overflow-auto ${props.borderBottom ? "border-b border-border/60" : "border-r border-border/60"}`}>
			{props.records.length === 0 ? (
				<div className="px-3 py-6 text-center text-caption text-muted-foreground">
					{t("session.trajectory.empty")}
				</div>
			) : (
				<ul className="divide-y divide-border/50">
					{props.records.map((record) => {
						const showTurn = record.turnIndex !== lastTurn;
						lastTurn = record.turnIndex;
						const selected = record.id === props.selectedId;
						const turnLabel = showTurn
							? turnDurationLabel(props.turns[record.turnIndex], props.now)
							: undefined;
						return (
							<li key={record.id}>
								{showTurn ? (
									<div className="flex items-center justify-between bg-muted/40 px-3 py-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
										<span>{t("session.trajectory.turn", { index: record.turnIndex + 1 })}</span>
										{turnLabel ? <span className="tabular-nums">{turnLabel}</span> : null}
									</div>
								) : null}
								<button
									type="button"
									className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-caption hover:bg-muted/50 ${selected ? "bg-muted" : ""}`}
									onClick={() => props.onSelect(record.id)}
								>
									<span className={`mt-1 size-1.5 shrink-0 rounded-full ${laneTone(record.lane)}`} />
									<span className="w-20 shrink-0 font-medium text-foreground">{kindLabel(record)}</span>
									<span className="min-w-0 flex-1 truncate text-muted-foreground">{record.summary || "—"}</span>
									<span className="shrink-0 tabular-nums text-muted-foreground">
										{durationLabel(record)}
									</span>
								</button>
							</li>
						);
					})}
				</ul>
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
				{props.label ? (
					<span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
						{props.label}
					</span>
				) : <span />}
				<button
					type="button"
					className="inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
					onClick={() => { void onCopy(); }}
					title={t("common.copy")}
				>
					{copied ? <Check size={11} /> : <Copy size={11} />}
					{copied ? t("common.copied") : t("common.copy")}
				</button>
			</div>
			<pre className="max-h-72 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed wrap-break-word whitespace-pre-wrap">
				{props.text}
			</pre>
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
	if (!record) {
		return (
			<div className="min-h-0 overflow-auto px-3 py-4 text-caption text-muted-foreground">
				{t("session.trajectory.inspectHint")}
			</div>
		);
	}
	return (
		<div className="min-h-0 overflow-auto px-3 py-3">
			<div className="mb-2 flex items-center gap-1.5 text-sm font-medium">
				{record.kind === "tool" ? <Wrench size={14} /> : <Hash size={14} />}
				{record.kind === "tool" ? record.toolName : kindLabel(record)}
			</div>
			{record.kind === "systemPrompt" ? (
				<p className="mb-2 text-caption text-muted-foreground">
					{props.isDsh
						? t("session.trajectory.systemPromptHintDsh")
						: t("session.trajectory.systemPromptHint")}
				</p>
			) : null}
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
				{record.startedAt > 0 ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.time")}</dt>
						<dd className="tabular-nums">{formatTime(record.startedAt)} · {formatClock(record.startedAt)}</dd>
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
						<dd className="truncate font-mono text-[11px]">{record.toolCallId}</dd>
					</>
				) : null}
				{record.cwd ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.cwd")}</dt>
						<dd className="truncate font-mono text-[11px]">{record.cwd}</dd>
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
				{record.customType ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.customType")}</dt>
						<dd className="truncate font-mono text-[11px]">{record.customType}</dd>
					</>
				) : null}
				{record.retry !== undefined ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.retry")}</dt>
						<dd className="tabular-nums">
							{record.maxRetries !== undefined
								? `${record.retry}/${record.maxRetries}`
								: record.retry}
						</dd>
					</>
				) : null}
				{record.retryDelayMs !== undefined ? (
					<>
						<dt className="text-muted-foreground">{t("session.trajectory.field.retryDelay")}</dt>
						<dd className="tabular-nums">{formatDuration(record.retryDelayMs)}</dd>
					</>
				) : null}
			</dl>
			{record.inputDetail ? (
				<CopyableBlock label={t("session.trajectory.field.payload")} text={record.inputDetail} />
			) : null}
			{record.outputDetail ? (
				<CopyableBlock label={t("session.trajectory.field.result")} text={record.outputDetail} />
			) : null}
			{!record.inputDetail && !record.outputDetail && (record.detail || record.text) ? (
				<CopyableBlock text={record.detail || record.text || ""} />
			) : null}
			{state && (state.ttftMs !== undefined || state.inputTokens !== undefined) ? (
				<div className="mt-4 border-t border-border/60 pt-3">
					<div className="mb-1 flex items-center gap-1 text-caption font-medium">
						<Clock size={12} />
						{t("session.trajectory.runtime")}
					</div>
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption text-muted-foreground">
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
						{state.tps !== undefined ? (
							<>
								<dt>TPS</dt>
								<dd className="tabular-nums">{state.tps.toFixed(1)}</dd>
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
