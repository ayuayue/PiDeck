import { useEffect, type ReactNode } from "react";
import { BrowserPanel } from "../app/BrowserPanel";

export type BrowserSurfaceProps = {
	fullscreen: boolean;
	onClose: () => void;
	onMinimize: () => void;
	onEnterFullscreen: () => void;
	className?: string;
	children?: ReactNode;
};

/**
 * 内置浏览器宿主：抽屉态与全屏态共用**同一个宿主节点**，切换只改样式，不搬 DOM。
 *
 * 为什么（issue #508）：此前两种形态各渲染一个 <BrowserPanel>（两棵不同元素树），切换时
 * React 卸载重挂 -> <webview> 被销毁 -> WebContents 重建：SPA 状态、滚动位置、登录上下文全丢，
 * 主进程 did-attach-webview 也换一个 webContentsId，browser_* MCP 工具看到的是新页面。
 *
 * 关键约束（实测得出，改之前务必读）：
 * 1. 只让节点样式变化，绝不让它换父节点。React 把子树从一处搬到 portal 另一处时，会逐个
 *    remove/append 宿主 DOM 节点；<webview> 一旦脱离文档再插回，Electron 必然重建 guest（页面重载）。
 *    所以这里不用 createPortal 切换子树：浏览器面板永远挂在抽屉里那一个容器节点上，
 *    全屏只是给这个节点换成固定全屏样式。
 * 2. 因为不 portal，全屏态的层级靠 z-index 保证覆盖主界面（见 .browser-surface-stage--fullscreen）。
 *    全屏期间抽屉若被收起导致祖先 display:none，position:fixed 仍保证 stage 铺满视口，guest 不卸载。
 * 3. 遮罩层是 stage 的兄弟节点、按需渲染，且不包裹 stage（包裹会让 stage 换父节点，webview 被搬一次）。
 */
export function BrowserSurface(props: BrowserSurfaceProps) {
	// 全屏态是覆盖全窗口的模态：Escape 必须可关（键盘用户无法依赖 backdrop 点击），
	// 与 FileDiffViewer 等其余模态的 Escape 惯例对齐；抽屉态不拦截 Escape。
	useEffect(() => {
		if (!props.fullscreen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") props.onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [props.fullscreen, props.onClose]);

	return (
		<div className="browser-surface-host">
			{props.fullscreen ? <div className={props.className ?? "modal-backdrop browser-surface-backdrop"} data-browser-surface-backdrop="" onClick={props.onClose} /> : null}
			<div className={`drawer-content-frame browser-surface-stage ${props.fullscreen ? "browser-surface-stage--fullscreen" : "browser-surface-stage--drawer"}`} data-browser-surface={props.fullscreen ? "fullscreen" : "drawer"}>
				{/* 抽屉模式下关闭改走 Tab 栏活动图标；hideChromeClose 避免与之重复（全屏态自带关闭钮）。 */}
				<BrowserPanel isFullscreen={props.fullscreen} hideChromeClose={!props.fullscreen} onClose={props.onClose} onMinimize={props.onMinimize} onToggleFullscreen={props.onEnterFullscreen} />
				{props.children}
			</div>
		</div>
	);
}
