/**
 * 微光扫过文本（借鉴 Vercel AI Elements 的 Shimmer 组件）：
 * 用于「启动中 / 工具调用中 / 正在回应」等待态文案的注意力提示。
 *
 * 零依赖 CSS 实现：渐变背景裁剪到文字（bg-clip-text + text-transparent），
 * 扫光 keyframes 定义在 timeline.css（shimmer-sweep），动画类走 Tailwind
 * utility（项目约定不新增手写 CSS class）；prefers-reduced-motion 时
 * motion-safe 让动画不启用，文本退化为静态渐变，状态仍可读。
 */
export function ShimmerText(props: {
	text: string;
	className?: string;
	/** warning 对应启动中/工具执行中的琥珀色状态位；muted 对应普通等待/回应中 */
	tone?: "muted" | "warning";
}) {
	// 渐变两端暗、中间亮，扫光即亮带移动；明暗都取语义 token，暗色模式自适应，
	// warning 档位与 responding-indicator 的琥珀色状态位保持一致。
	const edge = props.tone === "warning" ? "color-mix(in srgb, var(--color-warning) 55%, transparent)" : "var(--color-text-tertiary)";
	const peak = props.tone === "warning" ? "var(--color-warning)" : "var(--color-text-primary)";
	return (
		<span
			className={`motion-safe:animate-[shimmer-sweep_2.2s_linear_infinite] bg-[length:200%_100%] bg-clip-text text-transparent ${props.className ?? ""}`}
			style={{
				backgroundImage: `linear-gradient(110deg, ${edge} 40%, ${peak} 50%, ${edge} 60%)`,
			}}
		>
			{props.text}
		</span>
	);
}
