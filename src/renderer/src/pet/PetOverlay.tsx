import { useEffect, useRef } from "react";
import type { PetAggregateState, PetManifest, PetMode } from "@shared/types";
import { MODE_ROW, type SpriteSheet } from "./PetSpriteSheet";

/**
 * PetOverlay —— Canvas 精灵图切帧渲染（设计文档第 6.1 节）。
 *
 * 按 mode 选行，循环切帧（0..7）以 10fps 播放；idle 降到 6fps 省电。
 * spritesheet 加载失败时降级为「状态色圆 + emoji」程序化绘制，保证无素材也能显示状态。
 */

const FRAMES_PER_ROW = 8;
const FPS_ACTIVE = 10;
const FPS_IDLE = 6;

/** 状态降级配色（无 sprite 时用） */
const FALLBACK: Record<PetMode, { color: string; emoji: string }> = {
	idle: { color: "#8a909c", emoji: "😌" },
	running: { color: "#16a34a", emoji: "⚙️" },
	failed: { color: "#dc2626", emoji: "😥" },
	waiting: { color: "#b45309", emoji: "🥺" },
	waving: { color: "#2563eb", emoji: "👋" },
	hidden: { color: "#8a909c", emoji: "" },
};

type Props = {
	sprite: SpriteSheet | null;
	manifest: PetManifest | null;
	state: PetAggregateState;
	/** 拖拽中暂停动画，避免移动时帧抖动 */
	dragging?: boolean;
};

export function PetOverlay({ sprite, manifest, state, dragging }: Props) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	// 用 ref 保存最新值，避免帧循环依赖频繁重建
	const stateRef = useRef(state);
	stateRef.current = state;
	const spriteRef = useRef(sprite);
	spriteRef.current = sprite;
	const draggingRef = useRef(dragging);
	draggingRef.current = dragging;

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d");
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const W = canvas.width = canvas.clientWidth * dpr;
		const H = canvas.height = canvas.clientHeight * dpr;

		let frame = 0;
		let lastTs = 0;
		let rafId = 0;

		const draw = (ts: number) => {
			rafId = requestAnimationFrame(draw);
			const s = stateRef.current;
			const mode = s.mode;
			if (mode === "hidden") {
				// hidden 态暂停渲染循环，清屏即可
				ctx.clearRect(0, 0, W, H);
				return;
			}

			// idle 降频省电；running/failed 维持 10fps；拖拽中暂停切帧
			const fps = mode === "idle" ? FPS_IDLE : FPS_ACTIVE;
			const interval = 1000 / fps;
			if (!draggingRef.current && ts - lastTs >= interval) {
				frame = (frame + 1) % FRAMES_PER_ROW;
				lastTs = ts;
			}

			ctx.clearRect(0, 0, W, H);
			const sp = spriteRef.current;

			if (sp) {
				// 精灵图切帧
				const row = MODE_ROW[mode] ?? 0;
				const sx = (frame % sp.cols) * sp.cellW;
				const sy = row * sp.cellH;
				// drawImage 把单格缩放到整个 canvas
				ctx.imageSmoothingEnabled = true;
				ctx.imageSmoothingQuality = "high";
				ctx.drawImage(sp.image, sx, sy, sp.cellW, sp.cellH, 0, 0, W, H);
			} else {
				// 降级绘制：状态色圆 + emoji + 帧间呼吸缩放
				const fb = FALLBACK[mode] ?? FALLBACK.idle;
				const cx = W / 2;
				const cy = H / 2;
				const baseR = Math.min(W, H) * 0.36;
				const pulse = mode === "running" || mode === "failed" ? 1 + 0.06 * Math.sin(frame * 0.8) : 1 + 0.03 * Math.sin(frame * 0.5);
				ctx.beginPath();
				ctx.arc(cx, cy, baseR * pulse, 0, Math.PI * 2);
				ctx.fillStyle = fb.color;
				ctx.globalAlpha = mode === "failed" ? (frame % 2 === 0 ? 0.95 : 0.6) : 0.92;
				ctx.fill();
				ctx.globalAlpha = 1;
				if (fb.emoji) {
					ctx.font = `${Math.round(baseR * 0.9)}px system-ui, sans-serif`;
					ctx.textAlign = "center";
					ctx.textBaseline = "middle";
					ctx.fillText(fb.emoji, cx, cy);
				}
			}
		};
		rafId = requestAnimationFrame(draw);
		return () => cancelAnimationFrame(rafId);
	}, []);

	// manifest 仅用于未来按宠物切换 sprite 的依赖追踪，当前 sprite 由父组件加载传入
	void manifest;

	return (
		<canvas
			ref={canvasRef}
			style={{ width: "100%", height: "100%", display: "block" }}
			aria-label="PiDeck desktop pet"
		/>
	);
}