import { useAtomValue } from "jotai";
import { useState } from "react";
import { ClipboardList, ListChecks, X } from "lucide-react";
import {
	sessionRuntimeBySessionIdAtomFamily,
	sessionRuntimeUiBySessionIdAtomFamily,
} from "../../atoms";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "../ui-shadcn/popover";
import {
	isCoherentComposerRuntimeUi,
	type RuntimeHandle,
} from "./ComposerRuntimeIntegrations";
import { renderWidgetLine, widgetDisplayTitle } from "./ComposerComponents";

/**
 * 会话头部左侧的扩展 widget 入口（Todo / Plan 进度）。
 *
 * 设计取舍：
 * - 曾经渲染在输入框上方/内部，会与 Ask 卡片争抢 composer 空间且超高裁剪难处理；
 *   会话标题迁走后 chat-header 左侧正好空出，widget 改为「chip + Popover」形态落在那里，
 *   常驻只显示进度摘要（TODO 2/4），点击弹出完整列表，不再挤占正文与输入区。
 * - chip 只展示当前 runtime 代数一致（coherent）的 widget；跨代快照一律忽略，
 *   避免重启后看到上一代的死数据（与 isCoherentComposerRuntimeUi 的语义一致）。
 * - 关闭（X）是永久的：按 session+widgetKey 记录关闭那一刻的内容指纹，重启 Agent、
 *   切换分支都不会复活；只有当 todo/plan 工具再次被调用、列表内容发生变化
 *   （指纹不同）时才自动重新显示——「工具自己追加/复现回来」。
 */

// v2 key：dismiss 语义从「按 runtime 代数」改为「按内容指纹」，旧数据形状（数组）不兼容，
// 直接启用新 key，旧记录自然作废（dismiss 是轻量 UX 状态，不做迁移）。
const DISMISSED_WIDGETS_KEY = "pid:session-dismissed-widgets-v2";

/** 手动关闭记录：key = widgetDismissalId(sessionId, widgetKey)，value = 关闭时的内容指纹。 */
type DismissedWidgets = Record<string, string>;

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

function persistDismissedWidgets(value: DismissedWidgets) {
	try {
		localStorage.setItem(DISMISSED_WIDGETS_KEY, JSON.stringify(value));
	} catch {
		// Storage is optional in preview/test runtimes.
	}
}

/** 从 widget 行解析完成进度：todo/plan 扩展用 ☑/☐ 标记完成态，计数即可。 */
export function widgetProgress(lines: string[]): { done: number; total: number } {
	let done = 0;
	let pending = 0;
	for (const line of lines) {
		if (line.includes("☑")) done += 1;
		else if (line.includes("☐")) pending += 1;
	}
	return { done, total: done + pending };
}

export function SessionWidgetChips(props: { sessionId: string }) {
	const runtime = useAtomValue(
		sessionRuntimeBySessionIdAtomFamily(props.sessionId),
	);
	const runtimeUi = useAtomValue(
		sessionRuntimeUiBySessionIdAtomFamily(props.sessionId),
	);
	const [dismissed, setDismissed] = useState(loadDismissedWidgets);

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
	const entries = Object.entries(widgets).filter(
		([widgetKey, lines]) =>
			!isWidgetDismissed(dismissed, props.sessionId, widgetKey, lines),
	);

	// 关闭时记录当前内容指纹：之后只要列表不变（含重启后扩展重建同一快照）就保持隐藏
	function dismissWidget(widgetKey: string, lines: string[]) {
		const id = widgetDismissalId(props.sessionId, widgetKey);
		setDismissed((current) => {
			const next = { ...current, [id]: widgetLinesSignature(lines) };
			persistDismissedWidgets(next);
			return next;
		});
	}

	if (entries.length === 0) return null;

	// mr-auto：chat-header-actions 是 justify-end，chips 借此固定在行左端，
	// 状态/操作按钮仍靠右，互不挤压。
	return (
		<div className="session-widget-chips mr-auto flex min-w-0 items-center gap-1.5">
			{entries.map(([widgetKey, lines]) => (
				<WidgetChip
					key={`${props.sessionId}:${runtimeHandle?.runtimeGeneration}:${widgetKey}`}
					widgetKey={widgetKey}
					lines={lines}
					onDismiss={() => dismissWidget(widgetKey, lines)}
				/>
			))}
		</div>
	);
}

/** 单个 widget chip：常驻摘要（图标 + 标题 + 完成进度），点击 Popover 查看完整列表。 */
function WidgetChip(props: {
	widgetKey: string;
	lines: string[];
	onDismiss: () => void;
}) {
	const title = widgetDisplayTitle(props.widgetKey);
	const { done, total } = widgetProgress(props.lines);
	// 无 ☑/☐ 行（如 todo 折叠态只回 "2/4" 一行）时，chip 摘要退化为首行文本
	const summary = total > 0 ? `${done}/${total}` : (props.lines[0] ?? "");
	const Icon =
		props.widgetKey === "pi-deck-plan-todos" ? ClipboardList : ListChecks;
	// 全部完成时用成功色描边提示，一眼可辨无需再点开
	const allDone = total > 0 && done === total;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					type="button"
					variant="outline"
					size="sm"
					className={`h-7 max-w-44 gap-1.5 rounded-md px-2 text-caption${allDone ? " border-[color-mix(in_srgb,var(--color-success)_50%,transparent)] text-[var(--color-success)]" : ""}`}
					title={title}
				>
					<Icon size={13} strokeWidth={2} aria-hidden="true" />
					<span className="shrink-0 font-semibold">{title}</span>
					{summary && (
						<span className="min-w-0 truncate tabular-nums text-muted-foreground">
							{summary}
						</span>
					)}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="start" side="bottom" className="w-72 p-0">
				<div className="flex items-center justify-between border-b border-border/50 px-2.5 py-1.5">
					<span className="text-caption font-semibold text-foreground">{title}</span>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="size-5 text-muted-foreground hover:text-foreground"
						onClick={props.onDismiss}
						title={t("common.close")}
						aria-label={t("common.close")}
					>
						<X size={12} strokeWidth={2.2} aria-hidden="true" />
					</Button>
				</div>
				{/* 复用 extension-widget-card-line 排版；用任意属性补上它依赖的行高 CSS 变量，
				    使该 class 脱离原卡片容器也能保持一致的行高。 */}
				<div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto overscroll-contain px-2.5 py-1.5 [--extension-widget-line-height:20px]">
					{props.lines.map((line, index) => (
						<div key={index} className="extension-widget-card-line">
							{renderWidgetLine(line)}
						</div>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
