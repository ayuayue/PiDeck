import { useCallback, useEffect, useRef } from "react";
import { useAtomValue } from "jotai";
import { appDisplayNameAtom, customLogoAtom, logoStyleAtom } from "../../atoms/app-ui-atoms";
import type { LogoStyle } from "../../../../shared/types/settings";
import { PI_TUI_COLORS, PI_TUI_LOGO_CELLS, PI_TUI_PIECES, type PiTuiColorKey } from "./piTuiLogoData";

/** 订阅 logo 风格镜像 atom；Web 独立环境无人写入 → 恒取 atom 默认（pi-tui），与桌面默认品牌位一致。 */
export function useLogoStyle(): LogoStyle {
	return useAtomValue(logoStyleAtom);
}

/**
 * 品牌位统一取值（渲染落点专用）：把「风格 + 自定义图」两个 atom 收敛成一个判定，避免每个落点各写一套回落规则。
 * - `customLogo` 非空 = 当前就是自定义且已上传图 → 落点渲染用户图；
 * - `style` 只可能是内置两档：非 classic（含 custom）一律按 **pi-tui**（应用默认品牌位）处理，
 *   与 shared `resolveLogoStyle` 及主进程窗口/托盘图标的回落一致，custom 缺图时不能落回 classic。
 * 落点写法保持 `const { style: logoStyle, customLogo } = useBrandGlyph();`，沿用 `logoStyle === "pi-tui" ? … : …` 既有分支形态。
 */
export function useBrandGlyph(): { style: "classic" | "pi-tui"; customLogo: string } {
	const style = useAtomValue(logoStyleAtom);
	const customLogo = useAtomValue(customLogoAtom);
	const hasCustomLogo = style === "custom" && customLogo.length > 0;
	return { style: style === "classic" ? "classic" : "pi-tui", customLogo: hasCustomLogo ? customLogo : "" };
}

/** 订阅应用显示名称（已解析）；品牌区与「关于」弹层用，未设置时就是 PiDeck。 */
export function useAppDisplayName(): string {
	return useAtomValue(appDisplayNameAtom);
}

/**
 * pi 官方 TUI logo 的静态 SVG 复刻（透明底，品牌色固定不随明暗）。
 * 位图与颜色来自 piTuiLogo.ts（对齐 pi 源码 pi-logo.ts）。
 */
export function PiTuiLogoMark({ size = 32, className }: { size?: number; className?: string }) {
	// 官方 TUI 用半块字符渲染 4×4 位图（每字符=上下两个正方形像素）→ 位图本身 1:1 正方形；
	// 曾误按「2 行字符」把高度压成 3/4，品牌区 logo 被压扁/留白（2026-12 用户反馈修正）。
	return (
		<svg viewBox="0 0 4 4" width={size} height={size} className={className} aria-hidden="true" shapeRendering="crispEdges">
			{Object.entries(PI_TUI_LOGO_CELLS).map(([key, color]) => {
				const [y, x] = key.split(":").map(Number);
				return <rect key={key} x={x} y={y} width={1} height={1} fill={PI_TUI_COLORS[color]} />;
			})}
		</svg>
	);
}

type Cells = Record<string, PiTuiColorKey>;

function mergePiece(cells: Cells, pieceIndex: number, y: number): Cells {
	const piece = PI_TUI_PIECES[pieceIndex];
	const next = { ...cells };
	for (const [dy, dx] of piece.cells) {
		next[`${y + dy}:${dx}`] = piece.color;
	}
	return next;
}

function settledCells(): Cells {
	return { ...PI_TUI_LOGO_CELLS };
}

function drawBlock(ctx: CanvasRenderingContext2D, left: number, top: number, width: number, height: number, color: PiTuiColorKey, neighbors: { top?: string; right?: string; bottom?: string; left?: string }) {
	ctx.globalAlpha = 1;
	ctx.fillStyle = PI_TUI_COLORS[color];
	ctx.fillRect(left, top, width, height);
	// 小尺寸退化为平面块（与 PiLogoCanvas 同阈值），避免 bevel 糊成灰斑
	if (width < 5 || height < 5) return;

	const sameTop = neighbors.top === color;
	const sameBottom = neighbors.bottom === color;
	const sameLeft = neighbors.left === color;
	const sameRight = neighbors.right === color;
	const edge = Math.max(1, Math.round(width * 0.16));
	const alphaFill = (fill: string, alpha: number, x: number, y: number, w: number, h: number) => {
		if (w <= 0 || h <= 0) return;
		ctx.globalAlpha = alpha;
		ctx.fillStyle = fill;
		ctx.fillRect(x, y, w, h);
		ctx.globalAlpha = 1;
	};
	// 面：上亮下暗的轻微立体；边：与相邻同色块之间不描线（拼成整体）
	const faceTopH = Math.max(1, Math.floor(height * 0.55));
	alphaFill("#ffffff", 0.1, left + edge, top + edge, width - edge * 2, faceTopH);
	alphaFill("#000000", 0.08, left + edge, top + edge + faceTopH, width - edge * 2, height - edge * 2 - faceTopH);
	if (!sameTop) alphaFill("#ffffff", 0.22, left, top, width, 1);
	if (!sameBottom) alphaFill("#000000", 0.28, left, top + height - edge, width, edge);
	if (!sameLeft) alphaFill("#000000", 0.14, left, top, edge, height);
	if (!sameRight) alphaFill("#000000", 0.14, left + width - edge, top, edge, height);
}

function paintCells(canvas: HTMLCanvasElement, cells: Cells, cssSize: number) {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	// 位图恒为 4×4 正方形（上方留空行只出现在动画途中，定格/静态都是满格）
	const grid = 4;
	const dpr = window.devicePixelRatio || 1;
	const bitmap = Math.max(1, Math.round(cssSize * dpr));
	if (canvas.width !== bitmap || canvas.height !== bitmap) {
		canvas.width = bitmap;
		canvas.height = bitmap;
	}
	// CSS 尺寸必须 1:1：缓冲是正方形，CSS 压成 4:3 会被浏览器纵向挤扁（曾按「2 行字符」误算）
	const cssW = cssSize;
	const cssH = cssSize;
	canvas.style.width = `${cssW}px`;
	canvas.style.height = `${cssH}px`;
	const cell = bitmap / grid;
	const lines = Array.from({ length: grid + 1 }, (_, i) => Math.round(i * cell));
	const colorAt = (y: number, x: number) => cells[`${y}:${x}`];

	ctx.clearRect(0, 0, bitmap, bitmap);
	for (const [key, color] of Object.entries(cells)) {
		const [y, x] = key.split(":").map(Number);
		if (y < 0 || y >= grid || x < 0 || x >= grid) continue;
		const left = lines[x];
		const top = lines[y];
		drawBlock(ctx, left, top, lines[x + 1] - left, lines[y + 1] - top, color, {
			top: colorAt(y - 1, x),
			right: colorAt(y, x + 1),
			bottom: colorAt(y + 1, x),
			left: colorAt(y, x - 1),
		});
	}
}

function prefersReducedMotion() {
	return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function sleep(ms: number) {
	return new Promise<void>((resolve) => {
		window.setTimeout(() => resolve(), ms);
	});
}

const LOGO_FPS = 24;
const PIECE_DURATION_MS = 130;
const HOLD_AFTER_MS = 60;
const INITIAL_HOLD_MS = 40;

function easeOutCubic(t: number) {
	return 1 - (1 - t) ** 3;
}

export type PiTuiLogoCanvasProps = {
	/** 画布 CSS 宽高（位图 1:1 正方形） */
	size?: number;
	/** 点击是否重播落位动画；默认 true，与 PiLogoCanvas 侧栏品牌位行为一致 */
	playOnClick?: boolean;
	className?: string;
};

/**
 * pi 官方 TUI logo 的 canvas 动画版：默认定格三色位图，点击播三块落位动画。
 * 与 PiLogoCanvas（classic 四块拼图）平行的 pi-tui 品牌位，由 logoStyleAtom 的消费方分支渲染。
 */
export function PiTuiLogoCanvas(props: PiTuiLogoCanvasProps) {
	const size = props.size ?? 32;
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const busyRef = useRef(false);
	const playGenRef = useRef(0);
	const pendingReplayRef = useRef(false);

	const showStatic = useCallback(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		paintCells(canvas, settledCells(), size);
	}, [size]);

	const playIntro = useCallback(async () => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		if (prefersReducedMotion()) {
			showStatic();
			return;
		}
		if (busyRef.current) {
			pendingReplayRef.current = true;
			return;
		}
		const gen = playGenRef.current;
		busyRef.current = true;
		const isAlive = () => playGenRef.current === gen;
		const frameMs = 1000 / LOGO_FPS;
		const paint = (cells: Cells) => {
			if (isAlive()) paintCells(canvas, cells, size);
		};
		const hold = async (cells: Cells, ms: number) => {
			const frames = Math.max(1, Math.round(ms / frameMs));
			for (let i = 0; i < frames; i++) {
				if (!isAlive()) return;
				paint(cells);
				await sleep(frameMs);
				if (!isAlive()) return;
			}
		};

		try {
			let settled: Cells = {};
			await hold(settled, INITIAL_HOLD_MS);
			if (!isAlive()) return;
			for (const [index] of PI_TUI_PIECES.entries()) {
				const piece = PI_TUI_PIECES[index];
				const frames = Math.max(3, Math.round(PIECE_DURATION_MS / frameMs));
				for (let i = 0; i < frames; i++) {
					if (!isAlive()) return;
					const t = easeOutCubic((i + 1) / frames);
					const y = Math.round(piece.startY + (piece.targetY - piece.startY) * t);
					paint(mergePiece(settled, index, y));
					await sleep(frameMs);
					if (!isAlive()) return;
				}
				settled = mergePiece(settled, index, piece.targetY);
				paint(settled);
				if (!isAlive()) return;
				await hold(settled, HOLD_AFTER_MS);
				if (!isAlive()) return;
			}
			paint(settledCells());
		} finally {
			busyRef.current = false;
			if (pendingReplayRef.current && isAlive()) {
				pendingReplayRef.current = false;
				void playIntro();
			}
		}
	}, [showStatic, size]);

	useEffect(() => {
		showStatic();
		return () => {
			// 卸载时作废在途播放世代，避免旧轮醒来继续写画布
			playGenRef.current += 1;
		};
	}, [showStatic]);

	const playOnClick = props.playOnClick ?? true;
	return <canvas ref={canvasRef} className={props.className} onClick={playOnClick ? () => void playIntro() : undefined} aria-hidden="true" />;
}
