import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { LayoutChangedMeta, PanelImperativeHandle } from "react-resizable-panels";
import { t } from "../../i18n";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui-shadcn/resizable";
import {
	RIGHT_SIDEBAR_STACK_STORAGE_KEY,
	SIDEBAR_BOTTOM_COLLAPSED_PX,
	SIDEBAR_BOTTOM_MIN_PX,
	SIDEBAR_BOTTOM_PANEL_ID,
	SIDEBAR_TOP_MIN_PX,
	SIDEBAR_TOP_PANEL_ID,
	clampBottomPct,
	parseRightSidebarStackPrefs,
	resolveBottomCollapsed,
	serializeRightSidebarStackPrefs,
	shouldAutoCollapseBottom,
	type RightSidebarStackPrefs,
} from "./rightSidebarLayout";

/**
 * 右侧边栏上下分区：抽屉列内部的纵向分割。
 *
 * 上半区原样承载 WorkspaceDrawerHost；下半区是常驻面板（会话状态）。本组件只管
 * 尺寸、拖拽、收起与偏好持久化，不感知下半区业务；收起状态经 context 交给下半区，
 * 由它在 tab 栏渲染展开/收起按钮。
 *
 * 外层容器不加 position/transform：抽屉收起时的 .drawer-restore 是 absolute 定位，
 * 包含块必须仍是外壳，不能被这里截获。
 */

export type RightSidebarStackState = {
	/** 抽屉列是否打开；关闭时下半区不应拉取数据。 */
	open: boolean;
	/** 下半区有效收起态：用户偏好或高度不足自动收起。 */
	collapsed: boolean;
	/** 因侧栏高度不足而自动收起；此时展开操作无效。 */
	autoCollapsed: boolean;
	toggleCollapsed: () => void;
	expand: () => void;
};

const RightSidebarStackContext = createContext<RightSidebarStackState | null>(null);

export function useRightSidebarStack(): RightSidebarStackState {
	const value = useContext(RightSidebarStackContext);
	if (!value) {
		throw new Error("useRightSidebarStack must be used under RightSidebarStack");
	}
	return value;
}

function loadPrefs(): RightSidebarStackPrefs {
	try {
		return parseRightSidebarStackPrefs(localStorage.getItem(RIGHT_SIDEBAR_STACK_STORAGE_KEY));
	} catch {
		return parseRightSidebarStackPrefs(null);
	}
}

function savePrefs(prefs: RightSidebarStackPrefs): void {
	try {
		localStorage.setItem(RIGHT_SIDEBAR_STACK_STORAGE_KEY, serializeRightSidebarStackPrefs(prefs));
	} catch {
		// 隐私模式或配额失败：本次会话内仍按内存偏好工作。
	}
}

export function RightSidebarStack(props: { open: boolean; top: ReactNode; bottom?: ReactNode }) {
	if (!props.bottom) return <>{props.top}</>;
	return <RightSidebarSplit open={props.open} top={props.top} bottom={props.bottom} />;
}

function RightSidebarSplit(props: { open: boolean; top: ReactNode; bottom: ReactNode }) {
	const [prefs, setPrefs] = useState(loadPrefs);
	const [autoCollapsed, setAutoCollapsed] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const bottomPanelRef = useRef<PanelImperativeHandle | null>(null);
	const prefsRef = useRef(prefs);
	prefsRef.current = prefs;
	const autoCollapsedRef = useRef(autoCollapsed);
	autoCollapsedRef.current = autoCollapsed;
	// 初始尺寸只在挂载时取一次：之后尺寸由面板库持有，程序化同步走 collapse/resize。
	const [initialBottomSize] = useState<number | string>(() => (prefs.collapsed ? SIDEBAR_BOTTOM_COLLAPSED_PX : `${prefs.bottomPct}%`));
	const collapsed = resolveBottomCollapsed(prefs, autoCollapsed);

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;
		setAutoCollapsed(shouldAutoCollapseBottom(element.getBoundingClientRect().height));
		const observer = new ResizeObserver((entries) => {
			const height = entries[0]?.contentRect.height;
			if (height !== undefined) setAutoCollapsed(shouldAutoCollapseBottom(height));
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	// 有效收起态 → 面板。放到下一帧：面板约束注册有一帧延迟（同 SessionView 终端坞）。
	// 程序化调用触发的 onLayoutChanged 带 isUserInteraction=false，不会回写偏好。
	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			const panel = bottomPanelRef.current;
			if (!panel) return;
			try {
				if (collapsed) {
					if (!panel.isCollapsed()) panel.collapse();
				} else if (panel.isCollapsed()) {
					panel.expand();
					panel.resize(`${prefsRef.current.bottomPct}%`);
				}
			} catch {
				// 约束尚未注册：下一次状态变化会再同步。
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [collapsed]);

	const commitPrefs = useCallback((next: RightSidebarStackPrefs) => {
		prefsRef.current = next;
		savePrefs(next);
		setPrefs(next);
	}, []);

	const handleLayoutChanged = useCallback(
		(_layout: unknown, meta: LayoutChangedMeta) => {
			// 只记录用户直接拖拽/键盘调整；自动收起期间的布局不代表用户偏好。
			if (!meta.isUserInteraction || autoCollapsedRef.current) return;
			const panel = bottomPanelRef.current;
			if (!panel) return;
			if (panel.isCollapsed()) {
				commitPrefs({ ...prefsRef.current, collapsed: true });
			} else {
				commitPrefs({ collapsed: false, bottomPct: clampBottomPct(panel.getSize().asPercentage) });
			}
		},
		[commitPrefs],
	);

	const toggleCollapsed = useCallback(() => {
		if (autoCollapsedRef.current) return;
		commitPrefs({ ...prefsRef.current, collapsed: !prefsRef.current.collapsed });
	}, [commitPrefs]);

	const expand = useCallback(() => {
		if (autoCollapsedRef.current || !prefsRef.current.collapsed) return;
		commitPrefs({ ...prefsRef.current, collapsed: false });
	}, [commitPrefs]);

	const contextValue = useMemo<RightSidebarStackState>(() => ({ open: props.open, collapsed, autoCollapsed, toggleCollapsed, expand }), [props.open, collapsed, autoCollapsed, toggleCollapsed, expand]);

	return (
		<div ref={containerRef} className="h-full min-h-0 min-w-0">
			<ResizablePanelGroup orientation="vertical" onLayoutChanged={handleLayoutChanged}>
				<ResizablePanel id={SIDEBAR_TOP_PANEL_ID} minSize={SIDEBAR_TOP_MIN_PX}>
					{props.top}
				</ResizablePanel>
				{/* 线条同 AppShell 左右 .splitter：1px border-subtle 50%，悬停/拖拽 text-tertiary 55%；
				    命中区上下各扩 4px。双击会把面板复位到 defaultSize，与左右分隔条一致禁用。
				    抽屉关闭时列宽为 0：禁用并移出无障碍树，否则 Tab 键会聚焦到看不见的分隔条。 */}
				<ResizableHandle
					aria-label={t("sessionStatus.resizeHandle")}
					aria-hidden={!props.open || undefined}
					disabled={!props.open}
					className="group/sash bg-border-subtle/50 transition-colors hover:bg-text-tertiary/55 data-[separator=active]:bg-text-tertiary/55 aria-[orientation=horizontal]:after:h-2"
					disableDoubleClick
				>
					{/* 常显的居中把手：细线本身不易发现可拖。z-10 压过下半区 tab 栏内的定位元素 */}
					<span aria-hidden="true" className="pointer-events-none relative z-10 h-1 w-8 rounded-full bg-text-tertiary/40 transition-colors group-hover/sash:bg-text-tertiary/80 group-data-[separator=active]/sash:bg-text-tertiary/80" />
				</ResizableHandle>
				<ResizablePanel id={SIDEBAR_BOTTOM_PANEL_ID} panelRef={bottomPanelRef} collapsible collapsedSize={SIDEBAR_BOTTOM_COLLAPSED_PX} minSize={SIDEBAR_BOTTOM_MIN_PX} defaultSize={initialBottomSize} style={{ overflow: "hidden" }}>
					<RightSidebarStackContext.Provider value={contextValue}>{props.bottom}</RightSidebarStackContext.Provider>
				</ResizablePanel>
			</ResizablePanelGroup>
		</div>
	);
}
