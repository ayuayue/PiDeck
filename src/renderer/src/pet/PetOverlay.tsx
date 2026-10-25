import { useEffect, useRef } from "react";
import type { AppFontSizeMode, PetAggregateState, PetManifest, PetMode, PetNotification } from "@shared/types";
import { NOTIFICATION_GAP, NOTIFICATION_MAX_LINES, NOTIFICATION_MAX_WIDTH, NOTIFICATION_PAD_X, NOTIFICATION_PAD_Y, NOTIFICATION_STROKE, NOTIFICATION_FONT_SIZE_PX, PET_BASE_H, PET_BASE_W, layoutNotificationSegments } from "@shared/petNotificationLayout";
import { type SpriteSheet, MODE_ROW, MODE_FRAMES, CELL_W, CELL_H } from "./PetSpriteSheet";

/**
 * Canvas + 按需调度精灵动画，GPU 绘制零 React re-render 开销。
 * 统一帧率 12fps / 8fps(idle)。
 *
 * 性能约束（2026-09）：原实现 rAF 60fps 常驻空转，idle 静止期也每帧重绘
 * （读 clientWidth 强制布局 + 整窗 canvas 重绘 + 透明窗口合成）。现改为
 * 事件/时间驱动：动画帧推进期按帧间隔调度；暂停/通知稳定期零绘制，仅
 * 100ms 低频兜底检查（通知到达、淡出期开始、窗口 resize/DPI 变化）。
 *
 * 布局约定（与主进程 PetWindow 共享同一套几何）：
 * - 精灵按 192×scale × 208×scale 绘制在窗口底部居中，与 spritesheet 单格同比例。
 * - 通知气泡锚定在精灵头顶：底边 = 精灵顶边 - gap，横向居中。
 * - 气泡字号用有效 UI 字号（uiFontSize ?? fontSize），只乘 DPR，绝不随 petScale 缩放。
 * - 缩放用高质量双线性插值：内置宠物是抗锯齿插画，pixelated 会把边缘撕成色块。
 */

const DEFAULT_FPS = 12;
const IDLE_FPS = 8;
const PAUSE_MS: Record<string, number> = { idle: 3000, failed: 4000 };
/** 非持久化提醒淡出窗口（主进程 4s 后推 null 清除） */
const TOTAL_MS = 4000;
const FADE_IN_MS = 250;
const FADE_OUT_MS = 500;

/** 状态色（700 档，避免过亮）：已完成绿 / 出现问题红 / 等待操作黄 */
const NOTIF_COLOR: Record<PetNotification["type"], string> = {
	done: "#15803d",
	error: "#b91c1c",
	waiting: "#a16207",
};

/** 标题黑色（PiDeck --color-text-primary） */
const TITLE_COLOR = "#202124";
/** 气泡文字字重：统一加粗 */
const NOTIF_FONT_WEIGHT = 700;

type Props = {
	sprite: SpriteSheet | null;
	manifest: PetManifest | null;
	state: PetAggregateState;
	notification?: PetNotification | null;
	/** 宠物缩放：只影响精灵尺寸，不影响气泡字号 */
	scale: number;
	/** 有效 UI 字号档位：气泡字号由此推导 */
	fontMode: AppFontSizeMode;
	/** 气泡字体栈（跟随 PiDeck 字体设置：system/sans/serif/custom） */
	fontStack: string;
};

export function PetOverlay({ sprite, state, notification, scale, fontMode, fontStack }: Props) {
	const mode = state.mode;
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const notifRef = useRef(notification);
	notifRef.current = notification;

	useEffect(() => {
		if (mode === "hidden" || !sprite) return;
		const canvas = canvasRef.current;
		if (!canvas) return;
		const ctx = canvas.getContext("2d", { alpha: true });
		if (!ctx) return;

		const syncCanvasSize = () => {
			const dpr = window.devicePixelRatio || 1;
			const cssWidth = Math.max(1, canvas.clientWidth);
			const cssHeight = Math.max(1, canvas.clientHeight);
			const pixelWidth = Math.round(cssWidth * dpr);
			const pixelHeight = Math.round(cssHeight * dpr);
			// Canvas 的 width/height 是整数像素；这里统一取整，避免高 DPI 下 float 对比
			// 每帧都判定“尺寸变化”并重置 buffer，拖拽/点击时看起来会不断变大。
			const changed = canvas.width !== pixelWidth || canvas.height !== pixelHeight;
			if (changed) {
				canvas.width = pixelWidth;
				canvas.height = pixelHeight;
			}
			return { dpr, cssWidth, cssHeight, changed };
		};

		syncCanvasSize();

		// 精灵几何（只随 scale 与窗口尺寸变化，与通知可见性无关）
		const spriteW = Math.round(PET_BASE_W * scale);
		const spriteH = Math.round(PET_BASE_H * scale);
		// 气泡几何：固定 CSS 尺寸，仅乘 DPR
		const fontSizeCss = NOTIFICATION_FONT_SIZE_PX[fontMode];
		const bubbleMaxW = NOTIFICATION_MAX_WIDTH;
		const padX = NOTIFICATION_PAD_X;
		const padY = NOTIFICATION_PAD_Y;
		const gap = NOTIFICATION_GAP;
		const stroke = NOTIFICATION_STROKE;

		const row = MODE_ROW[mode] ?? 0;
		const totalFrames = MODE_FRAMES[mode] ?? 8;
		const fps = mode === "idle" ? IDLE_FPS : DEFAULT_FPS;
		// 系统偏好减少动态（prefers-reduced-motion）时降到约 1/4 帧率，接近定格：
		// 宠物动画纯装饰，尊重偏好并省电；通知气泡是低频功能提示，不参与降帧。
		const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const frameMs = reducedMotion ? 1000 / (fps / 4) : 1000 / fps;
		const pauseMs = PAUSE_MS[mode] ?? 0;

		let col = 0,
			nextCol = 1;
		let lastT = performance.now();
		let acc = 0;
		let paused = false,
			pauseAcc = 0;
		let alive = true;
		let timerId: number | undefined;
		let notifAnimating = false;
		let lastDrawnNotif = notifRef.current;

		const draw = (c: number) => {
			const { dpr } = syncCanvasSize();
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			const sx = (canvas.width - spriteW * dpr) / 2;
			const sy = canvas.height - spriteH * dpr;
			ctx.imageSmoothingEnabled = true;
			ctx.imageSmoothingQuality = "high";
			ctx.drawImage(sprite.image, c * CELL_W, row * CELL_H, CELL_W, CELL_H, sx, sy, spriteW * dpr, spriteH * dpr);
		};

		const drawNotif = () => {
			const n = notifRef.current;
			if (!n) return;
			const elapsed = performance.now() - n.timestamp;
			if (elapsed < 0) return;
			let alpha = 1;
			if (!n.persistent) {
				if (elapsed < FADE_IN_MS) alpha = elapsed / FADE_IN_MS;
				else if (elapsed > TOTAL_MS - FADE_OUT_MS) alpha = Math.max(0, (TOTAL_MS - elapsed) / FADE_OUT_MS);
				if (alpha <= 0) return;
			}

			const { dpr } = syncCanvasSize();
			const fontSize = Math.round(fontSizeCss * dpr);
			const maxW = bubbleMaxW * dpr;
			ctx.save();
			ctx.globalAlpha = alpha;
			ctx.font = `${NOTIF_FONT_WEIGHT} ${fontSize}px ${fontStack}`;
			const measure = (t: string) => ctx.measureText(t).width;

			// 分段着色：标题加中文引号（黑色）+ 状态词状态色；缺省 title/status 时退化为整行状态色
			const displayTitle = n.title?.trim() ? `“${n.title}”` : (n.title ?? "");
			const rows = n.title && n.status ? layoutNotificationSegments(measure, displayTitle, n.status, maxW - padX * 2 * dpr - stroke * 2 * dpr, NOTIFICATION_MAX_LINES) : [[{ text: n.text, kind: "status" as const }]];
			const lineH = fontSize * 1.5;
			const lineMaxW = Math.max(...rows.map((segments) => segments.reduce((w, s) => w + measure(s.text), 0)));
			const bw = Math.min(lineMaxW, maxW) + padX * 2 * dpr + stroke * 2 * dpr;
			const bh = rows.length * lineH + padY * 2 * dpr + stroke * 2 * dpr;
			// 气泡底边锚定精灵顶边，横向居中
			const spriteTop = canvas.height - spriteH * dpr;
			const by = spriteTop - gap * dpr - bh;
			const bx = (canvas.width - bw) / 2;
			const rad = 10 * dpr;

			ctx.fillStyle = "rgba(255,255,255,0.95)";
			ctx.beginPath();
			rndRect(ctx, bx, by, bw, bh, rad);
			ctx.fill();
			ctx.strokeStyle = "#1a1d24";
			ctx.lineWidth = 1.5 * dpr;
			ctx.setLineDash([3 * dpr, 3 * dpr]);
			ctx.stroke();
			ctx.setLineDash([]);

			// 底部小三角指向精灵头顶（高度留余量，不越过 NOTIFICATION_GAP）
			const tailX = canvas.width / 2;
			ctx.beginPath();
			ctx.moveTo(tailX - 5 * dpr, by + bh);
			ctx.lineTo(tailX + 5 * dpr, by + bh);
			ctx.lineTo(tailX, by + bh + 5 * dpr);
			ctx.closePath();
			ctx.fill();

			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			for (let i = 0; i < rows.length; i++) {
				const y = by + padY * dpr + stroke * dpr + lineH * i + lineH / 2;
				const rowW = rows[i].reduce((w, s) => w + measure(s.text), 0);
				let x = bx + bw / 2 - rowW / 2;
				for (const segment of rows[i]) {
					ctx.fillStyle = segment.kind === "status" ? NOTIF_COLOR[n.type] : TITLE_COLOR;
					ctx.fillText(segment.text, x + measure(segment.text) / 2, y);
					x += measure(segment.text);
				}
			}
			ctx.restore();
		};

		const tick = () => {
			draw(col);
			drawNotif();
		};

		// —— 按需调度（替代常驻 rAF）：只在「画面会变化」的时刻重绘 ——
		// 需要连续绘制的阶段只有通知淡入/淡出（16ms 逐帧）；动画帧推进按帧间隔；
		// 其余静止期（idle/failed 暂停、通知稳定显示）零绘制，100ms 低频兜底检查。
		const check = () => {
			if (!alive) return;
			// 用真实流逝时间而非固定步长：setTimeout 在后台窗口会被节流，
			// 恢复后 delta 大跳由 acc 上限兜底（防跳帧），不会补播动画。
			// 注意：本循环由 setTimeout 驱动（替代常驻 rAF），回调不携带时间戳，
			// 必须自取 performance.now()——写成 now 形参会得到 undefined→NaN，
			// 帧号永不推进（定格第一帧）且延迟 NaN 被 setTimeout 强转为 0 空转。
			const now = performance.now();
			const delta = Math.max(0, now - lastT);
			lastT = now;

			let needDraw = false;
			let nextDelay: number;

			if (paused) {
				// 暂停期画面完全静止：只计时，不重绘
				pauseAcc += delta;
				if (pauseAcc >= pauseMs) {
					paused = false;
					pauseAcc = 0;
					nextCol = 1;
					col = 0;
					acc = 0;
					needDraw = true;
					nextDelay = frameMs;
				} else {
					nextDelay = Math.min(100, Math.max(1, pauseMs - pauseAcc));
				}
			} else {
				acc += delta;
				if (acc > frameMs * totalFrames) acc = frameMs * totalFrames; // 防跳帧
				const prevCol = col;
				while (acc >= frameMs) {
					acc -= frameMs;
					col = nextCol;
					nextCol = (nextCol + 1) % totalFrames;
					if (nextCol === 0 && pauseMs > 0) {
						paused = true;
						pauseAcc = 0;
						break;
					}
				}
				needDraw = col !== prevCol;
				nextDelay = Math.max(1, frameMs - (acc % frameMs));
			}

			// 通知：对象变化（到达/消失/替换）需立即重绘一帧；淡入淡出期逐帧重绘。
			// 稳定显示期画面静止（alpha 恒定），不需要绘制。
			const n = notifRef.current;
			if (n && n !== lastDrawnNotif) {
				lastDrawnNotif = n;
				needDraw = true;
			}
			notifAnimating = false;
			if (n) {
				const elapsed = now - n.timestamp;
				notifAnimating = !n.persistent && elapsed >= 0 && (elapsed < FADE_IN_MS || elapsed > TOTAL_MS - FADE_OUT_MS);
				if (notifAnimating) needDraw = true;
			}

			// 窗口/DPI 尺寸变化必须重绘，否则 canvas buffer 停留在旧比例
			needDraw = needDraw || syncCanvasSize().changed;

			if (needDraw) tick();

			timerId = window.setTimeout(check, notifAnimating ? 16 : nextDelay);
		};

		syncCanvasSize();
		tick();
		lastDrawnNotif = notifRef.current;
		timerId = window.setTimeout(check, frameMs);
		return () => {
			alive = false;
			if (timerId !== undefined) window.clearTimeout(timerId);
		};
	}, [sprite, mode, scale, fontMode, fontStack]);

	if (mode === "hidden") return <div style={{ width: "100%", height: "100%", background: "transparent" }} />;

	if (sprite) {
		return <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block", imageRendering: "auto" }} />;
	}

	return <FallbackCanvas mode={mode} />;
}

// ═══ 工具函数 ═══

function rndRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
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

// ═══ 降级（无素材时） ═══

const FALLBACK: Record<PetMode, { color: string; emoji: string }> = {
	idle: { color: "#a1a1aa", emoji: "😌" },
	running: { color: "#18181b", emoji: "⚙️" },
	failed: { color: "#ef4444", emoji: "😥" },
	waiting: { color: "#ca8a04", emoji: "🥺" },
	waving: { color: "#3f3f46", emoji: "👋" },
	jumping: { color: "#52525b", emoji: "🤸" },
	"running-right": { color: "#18181b", emoji: "🏃" },
	"running-left": { color: "#18181b", emoji: "🏃‍♂️" },
	review: { color: "#3f3f46", emoji: "🔍" },
	hidden: { color: "#a1a1aa", emoji: "" },
};

function FallbackCanvas({ mode }: { mode: PetMode }) {
	const ref = useRef<HTMLCanvasElement>(null);
	const frame = useRef(0);

	useEffect(() => {
		const c = ref.current;
		if (!c) return;
		const ctx = c.getContext("2d");
		if (!ctx) return;
		const fb = FALLBACK[mode] ?? FALLBACK.idle;
		// 有意义的动画态才持续 rAF；idle/waiting/review 静止（原实现这些模式
		// 也只是 ±3% 幅度的慢脉动，视觉可忽略，却常驻 60fps 重绘）
		const animated = mode === "running" || mode === "failed" || mode === "waving" || mode === "jumping" || mode === "running-right" || mode === "running-left";
		let alive = true;
		let raf = 0;
		let ro: ResizeObserver | undefined;

		// 绘制前同步像素尺寸，跟随窗口 resize/DPI 变化（原实现只在挂载时量一次）
		const draw = (f: number) => {
			const dpr = window.devicePixelRatio || 1;
			const W = Math.round(c.clientWidth * dpr),
				H = Math.round(c.clientHeight * dpr);
			if (c.width !== W || c.height !== H) {
				c.width = W;
				c.height = H;
			}
			if (W === 0 || H === 0) return;
			const cx = W / 2,
				cy = H / 2,
				r = Math.min(W, H) * 0.36;
			const pulse = animated ? 1 + 0.06 * Math.sin(f * 0.8) : 1;
			ctx.clearRect(0, 0, W, H);
			ctx.beginPath();
			ctx.arc(cx, cy, r * pulse, 0, Math.PI * 2);
			ctx.fillStyle = fb.color;
			ctx.globalAlpha = animated && mode === "failed" ? (f % 2 === 0 ? 0.95 : 0.6) : 0.92;
			ctx.fill();
			ctx.globalAlpha = 1;
			if (fb.emoji) {
				ctx.font = `${Math.round(r * 0.9)}px system-ui, sans-serif`;
				ctx.textAlign = "center";
				ctx.textBaseline = "middle";
				ctx.fillText(fb.emoji, cx, cy);
			}
		};

		if (animated) {
			const loop = () => {
				if (!alive) return;
				draw(++frame.current);
				raf = requestAnimationFrame(loop);
			};
			raf = requestAnimationFrame(loop);
		} else {
			// 静止模式：只画一帧；尺寸变化时重画（mode 变化会重启本 effect）
			draw(0);
			if (typeof ResizeObserver !== "undefined") {
				ro = new ResizeObserver(() => {
					if (alive) draw(++frame.current);
				});
				ro.observe(c);
			}
		}
		return () => {
			alive = false;
			ro?.disconnect();
			cancelAnimationFrame(raf);
		};
	}, [mode]);

	return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}
