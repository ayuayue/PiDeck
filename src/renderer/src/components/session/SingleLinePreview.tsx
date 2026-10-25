import { memo, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { firstLine, latestLine } from "../../utils/thinkingSummary";

/**
 * 单行折叠预览：折叠态思考文本的单行摘要（ThinkingBlock / WebThinkingBlock 共用）。
 *
 * 参考 deepseek-ai/deepseek-harness ReasoningRow 的模式：
 * - 文字不滚动（横向跑马灯实测太晃、看不清，且思考结束后动画仍继续、与状态脱节，已弃用）：
 *   流式中显示最新一行（latestLine，终端 tail -f 语义，容器 scrollLeft 跟随尾部），
 *   结束后显示第一行（firstLine，从头部读摘要）+ 尾部省略号
 * - 流式动感来自行上「扫光」渐变光带（pointer-events 穿透、不遮挡文字），
 *   思考结束（running=false）光带即消失，与状态完全同步；
 *   prefers-reduced-motion 下动画关闭
 * - 文本内空白（含换行、制表）压成单个空格，保证视觉单行
 * - 外层 padding/字号由调用方通过 className 传入，组件只管预览行
 */
export const SingleLinePreview = memo(function SingleLinePreview(props: {
	text: string;
	/** 思考是否仍在流式：true 显示最新一行并跟随尾部；false 显示第一行并静止 */
	running?: boolean;
	/** 流式扫光。嵌进工具式单行头时由外层 trigger 负责扫光，避免叠两道光带。 */
	showSweep?: boolean;
	className?: string;
}) {
	const showSweep = props.showSweep ?? true;
	const scrollRef = useRef<HTMLDivElement>(null);
	const summary = props.running ? latestLine(props.text) : firstLine(props.text);

	// 流式中跟随尾部：思考增量追加在末尾，容器滚动到最右让最新内容可见；
	// 结束后 scrollLeft 显式归零，从头部显示第一行——不归零会残留流式期的尾部
	// scrollLeft，长首行时结束态仍从第一行中段/尾部显示（对齐 ReasoningRow 的
	// `running ? scrollWidth - clientWidth : 0` 写法）。
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		if (!props.running) {
			el.scrollLeft = 0;
			return;
		}
		const follow = () => {
			el.scrollLeft = el.scrollWidth - el.clientWidth;
		};
		follow();
		const ro = new ResizeObserver(follow);
		ro.observe(el);
		return () => ro.disconnect();
	}, [props.running, summary]);

	return (
		<div
			ref={scrollRef}
			className={cn(
				"relative min-w-0 overflow-hidden whitespace-nowrap",
				// 流式中尾部可见，省略号无意义（text-clip）；结束后 ellipsis 提示还有内容
				props.running ? "text-clip" : "text-ellipsis",
				props.className,
			)}
			// hover 看全文；流式中全文每帧在变，tooltip 会闪，只给结束态挂
			title={props.running ? undefined : props.text.replace(/\s+/g, " ").trim()}
		>
			{props.running && showSweep && (
				// 扫光：仅流式中存在，思考结束即消失；motion-reduce 时关闭
				<span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-[-300px] w-[300px] animate-thinking-sweep motion-reduce:animate-none bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--color-bg-app)_55%,transparent),transparent)]" />
			)}
			<span className="whitespace-nowrap">{summary}</span>
		</div>
	);
});
