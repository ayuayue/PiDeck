import { useEffect, useRef } from "react";
import type { PetAggregateState, PetManifest, PetMode, PetNotification } from "@shared/types";
import { type SpriteSheet, MODE_ROW, MODE_FRAMES, CELL_W, CELL_H } from "./PetSpriteSheet";

/**
 * Canvas + requestAnimationFrame 精灵动画，GPU 绘制零 React re-render 开销。
 * 统一帧率 12fps / 8fps(idle)，通知气泡直接在 Canvas 顶部绘制。
 */

const DEFAULT_FPS = 12;
const IDLE_FPS = 8;
const PAUSE_MS: Record<string, number> = { idle: 3000, failed: 4000 };

type Props = {
	sprite: SpriteSheet | null;
	manifest: PetManifest | null;
	state: PetAggregateState;
	dragging?: boolean;
	notification?: PetNotification | null;
};

export function PetOverlay({ sprite, state, dragging, notification }: Props) {
	const mode = state.mode;
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const dragRef = useRef(dragging);
	dragRef.current = dragging;
	const notifRef = useRef(notification);
	notifRef.current = notification;

	useEffect(() => {
		if (mode === "hidden" || !sprite) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d", { alpha: true });
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const dw = canvas.clientWidth, dh = canvas.clientHeight;
		const tw = dw * dpr, th = dh * dpr;
		// 仅在尺寸变化时重置 Canvas（重置会清空内容，造成模式切换闪烁）
		if (canvas.width !== tw || canvas.height !== th) {
			canvas.width = tw;
			canvas.height = th;
		}

		const row = MODE_ROW[mode] ?? 0;
		const totalFrames = MODE_FRAMES[mode] ?? 8;
		const fps = mode === "idle" ? IDLE_FPS : DEFAULT_FPS;
		const frameMs = 1000 / fps;
		const pauseMs = PAUSE_MS[mode] ?? 0;

		let col = 0, nextCol = 1;
		let lastT = performance.now();
		let acc = 0;
		let paused = false, pauseAcc = 0;
		let alive = true;
		let rafId = 0;

		const draw = (c: number) => {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(sprite.image, c * CELL_W, row * CELL_H, CELL_W, CELL_H, 0, 0, canvas.width, canvas.height);
		};

		const drawNotif = () => {
			const n = notifRef.current;
			if (!n) return;
			const elapsed = performance.now() - n.timestamp;
			if (elapsed < 0) return;
			const FADE_IN = 250, FADE_OUT = 500, TOTAL = 4000;
			let alpha = 1;
			if (elapsed < FADE_IN) alpha = elapsed / FADE_IN;
			else if (elapsed > TOTAL - FADE_OUT) alpha = Math.max(0, (TOTAL - elapsed) / FADE_OUT);
			if (alpha <= 0) return;

			const isErr = n.type === "error";
			const textColor = isErr ? "#dc2626" : "#22c55e";
			const ps = dw / 160; // petScale
			const fontSize = Math.round(14 * dpr * ps);
			ctx.save();
			ctx.globalAlpha = alpha;
			ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;

			const maxW = dw * dpr - 24 * dpr * ps;
			const px = 14 * dpr * ps, py = 8 * dpr * ps;
			const lines = wrapText(ctx, n.text, maxW - px * 2);
			const lineH = fontSize * 1.5;
			const textH = lines.length * lineH;
			const bw = Math.max(...lines.map(l => ctx.measureText(l).width)) + px * 2;
			const bh = textH + py * 2;
			const bx = (dw * dpr - bw) / 2;
			const by = dh * dpr - bh - 6 * dpr * ps;
			const rad = 10 * dpr * ps;

			ctx.fillStyle = "rgba(255,255,255,0.95)";
			ctx.beginPath();
			rndRect(ctx, bx, by, bw, bh, rad);
			ctx.fill();
			ctx.strokeStyle = "#1a1d24";
			ctx.lineWidth = 1.5 * dpr * ps;
			ctx.setLineDash([3 * dpr * ps, 3 * dpr * ps]);
			ctx.stroke();
			ctx.setLineDash([]);

			ctx.fillStyle = textColor;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			for (let i = 0; i < lines.length; i++) {
				ctx.fillText(lines[i], bx + bw / 2, by + py + lineH * i + lineH / 2);
			}
			ctx.restore();
		};

		const tick = () => {
			draw(col);
			drawNotif();
		};

		const loop = (now: number) => {
			if (!alive) return;
			rafId = requestAnimationFrame(loop);
			if (dragRef.current) { lastT = now; return; }
			const delta = now - lastT;
			lastT = now;

			if (paused) {
				pauseAcc += delta;
				if (pauseAcc >= pauseMs) { paused = false; pauseAcc = 0; nextCol = 1; col = 0; acc = 0; }
				tick();
				return;
			}

			acc += delta;
			if (acc > frameMs * totalFrames) acc = frameMs * totalFrames; // 防跳帧

			while (acc >= frameMs) {
				acc -= frameMs;
				col = nextCol;
				nextCol = (nextCol + 1) % totalFrames;
				if (nextCol === 0 && pauseMs > 0) { paused = true; pauseAcc = 0; break; }
			}
			tick();
		};

		tick();
		rafId = requestAnimationFrame(loop);
		return () => { alive = false; cancelAnimationFrame(rafId); };
	}, [sprite, mode]);

	if (mode === "hidden") return <div style={{ width: "100%", height: "100%", background: "transparent" }} />;

	if (sprite) {
		return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", imageRendering: "pixelated" }} />;
	}

	return <FallbackCanvas mode={mode} />;
}

// ═══ 工具函数 ═══

function rndRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
	ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
	ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r);
	ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h);
	ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r);
	ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
	if (maxW <= 0 || ctx.measureText(text).width <= maxW) return [text];
	const lines: string[] = [];
	const words = text.split(" ");
	let cur = "";
	for (const word of words) {
		const trial = cur ? cur + " " + word : word;
		if (ctx.measureText(trial).width <= maxW) { cur = trial; continue; }
		if (cur) { lines.push(cur); cur = ""; }
		if (ctx.measureText(word).width <= maxW) { cur = word; continue; }
		let chunk = "";
		for (const ch of word) {
			if (ctx.measureText(chunk + ch).width > maxW && chunk) { lines.push(chunk); chunk = ch; }
			else chunk += ch;
		}
		cur = chunk;
	}
	if (cur) lines.push(cur);
	return lines;
}

// ═══ 降级（无素材时） ═══

const FALLBACK: Record<PetMode, { color: string; emoji: string }> = {
	idle: { color: "#8a909c", emoji: "😌" },
	running: { color: "#16a34a", emoji: "⚙️" },
	failed: { color: "#dc2626", emoji: "😥" },
	waiting: { color: "#b45309", emoji: "🥺" },
	waving: { color: "#2563eb", emoji: "👋" },
	jumping: { color: "#8b5cf6", emoji: "🤸" },
	"running-right": { color: "#16a34a", emoji: "🏃" },
	"running-left": { color: "#16a34a", emoji: "🏃‍♂️" },
	review: { color: "#2563eb", emoji: "🔍" },
	hidden: { color: "#8a909c", emoji: "" },
};

function FallbackCanvas({ mode }: { mode: PetMode }) {
	const ref = useRef<HTMLCanvasElement>(null);
	const frame = useRef(0);

	useEffect(() => {
		const c = ref.current;
		if (!c) return;
		const ctx = c.getContext("2d");
		if (!ctx) return;
		const dpr = window.devicePixelRatio || 1;
		const W = (c.width = c.clientWidth * dpr), H = (c.height = c.clientHeight * dpr);
		const fb = FALLBACK[mode] ?? FALLBACK.idle;
		let raf = 0;
		const loop = () => {
			raf = requestAnimationFrame(loop);
			const f = ++frame.current;
			const cx = W / 2, cy = H / 2, r = Math.min(W, H) * 0.36;
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
				ctx.textAlign = "center"; ctx.textBaseline = "middle";
				ctx.fillText(fb.emoji, cx, cy);
			}
		};
		raf = requestAnimationFrame(loop);
		return () => cancelAnimationFrame(raf);
	}, [mode]);

	return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}
