/**
 * 会话内查找浮层的锚点计算（纯函数，可单测）。
 *
 * 浮层 portal 到 body 用 fixed 定位，所以「相对会话消息区右上角」必须换算成视口坐标：
 * 消息区右侧可能还有抽屉面板，不能直接用视口右缘。锚点未就绪（未布局/已卸载）时
 * 退回视口右上角下方——宁可位置略偏，也不能算在屏幕外或压住窗口关闭键。
 */
export type SessionFindAnchorRect = { top: number; right: number };
export type SessionFindViewport = { width: number; height: number };
export type SessionFindAnchor = { top: number; right: number };

/** 与消息区/视口边缘的间距。 */
export const SESSION_FIND_INSET = 12;
/**
 * 标题栏安全线：自定义标题栏下聊天区内容顶到窗口上沿（`padding-top: 0`），右上角那 40px
 * 是固定的窗口控件（置顶/最小化/最大化/关闭），浮层落进去会直接盖住关闭键
 * （2027-02 用户反馈「搜索图标跑到关闭窗口位置」）。任何锚点读数都不许高于这条线。
 */
export const SESSION_FIND_TITLEBAR_MIN_TOP = 52;

export function resolveSessionFindAnchor(rect: { top: number; right: number; width: number } | null | undefined, viewport: SessionFindViewport): SessionFindAnchor {
	if (!rect || !(rect.width > 0)) {
		return { top: SESSION_FIND_TITLEBAR_MIN_TOP, right: SESSION_FIND_INSET };
	}
	// right 用「视口宽 - 消息区右缘」换算：消息区右边常有抽屉，不能写死视口边缘。
	const right = clamp(Math.round(viewport.width - rect.right) + SESSION_FIND_INSET, SESSION_FIND_INSET, Math.max(SESSION_FIND_INSET, viewport.width - SESSION_FIND_INSET));
	const top = clamp(Math.max(Math.round(rect.top) + SESSION_FIND_INSET, SESSION_FIND_TITLEBAR_MIN_TOP), SESSION_FIND_INSET, Math.max(SESSION_FIND_INSET, viewport.height - SESSION_FIND_INSET));
	return { top, right };
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}
