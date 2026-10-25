/**
 * 启动页官方 pi 风格 logo 动画（与侧栏 PiLogoCanvas 同源逻辑）。
 * 在 React 挂载前由 index.html 引入；覆盖层移除前循环播放，尊重 prefers-reduced-motion。
 */

type ColorKey = "cyan" | "red" | "green" | "orange" | "flash" | "white" | "ink";

type Piece = {
	color: ColorKey;
	cells: Array<[number, number]>;
	startX: number;
	startY: number;
	targetX: number;
	targetY: number;
};

type Cells = Record<string, ColorKey>;

// 启动页比侧栏更快：更高帧率 + 更短 hold，让冷启动窗口内能多循环几轮
const LOGO_FPS = 36;
const CLEAR_ROW = 6;

const COLORS: Record<ColorKey, string> = {
	cyan: "#4B607C",
	red: "#8F4632",
	green: "#A3A473",
	orange: "#D4904E",
	flash: "#fff5b4",
	white: "#ffffff",
	ink: "#09090B",
};

const BORDER_COLORS: Partial<Record<ColorKey, string>> = {
	cyan: "#2D3D55",
	red: "#4F271C",
	green: "#5A5A3F",
	orange: "#754F2B",
	ink: "#000000",
	white: "#9ca3af",
};

const TOP: Piece = {
	color: "cyan",
	cells: [
		[0, 0],
		[0, 1],
		[0, 2],
		[1, 2],
	],
	startX: 2,
	startY: -2,
	targetX: 2,
	targetY: 2,
};

const LEFT: Piece = {
	color: "red",
	cells: [
		[0, 0],
		[1, 0],
		[1, 1],
		[2, 0],
	],
	startX: 0,
	startY: -3,
	targetX: 2,
	targetY: 3,
};

const RIGHT: Piece = {
	color: "green",
	cells: [
		[0, 0],
		[1, 0],
		[2, 0],
		[2, 1],
	],
	startX: 5,
	startY: -3,
	targetX: 5,
	targetY: 4,
};

const BASE: Piece = {
	color: "orange",
	cells: [
		[0, 0],
		[0, 1],
		[0, 2],
		[0, 3],
	],
	startX: 1,
	startY: -2,
	targetX: 1,
	targetY: 6,
};

const LOGO_SEQUENCE: Array<{ piece: Piece; duration: number; holdAfter: number }> = [
	// duration/hold 约为侧栏原版的 ~45%，拼装更干脆
	{ piece: BASE, duration: 42, holdAfter: 4 },
	{ piece: LEFT, duration: 42, holdAfter: 4 },
	{ piece: TOP, duration: 42, holdAfter: 4 },
	{ piece: RIGHT, duration: 42, holdAfter: 14 },
];

const LOGO_TIMING = {
	initialHold: 8,
	clearFlashCount: 3,
	clearFlashStep: 18,
	postClearHold: 16,
	// 定格略停再开下一轮，别空等太久
	postDropHold: 18,
	// 循环间隔：尽快重播
	loopGapMs: 120,
};

const FINAL_LOGO = ["3:2", "3:3", "3:4", "4:2", "4:4", "5:2", "5:3", "5:5", "6:2", "6:5"];

const FINAL_LOGO_BOUNDS = { minX: 2, maxX: 5, minY: 3, maxY: 6 } as const;

function toCellKey(y: number, x: number) {
	return `${y}:${x}`;
}

function parseCellKey(key: string) {
	const [y, x] = key.split(":").map(Number);
	return { y, x };
}

function getCellsBounds(cells: Cells) {
	let minX = Infinity;
	let maxX = -Infinity;
	let minY = Infinity;
	let maxY = -Infinity;
	for (const key of Object.keys(cells)) {
		const { y, x } = parseCellKey(key);
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	if (!Number.isFinite(minX)) return { ...FINAL_LOGO_BOUNDS };
	return { minX, maxX, minY, maxY };
}

function easeOutCubic(t: number) {
	return 1 - (1 - t) ** 3;
}

function prefersReducedMotion() {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function isDarkScheme() {
	return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function settledLogoColor(): ColorKey {
	return isDarkScheme() ? "white" : "ink";
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		window.setTimeout(resolve, ms);
	});
}

function copyCells(cells: Cells): Cells {
	return { ...cells };
}

function mergePiece(cells: Cells, piece: Piece, x: number, y: number) {
	for (const [dy, dx] of piece.cells) {
		cells[toCellKey(y + dy, x + dx)] = piece.color;
	}
}

function finalLogoCells(color: ColorKey): Cells {
	const cells: Cells = {};
	for (const key of FINAL_LOGO) cells[key] = color;
	return cells;
}

function drawBlock(ctx: CanvasRenderingContext2D, left: number, top: number, width: number, height: number, color: ColorKey, neighbors: { top?: string; right?: string; bottom?: string; left?: string }) {
	const fillColor = COLORS[color] ?? COLORS.white;
	const borderColor = BORDER_COLORS[color] ?? fillColor;
	const sameTop = neighbors.top === color;
	const sameRight = neighbors.right === color;
	const sameBottom = neighbors.bottom === color;
	const sameLeft = neighbors.left === color;

	ctx.globalAlpha = 1;
	ctx.fillStyle = fillColor;
	ctx.fillRect(left, top, width, height);
	if (width < 5 || height < 5) return;

	const inset = width >= 8 ? 2 : 1;
	const innerLeft = left + inset;
	const innerTop = top + inset;
	const innerWidth = width - inset * 2;
	const innerHeight = height - inset * 2;
	if (innerWidth <= 0 || innerHeight <= 0) return;

	const fillAlpha = (fill: string, alpha: number, x: number, y: number, w: number, h: number) => {
		if (alpha <= 0 || w <= 0 || h <= 0) return;
		ctx.globalAlpha = alpha;
		ctx.fillStyle = fill;
		ctx.fillRect(x, y, w, h);
		ctx.globalAlpha = 1;
	};

	const faceTopH = Math.max(1, Math.floor(innerHeight * 0.55));
	fillAlpha("#ffffff", 0.08, innerLeft, innerTop, innerWidth, faceTopH);
	fillAlpha("#000000", 0.06, innerLeft, innerTop + faceTopH, innerWidth, innerHeight - faceTopH);

	const topOuter = sameTop ? 1 : 2;
	const bottomOuter = sameBottom ? 1 : 2;
	fillAlpha("#ffffff", sameTop ? 0.12 : 0.28, left, top, width, topOuter);
	fillAlpha(borderColor, sameBottom ? 0.24 : 1, left, top + height - bottomOuter, width, bottomOuter);

	const sideOuter = 2;
	fillAlpha(borderColor, sameLeft ? 0.22 : 0.62, left, top, sameLeft ? 1 : sideOuter, height);
	fillAlpha(borderColor, sameRight ? 0.22 : 0.62, left + width - (sameRight ? 1 : sideOuter), top, sameRight ? 1 : sideOuter, height);
}

function paintCells(canvas: HTMLCanvasElement, cells: Cells, cssSize: number) {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;

	const dpr = window.devicePixelRatio || 1;
	const bounds = getCellsBounds(cells);
	const cols = Math.max(1, bounds.maxX - bounds.minX + 1);
	const rows = Math.max(1, bounds.maxY - bounds.minY + 1);
	const grid = Math.max(cols, rows);
	const bitmapW = Math.max(1, Math.round(cssSize * dpr));
	const bitmapH = Math.max(1, Math.round(cssSize * dpr));

	if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
		canvas.width = bitmapW;
		canvas.height = bitmapH;
	}
	canvas.style.width = `${cssSize}px`;
	canvas.style.height = `${cssSize}px`;

	const cellW = bitmapW / grid;
	const cellH = bitmapH / grid;
	const offsetX = Math.round(((grid - cols) * cellW) / 2);
	const offsetY = Math.round(((grid - rows) * cellH) / 2);
	const xLines = Array.from({ length: cols + 1 }, (_, i) => Math.round(offsetX + i * cellW));
	const yLines = Array.from({ length: rows + 1 }, (_, i) => Math.round(offsetY + i * cellH));
	const colorAt = (y: number, x: number) => cells[toCellKey(y, x)];

	ctx.clearRect(0, 0, bitmapW, bitmapH);

	for (const [position, color] of Object.entries(cells)) {
		const { y, x } = parseCellKey(position);
		if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
		const localX = x - bounds.minX;
		const localY = y - bounds.minY;
		const left = xLines[localX];
		const top = yLines[localY];
		const right = xLines[localX + 1];
		const bottom = yLines[localY + 1];
		drawBlock(ctx, left, top, right - left, bottom - top, color, {
			top: colorAt(y - 1, x),
			right: colorAt(y, x + 1),
			bottom: colorAt(y + 1, x),
			left: colorAt(y, x - 1),
		});
	}
}

function isOverlayAlive(overlay: HTMLElement | null) {
	// 覆盖层被 main.tsx 移除，或已开始淡出时停止循环，避免淡出期间仍占 rAF/计时器
	return Boolean(overlay?.isConnected) && !overlay?.classList.contains("fade-out");
}

async function playOnce(canvas: HTMLCanvasElement, size: number, shouldContinue: () => boolean) {
	const frameMs = 1000 / LOGO_FPS;
	const paint = (cells: Cells) => {
		if (!shouldContinue()) return;
		paintCells(canvas, cells, size);
	};

	const hold = async (cells: Cells, ms: number) => {
		const frames = Math.max(1, Math.round(ms / frameMs));
		for (let i = 0; i < frames; i++) {
			if (!shouldContinue()) return;
			paint(cells);
			await sleep(frameMs);
			if (!shouldContinue()) return;
		}
	};

	let settled: Cells = {};
	await hold(settled, LOGO_TIMING.initialHold);
	if (!shouldContinue()) return;

	for (const step of LOGO_SEQUENCE) {
		if (!shouldContinue()) return;
		const piece = step.piece;
		// 启动页允许更少帧，避免被 min frames 拖回侧栏原速
		const frames = Math.max(Math.round(step.duration / frameMs), 4);
		for (let i = 0; i < frames; i++) {
			if (!shouldContinue()) return;
			const t = easeOutCubic((i + 1) / frames);
			const x = Math.round(piece.startX + (piece.targetX - piece.startX) * t);
			const y = Math.round(piece.startY + (piece.targetY - piece.startY) * t);
			const frame = copyCells(settled);
			mergePiece(frame, piece, x, y);
			paint(frame);
			await sleep(frameMs);
			if (!shouldContinue()) return;
		}
		mergePiece(settled, piece, piece.targetX, piece.targetY);
		paint(settled);
		await sleep(16);
		if (!shouldContinue()) return;
		if (step.holdAfter > 0) await hold(settled, step.holdAfter);
	}

	if (!shouldContinue()) return;

	const finalColor = settledLogoColor();
	for (let i = 0; i < LOGO_TIMING.clearFlashCount; i++) {
		if (!shouldContinue()) return;
		const flash = i % 2 === 0;
		const cells = copyCells(settled);
		for (const key of Object.keys(cells)) {
			if (cells[key] !== "flash") cells[key] = finalColor;
		}
		if (flash) {
			for (let x = 1; x <= 6; x++) cells[toCellKey(CLEAR_ROW, x)] = "flash";
		}
		await hold(cells, LOGO_TIMING.clearFlashStep);
	}

	if (!shouldContinue()) return;

	const floating: Cells = {};
	for (const [position] of Object.entries(settled)) {
		if (parseCellKey(position).y !== CLEAR_ROW) floating[position] = finalColor;
	}
	await hold(floating, LOGO_TIMING.postClearHold);
	if (!shouldContinue()) return;

	await hold(finalLogoCells(finalColor), LOGO_TIMING.postDropHold);
	if (!shouldContinue()) return;
	paint(finalLogoCells(finalColor));
}

function startBootLogoLoop() {
	const canvas = document.getElementById("boot-logo-canvas") as HTMLCanvasElement | null;
	const overlay = document.getElementById("boot-overlay");
	if (!canvas || !overlay) return;

	// 启动页视觉中心：比侧栏 34px 大很多，也比首版 96 更醒目
	const size = 148;
	const shouldContinue = () => isOverlayAlive(overlay);

	if (prefersReducedMotion()) {
		paintCells(canvas, finalLogoCells(settledLogoColor()), size);
		return;
	}

	// 主题切换（系统深浅色）时若正定格，下一轮会用新颜色；播放中不抢画布
	const onSchemeChange = () => {
		// 仅在空闲定格时刷新；循环里下一轮会自然用新色
		if (!shouldContinue()) return;
	};
	const mq = window.matchMedia("(prefers-color-scheme: dark)");
	mq.addEventListener?.("change", onSchemeChange);

	void (async () => {
		try {
			while (shouldContinue()) {
				await playOnce(canvas, size, shouldContinue);
				if (!shouldContinue()) break;
				await sleep(LOGO_TIMING.loopGapMs);
			}
		} catch {
			// 启动页卸载时忽略
		} finally {
			mq.removeEventListener?.("change", onSchemeChange);
		}
	})();
}

// 尽早开播：DOM 已有 canvas 时立即跑，否则等 DOMContentLoaded
if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", startBootLogoLoop, { once: true });
} else {
	startBootLogoLoop();
}
