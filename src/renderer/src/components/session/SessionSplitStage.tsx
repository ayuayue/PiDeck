import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui-shadcn/resizable";
import { t } from "../../i18n";
import { useNotifyLayoutResized } from "../../hooks/useNotifyLayoutResized";
import { SESSION_TAB_DRAG_MIME, canAcceptSplitDrop, resolveSessionSplitEdge, type SessionSplitDropTarget, type SessionSplitEdge, type SessionSplitLayout, type SessionSplitPane } from "../../utils/sessionSplitEdge";

export type SessionSplitStageProps = {
	/** 当前分屏布局；null 表示单栏 */
	layout: SessionSplitLayout | null;
	/** 正在拖拽的会话 Tab id；无拖拽时不显示落点预览 */
	draggingSessionId: string | null;
	/**
	 * 落点回调：target 为「会话面板内边缘」或「会话面板中心」。
	 * 分屏策略（插入/切分/替换）由 chrome 决定，本组件只负责几何与呈现。
	 */
	onDropSplit: (draggedSessionId: string, target: SessionSplitDropTarget) => void;
	/** 单栏内容；分屏时忽略 */
	solo: ReactNode;
	/** 单栏时的当前会话 id：供 solo 容器标记落点（单栏拖拽 → 根层双栏） */
	soloSessionId: string | undefined;
	/** Tab 栏会话总数：单栏拖当前会话自己时，判断是否有其它宿主可组双栏 */
	tabCount: number;
	/** 渲染单个会话栏（focused / onFocusPane 由调用方组合） */
	renderSession: (sessionId: string) => ReactNode;
};

function isSessionTabDrag(event: React.DragEvent, draggingSessionId: string | null): boolean {
	if (draggingSessionId) return true;
	// dragover 阶段自定义 MIME 可读 types（getData 在部分浏览器为空）
	return event.dataTransfer.types.includes(SESSION_TAB_DRAG_MIME);
}

type HoverState = {
	/** 预览定位键：kind + sessionId（+ edge），用于避免 dragover 高频重复渲染 */
	key: string;
	kind: "edge" | "center";
	sessionId: string;
	edge: SessionSplitEdge | null;
	/** 面板相对根容器的位置（预览坐标） */
	rect: { left: number; top: number; width: number; height: number };
};

/** 预览块定位：边缘落点显示半面板高亮条，中心落点显示整面板内框。 */
function previewStyle(hover: HoverState): React.CSSProperties {
	const r = hover.rect;
	if (hover.kind === "center") {
		return { left: r.left + 8, top: r.top + 8, width: r.width - 16, height: r.height - 16 };
	}
	switch (hover.edge) {
		case "left":
			return { left: r.left, top: r.top + 8, width: r.width * 0.5, height: r.height - 16 };
		case "right":
			return { left: r.left + r.width * 0.5, top: r.top + 8, width: r.width * 0.5, height: r.height - 16 };
		case "top":
			return { left: r.left + 8, top: r.top, width: r.width - 16, height: r.height * 0.5 };
		case "bottom":
			return { left: r.left + 8, top: r.top + r.height * 0.5, width: r.width - 16, height: r.height * 0.5 };
		default:
			return {};
	}
}

/**
 * 会话区分屏舞台：两层树布局的递归渲染 + 落点预览。
 *
 * 落点模型：边缘落点（同向=根层插入真三栏 / 垂直=终端式切分面板）、中心落点=替换。
 * 预览门控与 drop 接受条件统一走 canAcceptSplitDrop（纯函数），保证「有预览必有结果」。
 * 命中定位：data-split-session-id 标记 + closest 查询最深会话面板，不依赖事件冒泡顺序。
 */
export function SessionSplitStage(props: SessionSplitStageProps) {
	const { layout, draggingSessionId, onDropSplit, solo, soloSessionId, tabCount, renderSession } = props;
	const rootRef = useRef<HTMLDivElement | null>(null);
	const notifyLayoutResized = useNotifyLayoutResized();
	const [hover, setHover] = useState<HoverState | null>(null);

	// layout 变化时旧落点失效（如焦点替换改了结构），清空预览
	const layoutRef = useRef(layout);
	layoutRef.current = layout;
	useEffect(() => {
		setHover(null);
	}, [layout]);

	// Tab/侧栏的 dragend 发生在舞台外；chrome 清 draggingSessionId 时必须同步清预览，
	// 否则取消拖拽后落点遮罩可能残留。
	useEffect(() => {
		if (!draggingSessionId) setHover(null);
	}, [draggingSessionId]);

	const handleDragOverCapture = useCallback(
		(event: React.DragEvent) => {
			if (!isSessionTabDrag(event, draggingSessionId)) return;
			const root = rootRef.current;
			if (!root) return;
			const el = event.target instanceof Element ? event.target : null;
			const hit = el?.closest?.("[data-split-session-id]");
			if (!hit || !root.contains(hit)) {
				// 分隔条 / 空白区域：无落点（分隔条留给调宽度）
				setHover(null);
				return;
			}
			// capture 阶段阻断冒泡，避免 composer 的 drop/dragOver 抢走会话 Tab 拖拽
			event.stopPropagation();

			const sessionId = hit.getAttribute("data-split-session-id") ?? "";
			if (!sessionId) return;
			const hitRect = hit.getBoundingClientRect();
			const rootRect = root.getBoundingClientRect();
			const rect = {
				left: hitRect.left - rootRect.left,
				top: hitRect.top - rootRect.top,
				width: hitRect.width,
				height: hitRect.height,
			};
			const edge = resolveSessionSplitEdge(event.clientX, event.clientY, hitRect);
			// 预览门控 = drop 接受条件：不可接受时不 preventDefault（浏览器显示 no-drop 光标），
			// 避免「预览承诺、落空收场」
			if (
				!draggingSessionId ||
				!canAcceptSplitDrop({
					layout: layoutRef.current,
					draggedSessionId: draggingSessionId,
					sessionId,
					edge,
					tabCount,
				})
			) {
				setHover(null);
				return;
			}
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";

			const next: HoverState = edge
				? {
						key: `edge:${sessionId}:${edge}`,
						kind: "edge",
						sessionId,
						edge,
						rect,
					}
				: {
						key: `center:${sessionId}`,
						kind: "center",
						sessionId,
						edge: null,
						rect,
					};
			// key 或面板位置变化才更新（dragover 高频触发；同 key 返回同引用避免重渲染）
			setHover((current) => (current && current.key === next.key && current.rect.left === next.rect.left && current.rect.top === next.rect.top && current.rect.width === next.rect.width && current.rect.height === next.rect.height ? current : next));
		},
		[draggingSessionId, tabCount],
	);

	const handleDropCapture = useCallback(
		(event: React.DragEvent) => {
			if (!isSessionTabDrag(event, draggingSessionId)) return;
			event.preventDefault();
			event.stopPropagation();
			const dragged = event.dataTransfer.getData(SESSION_TAB_DRAG_MIME) || draggingSessionId || "";
			const root = rootRef.current;
			// drop 时按最新指针位置重新计算落点，避免 hover 预览与落点不一致
			let target: SessionSplitDropTarget | null = null;
			const el = event.target instanceof Element ? event.target : null;
			const hit = el?.closest?.("[data-split-session-id]");
			if (root && hit && root.contains(hit) && dragged) {
				const sessionId = hit.getAttribute("data-split-session-id") ?? "";
				if (sessionId) {
					const hitRect = hit.getBoundingClientRect();
					const edge = resolveSessionSplitEdge(event.clientX, event.clientY, hitRect);
					// 与预览同一门控：不可接受的落点（拖自己/已在布局/封顶）静默丢弃
					if (
						canAcceptSplitDrop({
							layout: layoutRef.current,
							draggedSessionId: dragged,
							sessionId,
							edge,
							tabCount,
						})
					) {
						target = edge ? { kind: "session-edge", sessionId, edge } : { kind: "session-center", sessionId };
					}
				}
			}
			setHover(null);
			if (!dragged || !target) return;
			onDropSplit(dragged, target);
		},
		[draggingSessionId, onDropSplit, tabCount],
	);

	/** 渲染单个会话面板容器：标记落点 id + 填满面板空间 */
	const renderSessionPane = (sessionId: string) => (
		<div data-split-session-id={sessionId} className="h-full min-h-0 min-w-0 overflow-hidden chat-content-width @container">
			{renderSession(sessionId)}
		</div>
	);

	/** 递归渲染布局面板：会话直接渲染；嵌套渲染内部 Group（第二层，固定双会话） */
	const renderPane = (pane: SessionSplitPane, key: string): ReactNode => {
		if (pane.kind === "session") {
			return (
				<ResizablePanel key={key} id={key} minSize="24%" defaultSize="50%" className="session-split-panel min-h-0 min-w-0">
					{renderSessionPane(pane.sessionId)}
				</ResizablePanel>
			);
		}
		return (
			<ResizablePanel key={key} id={key} minSize="24%" defaultSize="50%" className="session-split-panel min-h-0 min-w-0">
				<ResizablePanelGroup orientation={pane.orientation} className="session-split-group h-full min-h-0">
					<ResizablePanel id={`${key}-first`} minSize="24%" defaultSize="50%" className="session-split-panel min-h-0 min-w-0">
						{renderSessionPane(pane.first)}
					</ResizablePanel>
					<ResizableHandle withHandle className="session-split-sash" />
					<ResizablePanel id={`${key}-second`} minSize="24%" defaultSize="50%" className="session-split-panel min-h-0 min-w-0">
						{renderSessionPane(pane.second)}
					</ResizablePanel>
				</ResizablePanelGroup>
			</ResizablePanel>
		);
	};

	const showPreview = Boolean(draggingSessionId && hover);

	return (
		<div
			ref={rootRef}
			className="session-split-stage relative flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden"
			onDragOverCapture={handleDragOverCapture}
			onDropCapture={handleDropCapture}
			onDragLeave={(event) => {
				if (!rootRef.current?.contains(event.relatedTarget as Node)) setHover(null);
			}}
		>
			{layout ? (
				<ResizablePanelGroup orientation={layout.orientation} className="session-split-group h-full min-h-0 flex-1">
					{layout.panels.map((pane, index) => (
						<Fragment key={`pane-${index}`}>
							{index > 0 && <ResizableHandle key={`sash-${index}`} withHandle className="session-split-sash" />}
							{renderPane(pane, `session-split-pane-${index}`)}
						</Fragment>
					))}
				</ResizablePanelGroup>
			) : (
				<div data-split-session-id={soloSessionId} className="session-split-solo chat-content-width @container flex h-full min-h-0 flex-1 flex-col overflow-hidden">
					{solo}
				</div>
			)}

			{showPreview && hover ? (
				<div className="session-split-drop-preview" style={previewStyle(hover)} aria-hidden="true">
					<span className="session-split-drop-label">{t(hover.kind === "edge" && hover.edge ? `session.split.preview.${hover.edge}` : "session.split.preview.center")}</span>
				</div>
			) : null}
		</div>
	);
}
