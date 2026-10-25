/**
 * 并行问询胶囊（AskPanel）的位置钳制纯逻辑（与渲染解耦，便于单测）。
 *
 * 背景：胶囊可拖动（绝对定位 px），展开详情面板悬于胶囊上方、右缘对齐。
 * 窗口缩放、拖到边缘、或展开/收起瞬间，胶囊/面板可能越出视口——这里统一把
 * 「胶囊左上角 (x, y)」钳制在保证两者都完整可见的区间内。
 *
 * 尺寸常量必须与 AskPanelOverlay 的 className 公式保持一致，否则钳制区间
 * 与实际渲染尺寸错位（改样式时同步改这里，测试会兜底尺寸推导）。
 */

/** 胶囊视觉宽度上限（AskPanelOverlay 的 max-w，340px） */
export const PILL_MAX_WIDTH = 340;
/** 展开面板宽度上限（560px；CSS 另取 min(…, calc(100vw - 2rem))） */
export const PANEL_MAX_WIDTH = 560;
/** 展开面板高度上限（400px；CSS 另取 min(…, 48vh)） */
export const PANEL_MAX_HEIGHT = 400;
/** 胶囊高度（h-9 = 36px） */
export const PILL_HEIGHT = 36;
/** 视口边缘留白（px） */
export const VIEWPORT_MARGIN = 8;
/** 面板与胶囊间距（mb-2 = 8px） */
export const PANEL_GAP = 8;
/** 视口边距（CSS 里 calc(100vw - 2rem)，2rem = 32px；与钳制留白是两回事） */
export const VIEWPORT_EDGE_PAD = 32;

/** 胶囊实际渲染尺寸（CSS：max-w-[min(340px,calc(100vw-2rem))]，h-9） */
export function pillSize(viewportWidth: number) {
	return {
		width: Math.min(PILL_MAX_WIDTH, Math.max(0, viewportWidth - VIEWPORT_EDGE_PAD)),
		height: PILL_HEIGHT,
	};
}

/** 展开面板实际渲染尺寸（CSS：w-[min(560px,calc(100vw-2rem))] h-[min(48vh,400px)]） */
export function expandedPanelSize(viewportWidth: number, viewportHeight: number) {
	return {
		width: Math.min(PANEL_MAX_WIDTH, Math.max(0, viewportWidth - VIEWPORT_EDGE_PAD)),
		height: Math.min(PANEL_MAX_HEIGHT, viewportHeight * 0.48),
	};
}

/**
 * 把胶囊左上角 (x, y) 钳制到可见区间。
 *
 * 展开时面板（panelW × panelH，悬于胶囊上方 PANEL_GAP，右缘与胶囊右缘对齐）必须整体可见：
 * - 面板左缘 = x + pillW − panelW ≥ M      ⇒ x ≥ M + panelW − pillW
 * - 面板右缘 = x + pillW ≤ vw − M          ⇒ x ≤ vw − M − pillW
 * - 面板顶缘 = y − panelH − PANEL_GAP ≥ M  ⇒ y ≥ M + panelH + PANEL_GAP
 * - 胶囊底缘 = y + pillH ≤ vh − M          ⇒ y ≤ vh − M − pillH
 * 折叠时面板不参与，仅约束胶囊本身。
 * 极端小窗口下区间可能倒置（minX > maxX），用 Math.max 兜底防止反转。
 */
export function clampCapsulePosition(x: number, y: number, viewport: { width: number; height: number }, expanded: boolean): { x: number; y: number } {
	const { width: vw, height: vh } = viewport;
	const { width: pillW } = pillSize(vw);
	const { width: panelW, height: panelH } = expandedPanelSize(vw, vh);
	// 面板左缘约束只在展开时成立（折叠时面板不渲染，胶囊可贴到留白边）
	const minX = VIEWPORT_MARGIN + (expanded ? Math.max(0, panelW - pillW) : 0);
	const maxX = Math.max(minX, vw - VIEWPORT_MARGIN - pillW);
	const minY = VIEWPORT_MARGIN + (expanded ? panelH + PANEL_GAP : 0);
	const maxY = Math.max(minY, vh - VIEWPORT_MARGIN - PILL_HEIGHT);
	return {
		x: Math.min(maxX, Math.max(minX, x)),
		y: Math.min(maxY, Math.max(minY, y)),
	};
}
