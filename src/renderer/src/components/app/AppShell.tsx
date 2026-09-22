import { useEffect, useRef, useState, type ReactNode, type CSSProperties } from "react";
import { type Layout, type LayoutChangedMeta, type PanelImperativeHandle } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui-shadcn/resizable";
import { AppHeader } from "../AppHeader";
import { WorkspaceDrawerHost } from "../workspace/WorkspaceDrawerHost";
import { useNotifyLayoutResized } from "../../hooks/useNotifyLayoutResized";
import { LIST_WIDTH_MIN, LIST_WIDTH_MAX } from "../../hooks/useResize";
import { DRAWER_WIDTH_MIN, DRAWER_WIDTH_MIN_PINNED, DRAWER_WIDTH_MAX, type WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";
import { cn } from "../../lib/utils";
import { shouldCommitPanelPixels } from "../../lib/shellPanelLayout";

/**
 * 工作台外壳（#115 U5 布局换装）：三栏水平布局由 react-resizable-panels 接管。
 *
 * 状态归属约定：
 * - App 侧的 px 状态（listWidth/drawerWidth/listCollapsed/drawerCollapsed）是保存的
 *   布局偏好和面板控制值；实际受约束宽度只同步到 CSS 定位变量，不污染持久化状态。
 * - 侧栏/抽屉使用 preserve-pixel-size：窗口或页面缩放只改变聊天区可用空间，
 *   不会把布局换算后的临时像素宽度误当成用户偏好写入缓存。
 * - 面板库负责拖拽交互；拖拽**过程中不回写 React 状态**（每个 pointermove 都
 *   setState 会让整个工作台每帧重渲染，且 defaultSize 随动会触发库重布局，
 *   两者叠加就是肉眼可见的抖动）；拖拽释放/键盘调整完成时经 Group 的
 *   onLayoutChanged 统一提交一次。外部状态变化（标题栏折叠按钮、恢复默认宽度）
 *   经 imperative resize/collapse/expand 同步回面板。
 * - 宽度变化超过 1px 才回写/同步，避免 state → resize → layout 的反馈回路。
 *
 * 折叠语义对齐旧实现：
 * - 侧栏 collapsedSize=14（旧版收起后保留 14px 边缘提示条，恢复走标题栏按钮）；
 *   拖拽低于 minSize 自动折叠。
 * - 抽屉 collapsedSize=0；未钉住时可拖拽折叠，钉住（pinned）时禁止折叠且最小 220px。
 *
 * 已知变化：抽屉/侧栏开合不再有 120ms grid 过渡动画（面板布局为即时宽度），
 * 由下方 drawer-content-enter / list-content-enter 内容动画替代：
 * 面板宽度即时变化（避免 width 动画掉帧），内容层补一次 transform+opacity
 * 进入动画制造“滑出/淡入”感；CSS animation 播完自动恢复默认样式，不留
 * transform（Windows 静止态 transform 会降级 ClearType）。关闭保持即时。
 */

export interface AppShellProps {
	/** Compact mode reuses this window's session store and preserves workbench layout preferences. */
	compactContent?: ReactNode;
	listCollapsed: boolean;
	listWidth: number;
	drawer: WorkspaceDrawerPanel | null;
	drawerCollapsed: boolean;
	drawerWidth: number;
	drawerPinned: boolean;
	useNativeTitleBar: boolean;
	/** 当前运行平台；mac 自定义标题栏要避开系统红绿灯，不能再画一套 Win 按钮。 */
	platform: NodeJS.Platform;

	chatPaneRef: React.RefObject<HTMLElement | null>;
	terminalRowHeight: number;
	/** 聊天内容区占面板百分比（60–100），注入 --chat-content-pct-set，由 CSS 容器查询自适应分屏 */
	chatContentWidthPct: number;
	/** 工作台内容区宽度（文件/Diff 分屏时 >0）：右缘刻度轴需右移该宽度贴到消息区右缘 */
	outlineContentOffset: number;

	sidebarContent: ReactNode;
	chatPaneContent: ReactNode;
	drawerContent: (panel: WorkspaceDrawerPanel) => ReactNode;
	/** 抽屉活动栏（files/git/browser 切换），由 App 注入；抽屉打开时常驻。 */
	drawerRail?: ReactNode;
	outlineContent?: ReactNode;

	setListCollapsed: (v: boolean) => void;
	setListWidth: (v: number) => void;
	setDrawerCollapsed: (v: boolean) => void;
	setDrawerWidth: (v: number) => void;
	onToggleListCollapsed: () => void;
	onDrawerCollapse: () => void;
	onDrawerClose: () => void;
	onDrawerRestore: () => void;
	onToggleDrawerPin: () => void;

	toggleAlwaysOnTop: () => Promise<boolean>;
	isWindowAlwaysOnTop: () => Promise<boolean>;
	minimizeWindow: () => void;
	toggleMaximizeWindow: () => Promise<boolean>;
	isWindowMaximized: () => Promise<boolean>;
	onWindowMaximizedChange: (callback: (maximized: boolean) => void) => () => void;
	closeWindow: () => void;

	children?: ReactNode;
}

/** 侧栏收起后保留的边缘提示条宽度（对齐旧 grid 实现） */
const LIST_COLLAPSED_SIZE = 0;

/** 将面板库的实际布局宽度同步给只读 CSS 变量，不触发 React 状态/持久化回写。 */
function writeListLayoutVariables(shell: HTMLElement, width: number, visible: boolean) {
	shell.style.setProperty("--list-width", `${visible ? width : 0}px`);
	shell.style.setProperty("--list-expanded-width", `${width}px`);
	shell.style.setProperty("--list-hover-width", `${Math.max(190, width)}px`);
}

/** 将抽屉的实际布局宽度同步给悬浮入口定位变量。 */
function writeDrawerLayoutVariables(shell: HTMLElement, width: number, visible: boolean) {
	const renderedWidth = visible ? width : 0;
	shell.style.setProperty("--drawer-width", `${renderedWidth}px`);
	shell.style.setProperty("--drawer-col-w", `${renderedWidth}px`);
	shell.style.setProperty("--drawer-splitter-w", `${visible ? 6 : 0}px`);
}

/**
 * 读取与外壳 CSS 坐标一致的面板宽度。PanelImperativeHandle 的 inPixels 基于
 * 外层 offsetWidth，在 Electron 页面缩放时会按 zoom 比例放大；内层可视容器的
 * bounding rect 才是 --drawer-* / --list-* 所使用的 CSS 坐标。
 */
function readPanelLayoutWidth(element: HTMLDivElement | null, panel: PanelImperativeHandle): number {
	return Math.round(element?.getBoundingClientRect().width ?? panel.getSize().inPixels);
}

// 侧栏宽度上下限由 useResize 统一导出（LIST_WIDTH_MIN/MAX），
// 与 localStorage 持久化读取时的 clamp 范围同源，避免两处漂移。

export function AppShell(props: AppShellProps) {
	const {
		listCollapsed,
		listWidth,
		drawer,
		drawerCollapsed,
		drawerWidth,
		drawerPinned,
		useNativeTitleBar,
		platform,
		chatPaneRef,
		terminalRowHeight,
		chatContentWidthPct,
		outlineContentOffset,
		sidebarContent,
		chatPaneContent,
		drawerContent,
		drawerRail,
		outlineContent,
		setListCollapsed,
		setListWidth,
		setDrawerCollapsed,
		setDrawerWidth,
		onToggleListCollapsed,
		onDrawerCollapse,
		onDrawerClose,
		onDrawerRestore,
		onToggleDrawerPin,
		toggleAlwaysOnTop,
		isWindowAlwaysOnTop,
		minimizeWindow,
		toggleMaximizeWindow,
		isWindowMaximized,
		onWindowMaximizedChange,
		closeWindow,
		children,
	} = props;

	const shellRef = useRef<HTMLDivElement | null>(null);
	const listPanelRef = useRef<PanelImperativeHandle | null>(null);
	const drawerPanelRef = useRef<PanelImperativeHandle | null>(null);
	const listPanelElementRef = useRef<HTMLDivElement | null>(null);
	const drawerPanelElementRef = useRef<HTMLDivElement | null>(null);
	// 这两个 ref 表示当前实际布局宽度，只用于 CSS 定位；不进入持久化状态。
	const listLayoutWidthRef = useRef(listWidth);
	const drawerLayoutWidthRef = useRef(drawerWidth);
	// 开合 effect 不把 width 放进依赖（否则每次回写都会再 expand/resize 一轮）。
	// 打开折叠面板时用 ref 读最新保存宽度，避免 expand() 落到 minSize。
	const listWidthRef = useRef(listWidth);
	const drawerWidthRef = useRef(drawerWidth);
	listWidthRef.current = listWidth;
	drawerWidthRef.current = drawerWidth;
	const notifyLayoutResized = useNotifyLayoutResized();

	// 抽屉/侧栏“刚打开”标志：closed→open 时给内容容器挂一次进入动画类；
	// 动画结束（onAnimationEnd）移除。面板库 collapse/expand 是即时宽度，
	// 内容动画只动 transform/opacity，且播完无残留。
	const [drawerEntering, setDrawerEntering] = useState(false);
	const [listEntering, setListEntering] = useState(false);
	const prevDrawerOpenRef = useRef(false);
	const prevListOpenRef = useRef(false);
	useEffect(() => {
		const open = Boolean(drawer) && !drawerCollapsed;
		if (open && !prevDrawerOpenRef.current) setDrawerEntering(true);
		prevDrawerOpenRef.current = open;
	}, [drawer, drawerCollapsed]);
	useEffect(() => {
		const open = !listCollapsed;
		if (open && !prevListOpenRef.current) setListEntering(true);
		prevListOpenRef.current = open;
	}, [listCollapsed]);

	// ── 折叠状态 → 面板（标题栏按钮、抽屉头部按钮等外部来源） ──
	useEffect(() => {
		const panel = listPanelRef.current;
		if (!panel) return;
		if (listCollapsed) {
			if (!panel.isCollapsed()) panel.collapse();
		}
		// expand() 无上次展开宽度时落到 minSize(100)；全屏/还原时会被当成新宽度。
		else if (panel.isCollapsed()) panel.resize(listWidthRef.current);
	}, [listCollapsed]);

	// 抽屉 Panel 常驻挂载（drawer=null 时折叠 0 宽），此 effect 统一同步折叠态；
	// 推迟一帧 + 容错：常驻挂载后约束始终就绪，保留 try/catch 仅为防御。
	useEffect(() => {
		const panel = drawerPanelRef.current;
		if (!panel) return;
		const frame = requestAnimationFrame(() => {
			try {
				// drawer 为空时必须折叠（常驻挂载下避免空面板意外展开）
				if (!drawer || drawerCollapsed) {
					if (!panel.isCollapsed()) panel.collapse();
				} else if (panel.isCollapsed()) {
					// expand() 无历史会落到 minSize(180)。清缓存后保存宽度是默认 320，
					// 写成 180 再被宽度 effect resize(320)，就是打开抽屉后一直闪、点一下才停。
					panel.resize(drawerWidthRef.current);
				}
			} catch {
				/* 约束未就绪，忽略本轮同步 */
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [drawerCollapsed, drawer]);

	// ── 外部宽度变化 → 面板（跳过拖拽回写产生的等值同步，防反馈回路） ──
	useEffect(() => {
		const panel = listPanelRef.current;
		if (!panel || listCollapsed) return;
		if (Math.abs(panel.getSize().inPixels - listWidth) > 1) panel.resize(listWidth);
	}, [listWidth, listCollapsed]);

	useEffect(() => {
		const panel = drawerPanelRef.current;
		if (!panel || !drawer || drawerCollapsed) return;
		const frame = requestAnimationFrame(() => {
			try {
				if (Math.abs(panel.getSize().inPixels - drawerWidth) > 1) panel.resize(drawerWidth);
			} catch {
				/* 约束未就绪 */
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [drawerWidth, drawer, drawerCollapsed]);

	// 水合或用户拖拽改变保存宽度后，先让定位变量跟随保存值；面板若受到约束，
	// 下方 ResizeObserver 会再用实际 DOM 宽度校正。observer 只改 CSS，不触发每帧 React 重渲染。
	useEffect(() => {
		listLayoutWidthRef.current = listWidth;
		const shell = shellRef.current;
		if (shell) writeListLayoutVariables(shell, listWidth, !listCollapsed);
	}, [listWidth, listCollapsed]);
	useEffect(() => {
		drawerLayoutWidthRef.current = drawerWidth;
		const shell = shellRef.current;
		if (shell) writeDrawerLayoutVariables(shell, drawerWidth, Boolean(drawer) && !drawerCollapsed);
	}, [drawerWidth, drawer, drawerCollapsed]);

	// 面板受窗口约束、钉住状态或拖拽影响时，实际 DOM 宽度可能与保存偏好不同。
	// 只把这个瞬时值写入 CSS 定位变量，绝不写回 listWidth/drawerWidth 缓存。
	useEffect(() => {
		const shell = shellRef.current;
		const listElement = listPanelElementRef.current;
		const drawerElement = drawerPanelElementRef.current;
		if (!shell || typeof ResizeObserver === "undefined") return;

		const syncActualWidths = () => {
			if (listElement && !listCollapsed) {
				const width = Math.round(listElement.getBoundingClientRect().width);
				if (width > 1) {
					listLayoutWidthRef.current = width;
					writeListLayoutVariables(shell, width, true);
				}
			}
			if (drawerElement && drawer && !drawerCollapsed) {
				const width = Math.round(drawerElement.getBoundingClientRect().width);
				if (width > 1) {
					drawerLayoutWidthRef.current = width;
					writeDrawerLayoutVariables(shell, width, true);
				}
			}
		};

		const observer = new ResizeObserver(syncActualWidths);
		if (listElement) observer.observe(listElement);
		if (drawerElement) observer.observe(drawerElement);
		syncActualWidths();
		return () => observer.disconnect();
	}, [drawer, drawerCollapsed, drawerPinned, listCollapsed]);

	// ── 布局落定 → 状态回写 ──
	// onLayoutChanged 在一次布局变更“完成”时触发（拖拽释放、分隔条键盘调整、容器缩放）。
	// 窗口/页面缩放不是用户调整宽度，只有真实拖拽/键盘交互才回写持久化偏好；否则
	// preserve-relative-size 的换算结果会污染缓存，下一次启动又把错误宽度恢复出来。
	function handleLayoutChanged(_layout: Layout, meta: LayoutChangedMeta) {
		// 无论交互还是程序化变更，布局落定后都通知悬浮层重算一次。
		notifyLayoutResized();
		if (!meta.isUserInteraction) return;

		const drawerPanel = drawerPanelRef.current;
		if (drawerPanel && drawer && !drawerCollapsed) {
			const px = readPanelLayoutWidth(drawerPanelElementRef.current, drawerPanel);
			const next = shouldCommitPanelPixels({
				px,
				savedWidth: drawerWidth,
				isUserInteraction: true,
			});
			if (next !== null) setDrawerWidth(next);
		}

		const listPanel = listPanelRef.current;
		if (listPanel && !listCollapsed) {
			const px = readPanelLayoutWidth(listPanelElementRef.current, listPanel);
			if (px > 1) {
				listLayoutWidthRef.current = px;
				if (shellRef.current) writeListLayoutVariables(shellRef.current, px, true);
			}
		}
		if (listPanel) {
			const px = Math.round(listPanel.getSize().inPixels);
			const collapsed = listPanel.isCollapsed() || px <= LIST_COLLAPSED_SIZE + 1;
			if (collapsed !== listCollapsed) setListCollapsed(collapsed);
			if (!collapsed) {
				const next = shouldCommitPanelPixels({
					px,
					savedWidth: listWidth,
					isUserInteraction: true,
				});
				if (next !== null) setListWidth(next);
			}
		}
		if (drawerPanel) {
			const px = Math.round(drawerPanel.getSize().inPixels);
			const collapsed = drawerPanel.isCollapsed() || px <= 1;
			if (collapsed) {
				// 拖拽折叠仅允许未钉住场景（pinned 面板 collapsible=false，不会走到这）
				if (!drawerCollapsed) setDrawerCollapsed(true);
			} else if (drawerCollapsed) {
				setDrawerCollapsed(false);
			}
		}
	}

	if (props.compactContent)
		return (
			<div className={["wechat-shell quick-task-shell", useNativeTitleBar ? "" : "custom-titlebar-enabled", !useNativeTitleBar && platform === "darwin" ? "mac-custom-titlebar" : ""].filter(Boolean).join(" ")}>
				<AppHeader
					useNativeTitleBar={useNativeTitleBar}
					platform={platform}
					toggleAlwaysOnTop={toggleAlwaysOnTop}
					isWindowAlwaysOnTop={isWindowAlwaysOnTop}
					minimizeWindow={minimizeWindow}
					toggleMaximizeWindow={toggleMaximizeWindow}
					isWindowMaximized={isWindowMaximized}
					onWindowMaximizedChange={onWindowMaximizedChange}
					closeWindow={closeWindow}
				/>
				<main ref={chatPaneRef} className="flex min-h-0 flex-1 flex-col">
					{props.compactContent}
				</main>
				{children}
			</div>
		);
	return (
		<div
			ref={shellRef}
			className={[
				"wechat-shell",
				drawer && !drawerCollapsed ? "drawer-open" : "",
				listCollapsed ? "list-collapsed" : "",
				drawerCollapsed ? "drawer-collapsed" : "",
				useNativeTitleBar ? "" : "custom-titlebar-enabled",
				// mac 自定义标题栏：系统红绿灯占左上角，右侧不再叠 Win 风格控件。
				!useNativeTitleBar && platform === "darwin" ? "mac-custom-titlebar" : "",
			]
				.filter(Boolean)
				.join(" ")}
			style={
				{
					"--list-width": `${listCollapsed ? 0 : listLayoutWidthRef.current}px`,
					"--list-expanded-width": `${listLayoutWidthRef.current}px`,
					"--list-hover-width": `${Math.max(190, listLayoutWidthRef.current)}px`,
					"--drawer-width": `${drawer && !drawerCollapsed ? drawerLayoutWidthRef.current : 0}px`,
					"--drawer-col-w": `${drawer && !drawerCollapsed ? drawerLayoutWidthRef.current : 0}px`,
					"--drawer-splitter-w": `${drawer && !drawerCollapsed ? 6 : 0}px`,
					// 右缘刻度定位轴（.outline-hover）的底部边界：终端坞打开时让出其高度，
					// 避免刻度铺到终端上；关闭时保底 16px 边距。
					"--outline-bottom": `${Math.max(terminalRowHeight, 0) + 16}px`,
					// 工作台分屏（文件/Diff 在右）时右移内容区宽度，让刻度落在消息区右缘；
					// solo/maximize 时为 0（消息区独占或收起），刻度回窗口右缘。
					"--outline-content-w": `${Math.max(outlineContentOffset, 0)}px`,
				} as CSSProperties
			}
		>
			<AppHeader
				useNativeTitleBar={useNativeTitleBar}
				platform={platform}
				toggleAlwaysOnTop={toggleAlwaysOnTop}
				isWindowAlwaysOnTop={isWindowAlwaysOnTop}
				minimizeWindow={minimizeWindow}
				toggleMaximizeWindow={toggleMaximizeWindow}
				isWindowMaximized={isWindowMaximized}
				onWindowMaximizedChange={onWindowMaximizedChange}
				closeWindow={closeWindow}
			/>
			<ResizablePanelGroup orientation="horizontal" className="shell-panel-group" onLayoutChanged={handleLayoutChanged}>
				<ResizablePanel id="list" panelRef={listPanelRef} collapsible collapsedSize={LIST_COLLAPSED_SIZE} minSize={LIST_WIDTH_MIN} maxSize={LIST_WIDTH_MAX} groupResizeBehavior="preserve-pixel-size" defaultSize={listCollapsed ? LIST_COLLAPSED_SIZE : listWidth} className="shell-panel-list">
					<div
						ref={listPanelElementRef}
						className={cn("h-full min-w-0", listEntering && "list-content-enter")}
						onAnimationEnd={(event) => {
							if (event.target === event.currentTarget) setListEntering(false);
						}}
					>
						{sidebarContent}
					</div>
				</ResizablePanel>
				{/* 双击分隔条 = react-resizable-panels 把相邻有 defaultSize 的面板 resize 回
            defaultSize。drawer 面板 defaultSize={0}（常驻挂载、初始折叠），双击
            splitter-right 会把抽屉缩到 0 且再次双击仍回 0——「缩没了无法复原，只能
            重启」（2026-08 用户反馈）。左右分隔条统一 disableDoubleClick：桌面工作台
            里双击折叠不是预期手势，折叠/展开走侧栏与抽屉的专属按钮。 */}
				<ResizableHandle className="splitter splitter-left" disableDoubleClick />

				<ResizablePanel id="chat" minSize={360} className="shell-panel-chat">
					<main
						ref={chatPaneRef}
						className="chat-pane"
						style={
							{
								"--terminal-row-h": `${terminalRowHeight}px`,
								// 内容宽度百分比（60–100）：消息区/输入框用 var(--chat-content-pct-set) 做 width。
								"--chat-content-pct-set": `${chatContentWidthPct}%`,
							} as CSSProperties
						}
					>
						{chatPaneContent}
					</main>
				</ResizablePanel>

				{/* 抽屉面板常驻挂载：drawer=null 时折叠为 0 宽，避免动态挂载导致
            Group 布局时序错误（Invalid panel layout / constraints not found）。
            内容由 WorkspaceDrawerHost 的空态兜底。
            disableDoubleClick：drawer defaultSize=0，双击分隔条会把抽屉缩到 0
            且无法再双击恢复（见 splitter-left 注释，2026-08 用户反馈）。 */}
				<ResizableHandle className="splitter splitter-right" data-active={Boolean(drawer) && !drawerCollapsed} disableDoubleClick />
				<ResizablePanel id="drawer" panelRef={drawerPanelRef} collapsible={!drawerPinned} collapsedSize={0} minSize={drawerPinned ? DRAWER_WIDTH_MIN_PINNED : DRAWER_WIDTH_MIN} maxSize={DRAWER_WIDTH_MAX} groupResizeBehavior="preserve-pixel-size" defaultSize={0} className="shell-panel-drawer">
					<div
						ref={drawerPanelElementRef}
						className={cn("h-full min-w-0", drawerEntering && "drawer-content-enter")}
						onAnimationEnd={(event) => {
							if (event.target === event.currentTarget) setDrawerEntering(false);
						}}
					>
						<WorkspaceDrawerHost panel={drawer} collapsed={drawerCollapsed} pinned={drawerPinned} onCollapse={onDrawerCollapse} onClose={onDrawerClose} onRestore={onDrawerRestore} onTogglePin={onToggleDrawerPin} rail={drawerRail} renderPanel={(panel) => drawerContent(panel)} />
					</div>
				</ResizablePanel>
			</ResizablePanelGroup>
			{/* 大纲浮层必须放在 Group 外：v4 只认 data-panel / data-separator 直系子节点，
          夹在 panel 之间会污染分隔条命中区计算（absolute 也不算例外）。 */}
			{outlineContent}
			{children}
		</div>
	);
}
