import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

type TitleScrollStyle = CSSProperties & {
	"--title-scroll-distance"?: string;
	"--title-scroll-duration"?: string;
};

const TITLE_SCROLL_PIXELS_PER_SECOND = 20;
const TITLE_SCROLL_MIN_DURATION_MS = 1_800;
const TITLE_SCROLL_MAX_DURATION_MS = 12_000;

/**
 * 侧栏会话标题的 hover 滚动展示。
 *
 * 为什么不用 beui 的 Marquee：Marquee 是无限循环复制轨道（跑马灯），语义是「持续轮播」，
 * 而这里要的是「标题被截断时，hover 让全文滚出来看完」的一次性动作。
 *
 * 行为规则：
 * - 未溢出不滚动（scrollWidth <= clientWidth 时保持静止，避免所有行 hover 都动）；
 * - 默认静止显示开头（与现状渐隐截断一致）；hover 时滚动到末尾并停住；
 * - 离开 hover 回到开头；滚动速度随溢出长度自适应（约 20px/s，下限 1.8s）；
 * - hover 事件绑定在静态窗口而不是移动文字上，避免文字滚走后触发 mouseleave；
 * - 溢出距离经 CSS 变量注入 keyframes，使用实际像素而非不稳定的视口单位。
 */
export function TitleScrollText({
	text,
	className,
}: {
	text: string;
	className?: string;
}) {
	const containerRef = useRef<HTMLElement>(null);
	const textRef = useRef<HTMLSpanElement>(null);
	const [overflow, setOverflow] = useState(0);
	const [hovering, setHovering] = useState(false);

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
		// 字体加载和侧栏宽度变化都可能改变溢出量；两者统一由同一测量入口处理。
		if (typeof ResizeObserver === "undefined") return;
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
	}, [text]);

	const overflowing = overflow > 1;
	const scrollStyle: TitleScrollStyle | undefined = overflowing && hovering
		? {
				"--title-scroll-distance": `${overflow}px`,
				"--title-scroll-duration": `${Math.min(
					TITLE_SCROLL_MAX_DURATION_MS,
					Math.max(
						TITLE_SCROLL_MIN_DURATION_MS,
						Math.round((overflow / TITLE_SCROLL_PIXELS_PER_SECOND) * 1000),
					),
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
			onMouseEnter={() => setHovering(true)}
			onMouseLeave={() => setHovering(false)}
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
