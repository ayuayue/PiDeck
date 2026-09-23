import { useEffect, useRef, type ReactNode } from "react";
import type { PanelImperativeHandle } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui-shadcn/resizable";
import type { WorkspaceContentOpenMode } from "../../../../shared/types";
import { BridgeGuiSlot, useBridgeChromeSessionId } from "../bridge/BridgeSlot";

export type WorkbenchStageProps = {
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
	const contentFrameRef = useRef<HTMLDivElement>(null);
	// GUI 扩展桥：工作台是应用级单实例 chrome，按「当前聚焦会话」取桥状态。
	const bridgeChromeSessionId = useBridgeChromeSessionId();

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
		if (!props.hasContent) return;
		const panel = sessionPanelRef.current;
		if (!panel) return;
		try {
			if (props.layout === "maximize") panel.collapse();
			else panel.expand();
		} catch {
			// 面板尚未注册到 Group 时 resize API 可能抛错，下一帧布局会自愈
		}
	}, [props.hasContent, props.layout]);

	const body =
		!props.hasContent || !props.content ? (
			props.session
		) : (
			<ResizablePanelGroup orientation="horizontal" className="workbench-stage-split">
				{/* 尺寸统一用字符串百分比（"48%"）而非数字：react-resizable-panels v4 的
				   约束派生把数字按 px 解析（minSize={20} → 20px → 占 2%），而初始化布局
				   把数字当 %（defaultSize={48} → 48%），同值两处解析不一致；
				   maximize↔split 切换后 expand() 恢复宽度依赖该约束，数字会缩成一条窄缝。
				   defaultSize 固定不变（挂载时生效一次），避免 Panel 重注册丢失 expandToSize
				   （折叠前宽度），后续展开/收起全由下方 effect 的 collapse()/expand() 驱动。 */}
				<ResizablePanel id="workbench-session" panelRef={sessionPanelRef} collapsible collapsedSize="0%" minSize="20%" defaultSize="48%" className="workbench-session-pane">
					{props.session}
				</ResizablePanel>
				<ResizableHandle withHandle className="workbench-stage-sash" />
				<ResizablePanel id="workbench-content" minSize="25%" defaultSize="52%" className="workbench-content-pane">
					<div ref={contentFrameRef} className="workbench-content-frame">
						{props.content}
						{/* GUI 扩展桥：主内容区落点（ctx.gui.setContentView）。
						    **追加**在工作区内容之后 —— 不改内容区既有布局（§7.4 只追加）。
						    WorkbenchStage 无 sessionId prop，按「当前聚焦会话」取（应用级单实例 chrome）。
						    无贡献时返回 null，不占位。 */}
						<BridgeGuiSlot sessionId={bridgeChromeSessionId} slot="content.view" className="flex min-h-0 flex-col gap-2 overflow-auto p-2" />
					</div>
				</ResizablePanel>
			</ResizablePanelGroup>
		);

	return (
		<div className={!props.hasContent || !props.content ? "workbench-stage workbench-stage-solo" : "workbench-stage workbench-stage-with-content"}>
			{props.chrome}
			<div className="workbench-stage-body">{body}</div>
		</div>
	);
}
