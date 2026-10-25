import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BrowserPanel } from "../app/BrowserPanel";

export type BrowserSurfaceProps = {
	fullscreen: boolean;
	onClose: () => void;
	onMinimize: () => void;
	onEnterFullscreen: () => void;
	className?: string;
	children?: ReactNode;
};

/** Provides one BrowserPanel owner while moving it between drawer and fullscreen compositor. */
export function BrowserSurface(props: BrowserSurfaceProps) {
	// 全屏态是 portal 到 body 的模态：Escape 必须可关（键盘用户无法依赖 backdrop 点击），
	// 与 FileDiffViewer 等其余模态的 Escape 惯例对齐；抽屉态不拦截 Escape。
	useEffect(() => {
		if (!props.fullscreen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [props.fullscreen, props.onClose]);

	if (props.fullscreen) {
		// portal 到 body：modal-backdrop 是 absolute 定位，留在抽屉 Panel 内会被
		// 面板的定位上下文限制成“只在侧边栏全屏”；挂到 body 后覆盖整个主界面。
		return createPortal(
			<div className={props.className ?? "modal-backdrop"} onClick={props.onClose}>
				<div className="browser-modal" onClick={(event) => event.stopPropagation()}>
					<BrowserPanel isFullscreen onClose={props.onClose} onMinimize={props.onMinimize} />
					{props.children}
				</div>
			</div>,
			document.body,
		);
	}

	return (
		<div className="drawer-content-frame">
			{/* 抽屉模式下关闭改走 Tab 栏活动图标；hideChromeClose 避免与之重复 */}
			<BrowserPanel hideChromeClose onClose={props.onClose} onToggleFullscreen={props.onEnterFullscreen} />
			{props.children}
		</div>
	);
}
