import { useEffect, useRef, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui-shadcn/resizable";
import type { WorkspaceContentOpenMode } from "../../../../shared/types";

export type WorkbenchStageProps = {
	simple?: boolean;
	contentChrome?: ReactNode;
	/** 无内容时只渲染 session；有内容时按 layout 分屏或占满中间栏 */
	layout: WorkspaceContentOpenMode;
	hasContent: boolean;
	/**
	 * 顶栏 chrome（SessionTabsBar）。必须挂在分屏之上，才能与文件 Tab
	 * 共用一条栏，且 maximize 收起会话面板时 Tab 仍可见。
	 */
	chrome?: ReactNode;
	session: ReactNode;
	content: ReactNode | null;
	/** 内容区宽度上报（split 分屏时右缘刻度轴需贴消息区右缘，而非窗口右缘） */
	onContentWidthChange?: (width: number) => void;
};

/**
 * 中间栏工作台：会话与文件/Diff 内容宿主。
 *
 * - 顶栏 chrome（会话 + 文件 Tab）始终在分屏外
 * - 无内容：会话独占（与改版前一致）
 * - split：可拖拽分屏（固定左右，不做上下分屏）
 * - maximize：内容占满中间栏；会话面板 collapse(0) 但保持挂载，避免丢滚动/流式状态
 *
 * 浏览器仍在右侧抽屉，不进入本宿主。
 */
export function WorkbenchStage(props: WorkbenchStageProps) {
	const sessionPanelRef = useRef<PanelImperativeHandle>(null);
	const contentPanelRef = useRef<PanelImperativeHandle>(null);
	const contentFrameRef = useRef<HTMLDivElement>(null);

	// 内容区宽度上报：右缘刻度轴（.outline-hover）默认贴窗口右缘，工作台分屏时
	// 需右移内容区宽度才能落在消息区右缘。maximize 会话区收起，按 0 偏移回窗口右缘。
	useEffect(() => {
		const element = contentFrameRef.current;
		if (!element) return;
		const update = () => {
			props.onContentWidthChange?.(props.hasContent && props.layout !== "maximize" ? Math.round(element.getBoundingClientRect().width) : 0);
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => {
			observer.disconnect();
			// 卸载时归零，避免残留旧内容区宽度
			props.onContentWidthChange?.(0);
		};
	}, [props.onContentWidthChange, props.hasContent, props.layout]);

	useEffect(() => {
		const panel = sessionPanelRef.current;
		const contentPanel = contentPanelRef.current;
		if (!panel || !contentPanel) return;
		if (!props.hasContent) {
			contentPanel.collapse();
			panel.expand();
		} else {
			contentPanel.expand();
			if (props.layout === "maximize") panel.collapse();
			else panel.expand();
		}
	}, [props.hasContent, props.layout]);

	// Keep both panel identities stable across mode changes and opening a file:
	// remounting the session/editor would discard scroll position and undo state.
	return (
		<div className={`workbench-stage ${props.hasContent ? "workbench-stage-with-content" : "workbench-stage-solo"}${props.simple ? " simple-workbench" : ""}`}>
			{!props.simple && props.chrome}
			<div className="workbench-stage-body">
				<ResizablePanelGroup orientation="horizontal" className="workbench-stage-split">
					<ResizablePanel id="workbench-session" panelRef={sessionPanelRef} collapsible collapsedSize="0%" minSize="20%" defaultSize="48%" className="workbench-session-pane">
						<div className="flex h-full min-h-0 flex-col">
							{props.simple && props.chrome}
							<div className="flex min-h-0 flex-1 flex-col">{props.session}</div>
						</div>
					</ResizablePanel>
					<ResizableHandle withHandle className="workbench-stage-sash" disabled={!props.hasContent || props.layout === "maximize"} style={!props.hasContent ? { display: "none" } : undefined} />
					<ResizablePanel id="workbench-content" panelRef={contentPanelRef} collapsible collapsedSize="0%" minSize="25%" defaultSize="52%" className="workbench-content-pane">
						<div ref={contentFrameRef} className="workbench-content-frame">
							{props.simple && props.hasContent && props.contentChrome}
							{props.content}
						</div>
					</ResizablePanel>
				</ResizablePanelGroup>
			</div>
		</div>
	);
}
