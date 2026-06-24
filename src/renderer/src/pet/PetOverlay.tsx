import { useEffect, useRef, useState } from "react";
import type { PetAggregateState, PetManifest, PetMode } from "@shared/types";
import { type SpriteSheet } from "./PetSpriteSheet";

/**
 * PetOverlay —— CSS background-position 精灵图动画（完全匹配 petdex-desktop 方案）。
 *
 * 核心改变：useEffect 依赖 [sprite, mode]，换模式时重建 setTimeout 链，
 * 避免 frameIdx 越界 + 确保新模式的帧序列正确启动。
 *
 * 帧时序表（来源：petdex-desktop STATES）：
 *   idle:    6帧, d=[1680,660,660,840,840,1920]
 *   running: 6帧, d=120×5+220=820ms
 *   failed:  8帧, d=140×7+240=1220ms
 *   waiting: 6帧, d=150×5+260=1010ms
 *   waving:  4帧, d=140×3+280=700ms
 */

const COLS = 8;
const ROWS = 9;

function buildEvenFrames(count: number, dur: number, last: number) {
	return Array.from({ length: count }, (_, i) => ({
		c: i,
		d: i === count - 1 ? last : dur,
	}));
}

/** petdex 各状态帧定义 */
const STATE_DEFS: Record<string, { row: number; frames: { c: number; d: number }[] }> = {
	idle: {
		row: 0,
		frames: [
			{ c: 0, d: 1680 },
			{ c: 1, d: 660 },
			{ c: 2, d: 660 },
			{ c: 3, d: 840 },
			{ c: 4, d: 840 },
			{ c: 5, d: 1920 },
		],
	},
	running:      { row: 7, frames: buildEvenFrames(6, 120, 220) },
	"running-right": { row: 1, frames: buildEvenFrames(8, 120, 220) },
	"running-left":  { row: 2, frames: buildEvenFrames(8, 120, 220) },
	jumping:     { row: 4, frames: buildEvenFrames(5, 140, 280) },
	review:      { row: 8, frames: buildEvenFrames(6, 150, 280) },
	failed:      { row: 5, frames: buildEvenFrames(8, 140, 240) },
	waiting:     { row: 6, frames: buildEvenFrames(6, 150, 260) },
	waving:      { row: 3, frames: buildEvenFrames(4, 140, 280) },
};

/** petdex 定位公式：cell(col,row) → background-position */
function bgPos(col: number, row: number): string {
	return `${(col / (COLS - 1)) * 100}% ${(row / (ROWS - 1)) * 100}%`;
}

type Props = {
	sprite: SpriteSheet | null;
	manifest: PetManifest | null;
	state: PetAggregateState;
	dragging?: boolean;
};

export function PetOverlay({ sprite, manifest, state, dragging }: Props) {
	void manifest;
	const mode = state.mode;
	const draggingRef = useRef(dragging);
	draggingRef.current = dragging;

	// 当前显示的列号
	const [col, setCol] = useState(0);

	// 模式变化时重建 setTimeout 链
	useEffect(() => {
		if (mode === "hidden" || !sprite) return;

		const def = STATE_DEFS[mode] ?? STATE_DEFS.idle;
		const frames = def.frames;
		let idx = 0;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let alive = true;

		const tick = () => {
			if (!alive || !sprite) return;
			if (draggingRef.current) {
				timer = setTimeout(tick, 100);
				return;
			}
			const f = frames[idx];
			setCol(f.c);
			idx = (idx + 1) % frames.length;
			// frames[idx] 是「显示当前帧后等多久」，当前帧是 f，
			// 显示 f 后等 f.d ms 再切下一帧
			timer = setTimeout(tick, f.d);
		};

		// 立即显示首帧
		setCol(frames[0].c);
		timer = setTimeout(tick, frames[0].d);

		return () => {
			alive = false;
			if (timer) clearTimeout(timer);
		};
	}, [sprite, mode]);

	// ── hidden ──
	if (mode === "hidden") {
		return <div style={{ width: "100%", height: "100%", background: "transparent" }} />;
	}

	// ── 有 sprite：CSS background-position ──
	if (sprite) {
		const def = STATE_DEFS[mode] ?? STATE_DEFS.idle;
		return (
			<div
				style={{
					width: "100%",
					height: "100%",
					backgroundImage: `url(${sprite.url ?? ""})`,
					backgroundRepeat: "no-repeat",
					backgroundSize: `${COLS * 100}% ${ROWS * 100}%`,
					backgroundPosition: bgPos(col, def.row),
					imageRendering: "pixelated",
				}}
			/>
		);
	}

	// ── 无 sprite 降级 ──
	return <FallbackCanvas mode={mode} />;
}

// ── 降级（无素材时） ──

const FALLBACK: Record<PetMode, { color: string; emoji: string }> = {
	idle: { color: "#8a909c", emoji: "😌" },
	running: { color: "#16a34a", emoji: "⚙️" },
	failed: { color: "#dc2626", emoji: "😥" },
	waiting: { color: "#b45309", emoji: "🥺" },
	waving: { color: "#2563eb", emoji: "👋" },
	hidden: { color: "#8a909c", emoji: "" },
};

function FallbackCanvas({ mode }: { mode: PetMode }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const frameRef = useRef(0);

	useEffect(() => {
		const c = canvasRef.current;
		if (!c) return;
		const ctx = c.getContext("2d");
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const W = (c.width = c.clientWidth * dpr);
		const H = (c.height = c.clientHeight * dpr);
		const fb = FALLBACK[mode] ?? FALLBACK.idle;
		let raf = 0;
		const loop = () => {
			raf = requestAnimationFrame(loop);
			const f = ++frameRef.current;
			const cx = W / 2, cy = H / 2;
			const r = Math.min(W, H) * 0.36;
			const pulse = mode === "running" || mode === "failed" ? 1 + 0.06 * Math.sin(f * 0.8) : 1 + 0.03 * Math.sin(f * 0.5);
			ctx.clearRect(0, 0, W, H);
			ctx.beginPath();
			ctx.arc(cx, cy, r * pulse, 0, Math.PI * 2);
			ctx.fillStyle = fb.color;
			ctx.globalAlpha = mode === "failed" ? (f % 2 === 0 ? 0.95 : 0.6) : 0.92;
			ctx.fill();
			ctx.globalAlpha = 1;
			if (fb.emoji) {
				ctx.font = `${Math.round(r * 0.9)}px system-ui, sans-serif`;
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(fb.emoji, cx, cy);
			}
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [mode]);

	return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />;
}
