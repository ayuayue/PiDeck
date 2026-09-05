import { useAtomValue } from "jotai";
import { useId, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, ListChecks, X } from "lucide-react";
import {
	sessionRuntimeBySessionIdAtomFamily,
	sessionRuntimeUiBySessionIdAtomFamily,
} from "../../atoms";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
	isCoherentComposerRuntimeUi,
	type RuntimeHandle,
} from "./ComposerRuntimeIntegrations";
import {
	ComposerWidgetFrame,
	useComposerWidgetCollapsed,
} from "./ComposerWidgetLayout";
import {
	parseAgentTodoItems,
	runtimeTodosToItems,
	sessionTodoSnapshotToItems,
	stripPiDeckTodoWidgetMetadata,
	type AgentTodoItem,
} from "./agentTodoParser";
import { useSessionTodoSnapshot } from "../../hooks/useSessionTodoSnapshot";

/**
 * composer 上方的 todo 常驻条（移植自 dsh-web 的 TodoPanel）。
 *
 * 形态：与输入框同宽同列的折叠卡（36px 高：图标 + 标题 + 进度文案 + chevron），
 * 点击展开列表（180px 内滚动）。数据三源归一化成同构行式：
 * - pi 扩展 widget（pi-deck-todo / pi-deck-plan-todos）的行快照；
 * - DSH 官方 todo（AgentRuntimeState.todos 的 TodoItem[]）；
 * - 历史会话的 todo 快照（session 文件 record 解析，无活 runtime 时兜底）。
 * 无任何 todo 行时整体不渲染（「有那个显示那个」，与 dsh 一致）。
 *
 * 尊重历史 dismiss 记录（同一 localStorage 指纹 v2）：手动关闭后内容指纹
 * 不变则保持隐藏，工具更新列表（指纹变化）后重新出现。
 */

// dismiss 语义从 v2 保留：key 按「内容指纹」记录（旧数据形状（数组）不兼容，
// 直接启用新 key，旧记录自然作废——dismiss 是轻量 UX 状态，不做迁移）。
const DISMISSED_WIDGETS_KEY = "pid:session-dismissed-widgets-v2";

/** 手动关闭记录：key = widgetDismissalId(sessionId, widgetKey)，value = 关闭时的内容指纹。 */
type DismissedWidgets = Record<string, string>;
type WidgetLines = { key: string; lines: readonly string[] };

/** 列表内容指纹（djb2）：只需稳定区分「工具是否更新过列表」，不需要密码学强度。 */
export function widgetLinesSignature(lines: readonly string[]): string {
	const text = lines.join("\n");
	let hash = 5381;
	for (let i = 0; i < text.length; i += 1) {
		hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
	}
	// 带上行数，降低「哈希相同但行数不同」的碰撞概率
	return `${lines.length}:${hash >>> 0}`;
}

export function widgetDismissalId(sessionId: string, widgetKey: string): string {
	return `${sessionId}:${widgetKey}`;
}

/**
 * 是否保持隐藏：已手动关闭且内容指纹未变 → 永久隐藏；
 * 工具再次调用使列表变化（指纹不同）→ 视为新内容，重新显示。
 */
export function isWidgetDismissed(
	dismissed: DismissedWidgets,
	sessionId: string,
	widgetKey: string,
	lines: readonly string[],
): boolean {
	return (
		dismissed[widgetDismissalId(sessionId, widgetKey)] ===
		widgetLinesSignature(lines)
	);
}

/** Record every visible source so a manual close is reversible on content changes. */
export function dismissWidgetEntries(
	dismissed: DismissedWidgets,
	sessionId: string,
	widgets: readonly WidgetLines[],
): DismissedWidgets {
	const next = { ...dismissed };
	for (const widget of widgets) {
		next[widgetDismissalId(sessionId, widget.key)] = widgetLinesSignature(widget.lines);
	}
	return next;
}

function saveDismissedWidgets(dismissed: DismissedWidgets): void {
	try {
		localStorage.setItem(DISMISSED_WIDGETS_KEY, JSON.stringify(dismissed));
	} catch {
		// Private browsing or quota failures should not prevent dismissing for this render.
	}
}

function loadDismissedWidgets(): DismissedWidgets {
	try {
		const parsed = JSON.parse(localStorage.getItem(DISMISSED_WIDGETS_KEY) ?? "{}");
		return parsed && typeof parsed === "object"
			? parsed as DismissedWidgets
			: {};
	} catch {
		return {};
	}
}

/** 状态字形：completed=实心勾圈（成功色）、in_progress=渐变环旋转（品牌色）、
 *  pending=虚线环（弱化色）。svg 逐字节对应 dsh TodoPanel（figma 14×14 画板）。 */
function CompletedGlyph() {
	return (
		<svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className="text-[var(--color-success)]">
			<circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
			<path
				d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
				fill="currentColor"
			/>
		</svg>
	);
}

/** 进行中：品牌色渐变环，CSS 动画整体旋转（渐变从实到透明，转起来有扫光感）。 */
function ProgressGlyph() {
	const gradientId = useId();
	return (
		<svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className="animate-pideck-spin text-[var(--color-accent)] [animation-duration:1s]">
			<defs>
				<linearGradient id={gradientId} x1="2.5" y1="12" x2="10.5" y2="3.5" gradientUnits="userSpaceOnUse">
					<stop stopColor="currentColor" />
					<stop offset="1" stopColor="currentColor" stopOpacity="0" />
				</linearGradient>
			</defs>
			<circle cx="7" cy="7" r="6.4" stroke={`url(#${gradientId})`} strokeWidth="1.2" />
		</svg>
	);
}

/** 待处理：虚线未开始环。 */
function PendingGlyph() {
	return (
		<svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className="text-text-tertiary">
			<circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
		</svg>
	);
}

function StatusGlyph({ status }: { status: AgentTodoItem["status"] }) {
	if (status === "completed") return <CompletedGlyph />;
	if (status === "in-progress") return <ProgressGlyph />;
	// cancelled 与 pending 同形（解析器不会产生 cancelled，兜底即可）
	return <PendingGlyph />;
}

/** 头部进度文案：「n 完成 · n 进行中 · n 待处理」，零计数段省略（非空列表至少一段）。
 *  导出供契约测试断言分段/省略/分隔符行为。 */
export function progressLabel(items: AgentTodoItem[]): string {
	const done = items.filter((item) => item.status === "completed").length;
	const active = items.filter((item) => item.status === "in-progress").length;
	const pending = items.length - done - active;
	// 段间用 en-space（U+2002）：HTML 会折叠连续 ASCII 空格，宽空格保留呼吸感
	return [
		done > 0 ? t("sessionTodo.done", { done }) : null,
		active > 0 ? t("sessionTodo.active", { active }) : null,
		pending > 0 ? t("sessionTodo.pending", { pending }) : null,
	].filter(Boolean).join("\u2002·\u2002");
}

/** TodoItem → 行式（☑/◐/☐ 前缀）：DSH 与历史快照都归一化成与 Pi widget 同构的文本行，
 *  复用同一套 dismiss/解析/字形链路。 */
function todoItemsToLines(items: readonly AgentTodoItem[]): string[] {
	return items.map((item) => {
		const mark = item.status === "completed" ? "☑" : item.status === "in-progress" ? "◐" : "☐";
		return `${mark} ${item.title}`;
	});
}

export function SessionTodoStrip(props: { sessionId: string }) {
	const runtime = useAtomValue(
		sessionRuntimeBySessionIdAtomFamily(props.sessionId),
	);
	const runtimeUi = useAtomValue(
		sessionRuntimeUiBySessionIdAtomFamily(props.sessionId),
	);
	// dismiss records are loaded once, then updated locally when the user closes this strip.
	const [dismissed, setDismissed] = useState(loadDismissedWidgets);
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(
		`todo:${props.sessionId}`,
		true,
	);

	const runtimeHandle: RuntimeHandle | undefined = runtime?.agentId
		? {
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration,
			}
		: undefined;
	const coherent = isCoherentComposerRuntimeUi(runtimeHandle, runtimeUi)
		? runtimeUi
		: undefined;
	const widgets = coherent?.widgets ?? {};

	// 会话级 todo 快照：仅历史会话（无 coherent runtime）拉取，避免活会话多余 IPC
	const todoSnapshot = useSessionTodoSnapshot(props.sessionId, !coherent);

	// 数据源归一化成统一行式，再整体走 dismiss 指纹与解析链路
	const linesByKey = useMemo<WidgetLines[]>(() => {
		// DSH 不产出 Pi widget，优先消费其运行时的结构化 todos；
		// Pi 活会话仍以 widget 为实时真源；历史会话用快照兜底。
		if (runtime?.backend === "dsh") {
			const todos = runtime.state?.todos;
			if (!Array.isArray(todos) || todos.length === 0) return [];
			return [{ key: "dsh-todos", lines: todoItemsToLines(runtimeTodosToItems(todos)) }];
		}
		if (!coherent) {
			const snapshot = sessionTodoSnapshotToItems(todoSnapshot);
			return snapshot.length > 0
				? [{ key: "snapshot", lines: todoItemsToLines(snapshot) }]
				: [];
		}
		const result: WidgetLines[] = [];
		for (const key of ["pi-deck-todo", "pi-deck-plan-todos"]) {
			const raw = widgets[key];
			if (raw?.length) result.push({ key, lines: raw });
		}
		return result;
	}, [coherent, runtime?.backend, runtime?.state?.todos, todoSnapshot, widgets]);

	// A source stays dismissed only while its raw lines stay identical. Keep raw metadata here
	// until after the decision so a new plan with matching tasks becomes visible again.
	const visibleWidgets = useMemo(
		() => linesByKey.filter(
			(w) => !isWidgetDismissed(dismissed, props.sessionId, w.key, w.lines),
		),
		[linesByKey, dismissed, props.sessionId],
	);

	const items = useMemo(() => {
		const lines: string[] = [];
		for (const widget of visibleWidgets) {
			lines.push(
				...(widget.key === "pi-deck-todo"
					? stripPiDeckTodoWidgetMetadata(widget.lines)
					: widget.lines),
			);
		}
		return parseAgentTodoItems(lines);
	}, [visibleWidgets]);

	const dismissVisibleWidgets = () => {
		const next = dismissWidgetEntries(dismissed, props.sessionId, visibleWidgets);
		saveDismissedWidgets(next);
		setDismissed(next);
	};

	if (items.length === 0) return null;

	return (
		<ComposerWidgetFrame
			data-testid="session-todo-strip"
			aria-label={t("sessionTodo.title")}
		>
			<div className="flex h-9 w-full items-center gap-2.5 px-3">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
					aria-expanded={!collapsed}
					onClick={toggleCollapsed}
				>
					<ListChecks size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
					<span className="shrink-0 text-[13px] font-medium leading-6 text-foreground">
						{t("sessionTodo.title")}
					</span>
					<span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-text-tertiary">
						{progressLabel(items)}
					</span>
					<span className="shrink-0 text-text-tertiary" aria-hidden="true">
						{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</span>
				</button>
				<Button
					variant="ghost"
					size="icon-xs"
					className="size-7 shrink-0 rounded-full text-text-tertiary hover:bg-muted/70 hover:text-foreground"
					aria-label={t("sessionTodo.dismiss")}
					title={t("sessionTodo.dismiss")}
					onClick={dismissVisibleWidgets}
				>
					<X size={14} aria-hidden="true" />
				</Button>
			</div>
			{!collapsed && (
				<ul className="mb-2 flex max-h-[180px] flex-col gap-2 overflow-y-auto overscroll-contain [contain:layout_paint] px-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100 motion-reduce:animate-none">
					{items.map((item) => (
						<li
							key={item.id}
							className="flex min-w-0 items-center gap-2.5 text-[13px] leading-5 text-text-secondary"
						>
							<span className="grid size-4 shrink-0 place-items-center" aria-hidden="true">
								<StatusGlyph status={item.status} />
							</span>
							<span className="min-w-0 truncate">{item.title}</span>
						</li>
					))}
				</ul>
			)}
		</ComposerWidgetFrame>
	);
}
