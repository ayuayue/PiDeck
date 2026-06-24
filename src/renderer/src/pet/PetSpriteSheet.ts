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

/** PetMode → spritesheet 行号映射（设计文档第 3.2 节） */
export const MODE_ROW: Record<string, number> = {
	idle: 0, // 行0
	running: 7, // 行7 ← AgentStatus: running（聚合主态）
	failed: 5, // 行5 ← error
	waiting: 6, // 行6 ← starting
	waving: 3, // 行3 ← closed 过渡态
	"running-right": 1, // 行1 右向巡游
	"running-left": 2,  // 行2 左向巡游
	jumping: 4,  // 行4 跳跃
	review: 8,    // 行8 审查
};

export type SpriteSheet = {
	/** 已解码的 ImageBitmap / HTMLImageElement，供 Canvas drawImage 使用 */
	image: CanvasImageSource;
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
		cols: GRID_COLS,
		rows: GRID_ROWS,
		cellW: CELL_W,
		cellH: CELL_H,
	};
}