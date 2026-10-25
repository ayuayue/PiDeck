import { ChevronLeft } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { DRAWER_ANIMATION_MS, type WorkspaceDrawerPanel } from "../../hooks/useWorkspacePanels";

export function getVisibleDrawerPanel<T>(open: boolean, panel: T | null, renderedDrawer: T | null) {
	return open ? panel : renderedDrawer;
}

export type WorkspaceDrawerHostProps = {
	panel: WorkspaceDrawerPanel | null;
	collapsed: boolean;
	pinned?: boolean;
	className?: string;
	style?: CSSProperties;
	onCollapse?: () => void;
	onClose?: () => void;
	onRestore?: () => void;
	onTogglePin?: () => void;
	/** 抽屉打开期间常驻的活动栏（面板切换入口），由 App 层组装后注入。 */
	rail?: ReactNode;
	renderPanel: (panel: WorkspaceDrawerPanel) => ReactNode;
};

/**
 * Keeps the drawer compositor mounted while the grid column closes. The 120ms
 * delay is part of the layout contract: removing content before the grid motion
 * completes makes text disappear before the drawer itself reaches zero width.
 */
export function WorkspaceDrawerHost(props: WorkspaceDrawerHostProps) {
	const [renderedDrawer, setRenderedDrawer] = useState<WorkspaceDrawerPanel | null>(props.panel);
	const unmountTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (unmountTimerRef.current) {
			clearTimeout(unmountTimerRef.current);
			unmountTimerRef.current = null;
		}
		if (props.panel && !props.collapsed) {
			setRenderedDrawer(props.panel);
			return;
		}
		if (!renderedDrawer) return;
		unmountTimerRef.current = setTimeout(() => {
			setRenderedDrawer(null);
			unmountTimerRef.current = null;
		}, DRAWER_ANIMATION_MS);
		return () => {
			if (unmountTimerRef.current) {
				clearTimeout(unmountTimerRef.current);
				unmountTimerRef.current = null;
			}
		};
	}, [props.collapsed, props.panel, renderedDrawer]);

	useEffect(
		() => () => {
			if (unmountTimerRef.current) clearTimeout(unmountTimerRef.current);
		},
		[],
	);

	const open = Boolean(props.panel && !props.collapsed);
	// A newly opened or switched panel must render synchronously; only a closing
	// compositor uses the previous rendered panel as its delayed fallback.
	const visiblePanel = getVisibleDrawerPanel(open, props.panel, renderedDrawer);
	const rendered = visiblePanel ? props.renderPanel(visiblePanel) : null;
	return (
		<>
			<aside className={props.className ?? "detail-drawer flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background"} data-open={open} data-rendered={Boolean(visiblePanel)} data-pinned={Boolean(props.pinned)} style={props.style}>
				{visiblePanel && (
					<>
						{/* 自定义标题栏：为右上角 fixed 的窗口控件让出 var(--window-drag-height) 顶部条。
						    让位区必须是一个真实元素而不是 .detail-drawer 的 padding——它的 border-b 与
						    .list-toolbar / .session-tabs-bar 的 border-b 落在同一行（40px 盒子的 39–40px），
						    标题栏分隔线因此横贯整窗；改用 padding 时让位区没有线，抽屉 tab 栏比会话
						    tab 栏低 40px，看起来就是「线不齐」（2026-10 用户反馈）。
						    右边距扣掉窗口控件宽度：控件容器自己补的底边线接着画到窗口右缘，两段不重叠
						    （壁纸模式窗口控件背景透明，重叠会叠出更深的双线）。
						    原生标题栏下 --window-drag-height 为 0，元素不占高也不画线；simple 模式
						    没有 40px 标题栏行，同样不画线（见 styles/tailwind.css 的 workspace-titlebar）。 */}
						<div aria-hidden="true" className="h-[var(--window-drag-height)] shrink-0 workspace-titlebar:mr-[var(--window-controls-width)] workspace-titlebar:border-b workspace-titlebar:border-border/40" />
						<div className="drawer-content-frame flex min-h-0 flex-1 flex-col overflow-hidden">
							{open && props.rail}
							{rendered}
						</div>
					</>
				)}
			</aside>
			{props.panel && props.collapsed && props.onRestore && (
				<Button
					type="button"
					variant="outline"
					size="icon"
					className="drawer-restore inline-flex size-8 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm hover:bg-accent hover:text-accent-foreground"
					title={t("drawer.expandPanel")}
					aria-label={t("drawer.expandPanel")}
					onClick={props.onRestore}
				>
					<ChevronLeft size={16} />
				</Button>
			)}
		</>
	);
}

export { DRAWER_ANIMATION_MS };
