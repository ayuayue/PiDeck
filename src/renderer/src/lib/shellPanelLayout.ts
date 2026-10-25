/**
 * AppShell 侧栏/抽屉持久化宽度回写策略。
 *
 * 只有用户主动拖拽/键盘调整时才提交宽度偏好。窗口尺寸或页面缩放属于容器布局
 * 变化，不应把 react-resizable-panels 的临时换算结果写入缓存，否则下次启动会
 * 恢复错误的侧栏/抽屉宽度。
 */

export type PanelPixelCommitInput = {
	/** 面板当前实测像素（getSize().inPixels） */
	px: number;
	/** React / localStorage 里的保存宽度 */
	savedWidth: number;
	/** 用户拖拽/键盘调分隔条为 true；窗口缩放、expand/resize effect 为 false */
	isUserInteraction: boolean;
};

/**
 * 折叠态像素：启动 defaultSize=0、或尚未 expand 完成。
 * 写成 0 会让宽度 effect 再 resize(0)，与 expand 形成 0↔min 震荡。
 */
export function isCollapsedPanelPixels(px: number): boolean {
	return px <= 1;
}

/**
 * 是否应把实测像素写回保存宽度。
 * 返回要写入的像素；null 表示忽略本轮，避免覆盖保存值或形成回路。
 */
export function shouldCommitPanelPixels(input: PanelPixelCommitInput): number | null {
	if (!input.isUserInteraction) return null;
	const px = Math.round(input.px);
	const saved = Math.round(input.savedWidth);
	if (isCollapsedPanelPixels(px)) return null;
	if (Math.abs(px - saved) <= 1) return null;
	return px;
}
