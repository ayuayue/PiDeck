import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

type TitleScrollStyle = CSSProperties & {
	"--title-scroll-distance"?: string;
	"--title-scroll-duration"?: string;
};

const TITLE_SCROLL_PIXELS_PER_SECOND = 5;
// 仅保留下限防抖：2px 最小溢出 → 400ms；不设上限（历史上 24s/300s 上限都会把
// 超长标题（数百～数千 px）钦成 10px/s 以上的“飞滚”，违背 5px/s 恒定速度的初衷）。
const TITLE_SCROLL_MIN_DURATION_MS = 300;

/**
 * 侧栏会话标题的 hover 滚动展示。
 *
 * 为什么不用 beui 的 Marquee：Marquee 是无限循环复制轨道（跑马灯），语义是「持续轮播」，
 * 而这里要的是「标题被截断时，hover 让全文滚出来看完」的一次性动作。
 *
 * 行为规则：
 * - 未溢出不滚动（scrollWidth <= clientWidth 时保持静止，避免所有行 hover 都动）；
 * - 默认静止显示开头（与现状渐隐截断一致）；hover 时滚动到末尾并停住；
 * - 离开 hover 回到开头；滚动为慢速匀速（线性 5px/s，不设时长上限：
 *   历史上 24s/300s 上限会把超长标题钳成 10px/s+ 的“飞滚”，与用户
 *   “长短都改 5px/s” 的诉求冲突；下限仅 300ms 防 2px 级抖动）；
 * - hover 事件绑定在静态窗口而不是移动文字上，避免文字滚走后触发 mouseleave；
 * - 溢出距离经 CSS 变量注入 keyframes，使用实际像素而非不稳定的视口单位。
 *
 * 调用方可收敛触发（tab 栏高频交互场景需要，侧栏保持默认不收敛）：
 * - disabled：完全禁用滚动（如激活 tab——内容已在右侧，hover 滚动纯属噪音）；
 * - hoverDelayMs：hover 停留该时长后才开始滚动（如 500ms），鼠标快速扫过
 *   时不触发，避免「每扫过一个 tab 就滚一次」的闪烁感。
 */
export function TitleScrollText({
	text,
	className,
	disabled = false,
	hoverDelayMs = 0,
}: {
	text: string;
	className?: string;
	/** true 时完全不滚动（保持静态截断，原生 title 提示兜底） */
	disabled?: boolean;
	/** hover 后延迟多少 ms 进入滚动（默认 0 = 立即，侧栏现状） */
	hoverDelayMs?: number;
}) {
	const containerRef = useRef<HTMLElement>(null);
	const textRef = useRef<HTMLSpanElement>(null);
	const [overflow, setOverflow] = useState(0);
	const [hovering, setHovering] = useState(false);
	const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const container = containerRef.current;
		const content = textRef.current;
		if (!container || !content) return;
		let active = true;
		const measure = () => {
			if (!active) return;
			// 内层是 max-content，scrollWidth 是标题的自然宽度；外层 clientWidth 是
			// 让位给时间戳/徽标后的实际可视窗口宽度。
			setOverflow(Math.max(0, content.scrollWidth - container.clientWidth));
		};
		measure();
		// disabled 时不测溢出：不滚动的 tab 无需维持 ResizeObserver（节省常驻监听）；
		// 激活态变化时 effect 随 disabled 重跑，切回可滚动会重新测量。
		if (disabled) return () => { active = false; };
		// 字体加载和侧栏宽度变化都可能改变溢出量；两者统一由同一测量入口处理。
		if (typeof ResizeObserver === "undefined") return () => { active = false; };
		const observer = new ResizeObserver(measure);
		observer.observe(container);
		observer.observe(content);
		if (typeof document !== "undefined" && document.fonts) {
			void document.fonts.ready.then(measure).catch(() => undefined);
		}
		return () => {
			active = false;
			observer.disconnect();
		};
	}, [text, disabled]);

	// 卸载时清理悬停延迟定时器，避免组件卸载后 setState 触发告警。
	useEffect(() => {
		return () => {
			if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		};
	}, []);

	// hover 进入：disabled 直接忽略；有延迟则先清旧定时器再挂新定时器（防止重复 enter 叠加）。
	const handleMouseEnter = () => {
		if (disabled) return;
		if (hoverDelayMs <= 0) {
			setHovering(true);
			return;
		}
		if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
		hoverTimerRef.current = setTimeout(() => setHovering(true), hoverDelayMs);
	};
	const handleMouseLeave = () => {
		if (hoverTimerRef.current) {
			clearTimeout(hoverTimerRef.current);
			hoverTimerRef.current = null;
		}
		setHovering(false);
	};

	const overflowing = overflow > 1 && !disabled;
	// 变量总是注入（无论是否 hovering）：数值随测量常驻，便于调试与避免 hover 瞬间的样式跳变；
	// 动画 class（animate-title-scroll）仍只在 hovering 时挂载，行为不变。
	const scrollStyle: TitleScrollStyle | undefined = overflowing
		? {
				"--title-scroll-distance": `${overflow}px`,
				"--title-scroll-duration": `${Math.max(
					TITLE_SCROLL_MIN_DURATION_MS,
					Math.round((overflow / TITLE_SCROLL_PIXELS_PER_SECOND) * 1000),
				)}ms`,
			}
		: undefined;

	return (
		<strong
			ref={containerRef}
			className={cn(
				"block min-w-0 flex-1 overflow-hidden whitespace-nowrap",
				overflowing && hovering && "title-scroll-mask-narrow",
				className,
			)}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
		>
			<span
				ref={textRef}
				className={cn(
					"title-scroll-text inline-block whitespace-nowrap",
					overflowing && hovering && "animate-title-scroll",
				)}
				style={scrollStyle}
			>
				{text}
			</span>
		</strong>
	);
}