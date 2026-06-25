import { useEffect, useRef } from "react";
import type { PetAggregateState, PetManifest, PetMode, PetNotification } from "@shared/types";
import { type SpriteSheet, CELL_W, CELL_H } from "./PetSpriteSheet";

/**
 * PetOverlay —— Canvas + requestAnimationFrame 精灵图动画。
 *
 * 相比旧版 CSS background-position + setTimeout 方案的关键优化：
 *  1. rAF 驱动 → 与屏幕刷新同步，消除 setTimeout 帧时序抖动
 *  2. Canvas drawImage → 直接 GPU 绘制，零 React re-render 开销
 *  3. 统一帧率 12fps / 8fps(idle) → 远高于 petdex 的 ~0.15–7.3fps
 *  4. Delta-time 累加 → 精确帧时序，适配不同显示器刷新率
 *  5. useRef 追踪帧索引 → state 不变更就不触发 render，纯 Canvas 绘制
 *  6. 通知气泡直接画在 Canvas 顶部 → 不会覆盖宠物图像，三端一致
 *
 * 帧映射（设计文档 §3.2）：
 *  idle=row0(6帧) / running=row7(6帧) / failed=row5(8帧)
 *  waiting=row6(6帧) / waving=row3(4帧)
 */

/** 默认帧率（除 idle 外） */
const DEFAULT_FPS = 12;
/** idle 态降帧省电 */
const IDLE_FPS = 8;

/** 每轮动画循环后的暂停时长（ms），idle 加长间隔让宠物安分 */
const PAUSE_BETWEEN_CYCLES: Record<string, number> = {
	idle: 3000, // 空闲时每轮动画后暂停 3 秒再播下一轮
	failed: 4000, // 失败态播一轮后暂停 4 秒，不无休止循环
	// 其他模式不暂停，连续播放
};

/** mode → spritesheet 行号；未列出的巡游/跳跃等预留行返回 row 0 */
const MODE_ROW: Record<string, number> = {
	idle: 0,
	running: 7,
	failed: 5,
	waiting: 6,
	waving: 3,
	"running-right": 1,
	"running-left": 2,
	jumping: 4,
	review: 8,
};

/** mode → 使用帧数（连续取 spritesheet 前 N 列，列索引 0..N-1） */
const MODE_FRAMES: Record<string, number> = {
	idle: 6,
	running: 6,
	failed: 8,
	waiting: 6,
	waving: 4,
	"running-right": 8,
	"running-left": 8,
	jumping: 5,
	review: 6,
};

type Props = {
	sprite: SpriteSheet | null;
	manifest: PetManifest | null;
	state: PetAggregateState;
	dragging?: boolean;
	/** 通知气泡：出错/完成时在宠物头顶弹窗，Canvas 绘制确保不覆盖图像 */
	notification?: PetNotification | null;
};

export function PetOverlay({ sprite, manifest, state, dragging, notification }: Props) {
	void manifest;
	const mode = state.mode;
	const canvasRef = useRef<HTMLCanvasElement>(null);

	// 拖拽中冻结动画，用 ref 避免触发 effect 重建
	const draggingRef = useRef(dragging);
	draggingRef.current = dragging;

	// 通知气泡用 ref 追踪，不纳入 effect 依赖（气泡变化无需重建动画循环）
	const notifRef = useRef(notification);
	notifRef.current = notification;

	// ── Canvas rAF 动画循环：mode 或 sprite 变化时重建 ──
	useEffect(() => {
		if (mode === "hidden" || !sprite) return;

		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d", { alpha: true });
		if (!ctx) return;

		const dpr = window.devicePixelRatio || 1;
		const displayW = canvas.clientWidth;
		const displayH = canvas.clientHeight;

		// Canvas 缓冲区设为物理像素，Retina 清晰
		canvas.width = displayW * dpr;
		canvas.height = displayH * dpr;

		const row = MODE_ROW[mode] ?? 0;
		const totalFrames = MODE_FRAMES[mode] ?? 8;
		const fps = mode === "idle" ? IDLE_FPS : DEFAULT_FPS;
		const frameInterval = 1000 / fps;

		const pauseMs = PAUSE_BETWEEN_CYCLES[mode] ?? 0;
		let frameIdx = 1; // 下一帧要显示的列号（首帧 0 已在初始化时绘制）
		let currentCol = 0; // 当前正在显示的列号（每帧重绘用）
		let lastTime = performance.now();
		let accumulator = 0;
		let rafId = 0;
		let alive = true;
		let isPausing = false;
		let pauseAccumulator = 0;

		/** 绘制指定帧：从 spritesheet 切出单格，拉伸铺满 Canvas */
		const drawFrame = (col: number) => {
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.drawImage(
				sprite.image,
				col * CELL_W, row * CELL_H, CELL_W, CELL_H,
				0, 0, canvas.width, canvas.height,
			);
		};

		/** 在 Canvas 底部叠加通知气泡（不压缩 sprite，允许自然重叠）。
		 *  样式：白色内部 + 黑色虚线描边，缝线感设计；整体线性淡入淡出。 */
		const drawNotification = () => {
			const n = notifRef.current;
			if (!n) return;

			// 线性淡入淡出：前 250ms 淡入，最后 500ms 淡出
			const FADE_IN_MS = 250;
			const FADE_OUT_MS = 500;
			const TOTAL_MS = 4000;
			const elapsed = performance.now() - n.timestamp;
			if (elapsed < 0) return; // 时间戳尚未就绪
			let alpha = 1;
			if (elapsed < FADE_IN_MS) {
				alpha = elapsed / FADE_IN_MS;
			} else if (elapsed > TOTAL_MS - FADE_OUT_MS) {
				alpha = Math.max(0, (TOTAL_MS - elapsed) / FADE_OUT_MS);
			}
			if (alpha <= 0) return;

			const isError = n.type === "error";
		const textColor = isError ? "#dc2626" : "#22c55e";

		// 气泡尺寸随 pet 缩放（displayW 已含 petScale，除以基准宽 160 得缩放因子）
		const petScale = displayW / 160;
		const fontSize = Math.round(14 * dpr * petScale);
		ctx.save();
		ctx.globalAlpha = alpha;
		ctx.font = `600 ${fontSize}px -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif`;

		// 气泡最大宽度：Canvas 宽减去两侧留白，避免超出宠物窗边界被截断
		const maxBubbleW = displayW * dpr - 24 * dpr * petScale;
		const padX = 14 * dpr * petScale;
		const padY = 8 * dpr * petScale;

		// 自动换行：超宽时拆分为多行，保证不截断
		const lines = wrapText(ctx, n.text, maxBubbleW - padX * 2);
		const lineHeight = fontSize * 1.5;
		const totalTextH = lines.length * lineHeight;
		const bubbleH = totalTextH + padY * 2;

		// 取最宽行作为气泡宽度
		const lineWidths = lines.map(l => ctx.measureText(l).width);
		const bubbleW = Math.max(...lineWidths) + padX * 2;
		const bubbleX = (displayW * dpr - bubbleW) / 2;
		const bubbleY = displayH * dpr - bubbleH - 6 * dpr * petScale;
		const radius = 10 * dpr * petScale;

		// 白色背景（无阴影，避免边缘发虚）
		ctx.fillStyle = "rgba(255,255,255,0.95)";
		ctx.beginPath();
		rndRect(ctx, bubbleX, bubbleY, bubbleW, bubbleH, radius);
		ctx.fill();

		// 黑色虚线描边（缝线样式）
		ctx.strokeStyle = "#1a1d24";
		ctx.lineWidth = 1.5 * dpr * petScale;
		ctx.setLineDash([3 * dpr * petScale, 3 * dpr * petScale]);
		ctx.stroke();
		ctx.setLineDash([]);

		// 逐行绘制文字
		ctx.fillStyle = textColor;
		ctx.textAlign = "center";
		ctx.textBaseline = "middle";
		for (let i = 0; i < lines.length; i++) {
			const ly = bubbleY + padY + lineHeight * i + lineHeight / 2;
			ctx.fillText(lines[i], bubbleX + bubbleW / 2, ly);
		}

			ctx.restore();
		};

		/** rAF 循环：按帧率推进 sprite 帧索引，但每个 rAF tick 都重绘
		 *  （清屏 + sprite + 通知气泡），避免通知气泡在未清屏帧上累积叠加导致闪烁。
		 *  每播完一轮完整动画后，若配置了暂停则等待 pauseMs 再启下一轮。 */
		const loop = (now: number) => {
			if (!alive) return;
			rafId = requestAnimationFrame(loop);

			// 拖拽中冻结，只更新时间戳避免切帧跳过
			if (draggingRef.current) {
				lastTime = now;
				return;
			}

			const delta = now - lastTime;
			lastTime = now;

			// 暂停期：等待 pauseMs 后再播下一轮
			if (isPausing) {
				pauseAccumulator += delta;
				if (pauseAccumulator >= pauseMs) {
					isPausing = false;
					pauseAccumulator = 0;
					frameIdx = 1;
					currentCol = 0;
					accumulator = 0;
				}
				// 暂停期同样每帧重绘（sprite 停在最后一帧 + 通知气泡）
				drawFrame(currentCol);
				drawNotification();
				return;
			}

			accumulator += delta;

			// 切后台回来时 delta 可能极大 → 防止跳过整段动画
			if (accumulator > frameInterval * totalFrames) {
				accumulator = frameInterval * totalFrames;
			}

			// 按帧率推进帧索引（只更新 currentCol，不直接绘制）
			while (accumulator >= frameInterval) {
				accumulator -= frameInterval;
				currentCol = frameIdx;
				frameIdx = (frameIdx + 1) % totalFrames;

				// 播完一轮完整动画（frameIdx 回绕到 0）→ 进入暂停期
				if (frameIdx === 0 && pauseMs > 0) {
					isPausing = true;
					pauseAccumulator = 0;
					break;
				}
			}

			// 每个 rAF tick 都重绘：清屏 + sprite + 通知气泡，杜绝累积叠加
			drawFrame(currentCol);
			drawNotification();
		};

		// 立即绘制首帧 + 通知（currentCol 已为 0，frameIdx 已为 1）
		drawFrame(currentCol);
		drawNotification();

		rafId = requestAnimationFrame(loop);

		return () => {
			alive = false;
			cancelAnimationFrame(rafId);
		};
	}, [sprite, mode]);

	// ── hidden：纯透明占位 ──
	if (mode === "hidden") {
		return <div style={{ width: "100%", height: "100%", background: "transparent" }} />;
	}

	// ── 有 sprite：Canvas 渲染（性能路径） ──
	if (sprite) {
		return (
			<canvas
				ref={canvasRef}
				style={{
					width: "100%",
					height: "100%",
					display: "block",
					imageRendering: "pixelated",
				}}
			/>
		);
	}

	// ── 无 sprite：程序化降级绘制 ──
	return <FallbackCanvas mode={mode} />;
}

// ═══════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════

/** 绘制圆角矩形路径。CanvasRenderingContext2D.roundRect() 在 Electron 28+ 可用，
 *  此处提供手动实现确保兼容性。 */
function rndRect(
	ctx: CanvasRenderingContext2D,
	x: number, y: number, w: number, h: number, r: number,
) {
	ctx.moveTo(x + r, y);
	ctx.lineTo(x + w - r, y);
	ctx.arcTo(x + w, y, x + w, y + r, r);
	ctx.lineTo(x + w, y + h - r);
	ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
	ctx.lineTo(x + r, y + h);
	ctx.arcTo(x, y + h, x, y + h - r, r);
	ctx.lineTo(x, y + r);
	ctx.arcTo(x, y, x + r, y, r);
	ctx.closePath();
}

/** 将文本拆分多行以适应 maxWidth。中文在字间断行，英文在空格处断行，
 *  单词不截断（除非单字比 maxWidth 还宽）。返回每行不超宽的文本数组。 */
function wrapText(
	ctx: CanvasRenderingContext2D,
	text: string,
	maxWidth: number,
): string[] {
	if (maxWidth <= 0) return [text];
	if (ctx.measureText(text).width <= maxWidth) return [text];

	const lines: string[] = [];
	// 按空格拆分，保留每个片段（中文整段为一个「词」，英文单词独立）
	const words = text.split(" ");
	let current = "";

	for (let i = 0; i < words.length; i++) {
		const word = words[i];
		const trial = current ? current + " " + word : word;

		if (ctx.measureText(trial).width <= maxWidth) {
			current = trial;
		} else {
			// 单词放不进当前行
			if (current) {
				lines.push(current);
				current = "";
			}
			// 单词单放一行仍超宽 → 逐字打断（fallback）
			if (ctx.measureText(word).width <= maxWidth) {
				current = word;
			} else {
				let chunk = "";
				for (const ch of word) {
					const cTrial = chunk + ch;
					if (ctx.measureText(cTrial).width > maxWidth && chunk.length > 0) {
						lines.push(chunk);
						chunk = ch;
					} else {
						chunk = cTrial;
					}
				}
				current = chunk;
			}
		}
	}
	if (current) lines.push(current);
	return lines;
}

// ═══════════════════════════════════════════
// 降级（无素材时）
// ═══════════════════════════════════════════

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
