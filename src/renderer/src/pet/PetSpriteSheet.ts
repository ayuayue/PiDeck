import type { PetManifest } from "@shared/types";

/**
 * PetSpriteSheet —— spritesheet 加载与网格切帧（设计文档第 6.2 节）。
 *
 * 沿用 petdex/Codex 规格：整张 1536×1872，网格 8 列 × 9 行，单格 192×208，背景透明。
 * 每个状态对应一行，按帧索引（0..7）取单格，循环播放构成动画。
 */

/** petdex 标准网格规格 */
export const GRID_COLS = 8;
export const GRID_ROWS = 9;
export const CELL_W = 192;
export const CELL_H = 208;

/** PetMode → spritesheet 行号 */
export const MODE_ROW: Record<string, number> = {
	idle: 0, running: 7, failed: 5, waiting: 6, waving: 3,
	"running-right": 1, "running-left": 2, jumping: 4, review: 8,
};

/** PetMode → 帧数（连续取前 N 列，列索引 0..N-1） */
export const MODE_FRAMES: Record<string, number> = {
	idle: 6, running: 6, failed: 8, waiting: 6, waving: 4,
	"running-right": 8, "running-left": 8, jumping: 5, review: 6,
};

export type SpriteSheet = {
	/** 已解码的 ImageBitmap / HTMLImageElement，供 Canvas drawImage 使用 */
	image: CanvasImageSource;
	/** data: URL 或 file: URL，供 CSS background-image 使用（避免 Canvas 闪烁） */
	url: string;
	/** 实际网格列数（默认 8） */
	cols: number;
	/** 实际网格行数（默认 9） */
	rows: number;
	/** 单格宽 */
	cellW: number;
	/** 单格高 */
	cellH: number;
};

/** 加载 spritesheet 图片，解析失败时 reject（渲染层据此降级绘制） */
export async function loadSpriteSheet(manifest: PetManifest): Promise<SpriteSheet> {
	if (!manifest.spritesheetUrl) {
		throw new Error("empty spritesheet url");
	}
	const img = new Image();
	// petdex 包走 file://，内置走 ?asset 的 file://；CSP 已允许 img-src file: data: 'self'
	img.src = manifest.spritesheetUrl;
	await img.decode();
	return {
		image: img,
		url: manifest.spritesheetUrl,
		cols: GRID_COLS,
		rows: GRID_ROWS,
		cellW: CELL_W,
		cellH: CELL_H,
	};
}