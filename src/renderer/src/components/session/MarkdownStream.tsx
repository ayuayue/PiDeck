import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { Streamdown, defaultRehypePlugins, defaultRemarkPlugins, type Components } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import { createMathPlugin } from "@streamdown/math";
import { MarkdownLink, remarkLinkifyPaths } from "./MarkdownLink";
import { markdownUrlTransform } from "./MarkdownLinkCore";
import { remarkGfmNoSingleTilde } from "../../utils/markdownPlugins";
import { FormulaCopyLayer } from "./FormulaCopyLayer";
import { useSmoothStream } from "../../utils/useSmoothStream";
import {
	STREAM_LIGHT_MAX_CHARS,
	STREAM_UNFREEZABLE_MIN_CHARS,
	SETTLE_FULL_MAX_CHARS,
	shouldRenderStreamPlain,
	shouldKeepLightOnSettle,
} from "./markdownStreamPolicy";
// 兼容导出：既有引用与源码契约测试从 MarkdownStream 读阈值常量
export { STREAM_LIGHT_MAX_CHARS } from "./markdownStreamPolicy";
import {
	IncrementalMarkdownFrontier,
	UNSTABLE_TAIL_BLOCKS,
} from "./markdown/incrementalMarkdown";

/**
 * 数学公式插件（KaTeX）。@streamdown/math 默认 singleDollarTextMath: false，
 * 只解析 $$...$$；而 AI 输出行内公式普遍用单美元 $...$（如 $E=mc^2$），
 * 不开则整句原样输出（用户可见的“公式没渲染”）。
 * 开启单美元的安全边界（remark-math 行为）：必须成对的 $...$ 才解析，
 * 单独的 $5、$HOME 等不受影响；副作用是 “$5 and $6” 这类成对美元会被当
 * 行内公式（与 GitHub math 渲染行为一致，可接受）。
 */
const mathPlugin = createMathPlugin({ singleDollarTextMath: true });

// 流式精简插件集合：必须是模块级稳定引用（不能每帧内联 []）——
// pipe 的 useMemo 依赖 resolvedRemarkPlugins，内联新数组会让 pipe 每帧重建，
// FrozenMarkdownChunk 的 memo 比较 props.pipe 引用变化 → 冻结 prefix 每帧全量重解析。
const NO_STREAM_REMARK_PLUGINS: Parameters<typeof Streamdown>[0]["remarkPlugins"] = [];
const NO_STREAM_REHYPE_PLUGINS: Parameters<typeof Streamdown>[0]["rehypePlugins"] = [];

/**
 * 纯文本兜底路径的拆分渲染（2026-08 内存/CPU 治理）。
 *
 * 背景：超长/不可冻结流式文本回退为单个 whitespace-pre-wrap 文本节点时，
 * 每次内容到达都整体替换文本节点 → Chromium 对整段重新断行（layout O(n)），
 * 大文本（100K+）下主线程被排满 → IPC 消息积压 → 渲染进程原生内存 GB 级爬升。
 *
 * 方案：按 4K 步长把文本切成「冻结段（memo 稳定字符串）+ 活动段（≤4K）」。
 * 冻结段只在跨过 4K 步进时变更一次文本节点（均摊 O(1)），活动段每帧最多
 * 变更 4K 字符；纯文本在中途切分视觉上不可见（无块结构），无接缝问题。
 */
const PLAIN_SPLIT_STEP = 4_096;

const PlainStreamSplit = memo(function PlainStreamSplit(props: { text: string }) {
	const text = props.text;
	// 冻结段字符串缓存：split 未跨步进且缓存片段仍是当前文本前缀时复用上次
	// 切片对象，避免每帧新分配大字符串（slice 会产生引用父串的 SlicedString，
	// 阻碍旧串回收）。前缀校验兜底非追加替换/收缩（冻结段必须随内容重切，
	// 否则会显示过期文本）。
	const frozenCacheRef = useRef<{ split: number; text: string }>({ split: 0, text: "" });
	const split = Math.floor(text.length / PLAIN_SPLIT_STEP) * PLAIN_SPLIT_STEP;
	let frozenText = frozenCacheRef.current.text;
	if (frozenCacheRef.current.split !== split || !text.startsWith(frozenText)) {
		frozenText = text.slice(0, split);
		frozenCacheRef.current = { split, text: frozenText };
	}
	return (
		<div className="whitespace-pre-wrap break-words">
			{split > 0 && <span data-md-plain-frozen="1">{frozenText}</span>}
			<span data-md-plain-live="1">{text.slice(split)}</span>
		</div>
	);
});

/**
 * Streamdown 渲染管线（唯一 markdown 引擎）。
 *
 * 内置能力（由 streamdown 官方插件接管，不再自研）：
 * - 代码高亮：@streamdown/code（shiki 3.x JS 引擎 + 按语言懒加载；行号/复制/下载由
 *   streamdown 内置外壳提供，观感由 streamdownChrome.css（utilities 层）压掉官方双层皮；
 *   2026-08 曾因全语言常驻移除，恢复时按 memory-profile 复测）
 * - 数学公式：@streamdown/math（KaTeX，$...$/$$...$$）
 * - mermaid 图表：@streamdown/mermaid（```mermaid 代码块 → 交互式 SVG + 全屏/缩放/下载控件）
 * - 表格：GFM + 内建复制/下载（CSV/TSV/Markdown）控件
 * - HTML 标签：默认 sanitize（未知标签剥属性保留文本）
 *
 * 有意保留的项目能力（streamdown 无对应内置或桌面语义不同）：
 * - a 仍走 MarkdownLink：file:// 本地路径可点击打开、外链经 onOpenExternal
 *   走系统浏览器（linkSafety 内置的「打开」用 window.open，桌面端不可用）；
 *   危险协议（javascript:/data:）由 urlTransform 拦截
 * - cytoscape / wardley 图表：streamdown 只有 mermaid，经 plugins.renderers
 *   注册自定义渲染器保留（见 MarkdownDiagramRenderers）
 *
 * 流式冻结（学 dsh IncrementalMarkdownParser）：
 * - 追加文本只重塑解析前沿，prefix 用 generation+offset 钉 key，只重解析尾部
 *   UNSTABLE_TAIL_BLOCKS 个内容块；settle 后整篇一次渲染自愈跨边界链接/脚注。
 * - 不替换 Streamdown，不引入 marked。
 *
 * 注：plugins 传参处对第三方边界类型做了收窄（streamdown 官方组合用法）。
 */
type StreamdownPipe = {
	isAnimating?: boolean;
	remarkPlugins: Parameters<typeof Streamdown>[0]["remarkPlugins"];
	rehypePlugins: Parameters<typeof Streamdown>[0]["rehypePlugins"];
	urlTransform: (url: string) => string;
	plugins: Parameters<typeof Streamdown>[0]["plugins"];
	mermaid: Parameters<typeof Streamdown>[0]["mermaid"];
	components: Components;
};

/**
 * 单段 Streamdown。text 不变时 memo bailout，冻结前缀每帧零解析。
 * key 由调用方用 generation+offset 钉住，非 append 时整段重建。
 */
const FrozenMarkdownChunk = memo(function FrozenMarkdownChunk(props: {
	text: string;
	frozen?: boolean;
	pipe: StreamdownPipe;
}) {
	return (
		<div data-md-frozen={props.frozen ? "1" : "0"} className="contents">
			<Streamdown
				mode="static"
				isAnimating={props.pipe.isAnimating}
				remarkPlugins={props.pipe.remarkPlugins}
				rehypePlugins={props.pipe.rehypePlugins}
				urlTransform={props.pipe.urlTransform}
				plugins={props.pipe.plugins}
				mermaid={props.pipe.mermaid}
				components={props.pipe.components}
			>
				{props.text}
			</Streamdown>
		</div>
	);
});

export const MarkdownStream = memo(function MarkdownStream(props: {
	text: string;
	isStreaming?: boolean;
	onOpenExternal: (url: string, forceSystem?: boolean) => void;
	/**
	 * 会话内文件链接打开（path 为规范化后的绝对/可解析路径；line 为可选的
	 * `path:line` 位置标记，打开后应滚动定位到该行）。
	 */
	onOpenFile?: (path: string, line?: number) => void;
	/** 静态 Markdown 场景（FileDiffViewer/ScratchPad）可覆盖默认插件 */
	remarkPlugins?: Parameters<typeof Streamdown>[0]["remarkPlugins"];
	rehypePlugins?: Parameters<typeof Streamdown>[0]["rehypePlugins"];
	urlTransform?: (url: string) => string;
	components?: Parameters<typeof Streamdown>[0]["components"];
	/** 是否禁用图表/代码高亮等重型渲染（静态小场景如更新日志可关以省内存） */
	light?: boolean;
}) {
	const isDark = typeof document !== "undefined" &&
		document.documentElement.dataset.theme === "dark";
	// 逐字打字机：默认参数见 useSmoothStream（约 8ms / 每帧最多 6 字）。
	const { displayedContent } = useSmoothStream({
		content: props.text,
		isStreaming: Boolean(props.isStreaming),
	});
	const displayText = props.isStreaming ? displayedContent : props.text;
	const isStreamingNow = Boolean(props.isStreaming);
	// 流式期间走轻量渲染：跳过代码高亮/mermaid/数学等重插件，只跑 marked 核心解析，
	// 否则 30fps 逐字渲染会让插件管线（每帧全量树遍历）占满主线程，React concurrent
	// 把多帧 setState 合并提交 → DOM 一帧蹦多字（学 Proma：流式期间 react-markdown 轻渲染）。
	// 流结束 isStreaming 变 false 后，全量渲染（高亮/mermaid/表格/元素树）是一次
	// 实测 70-100ms 的同步长任务：若发生在用户滚动/交互期间会造成可见卡顿与滚动跳动。
	// 因此 settle 后先保持流式末帧的轻量渲染，requestIdleCallback 空闲时再切全量
	// （timeout 兜底防永久延迟）；静态场景（从未流式，如 FileDiffViewer）不延迟。
	const wasStreamingRef = useRef(false);
	const [settleFull, setSettleFull] = useState(false);
	const effectiveLight = props.light || isStreamingNow || !settleFull ||
		shouldKeepLightOnSettle(props.text.length);
	useEffect(() => {
		if (isStreamingNow) {
			// 新一轮流式：复位，等待下次 settle 再调度全量
			wasStreamingRef.current = true;
			setSettleFull(false);
			return;
		}
		if (!wasStreamingRef.current) {
			// 静态场景（从未流式）：立即全量，不延迟
			setSettleFull(true);
			return;
		}
		wasStreamingRef.current = false;
		const schedule = () => setSettleFull(true);
		const id = typeof window.requestIdleCallback === "function"
			? window.requestIdleCallback(schedule, { timeout: 1500 })
			: window.setTimeout(schedule, 50);
		return () => {
			if (typeof window.cancelIdleCallback === "function") window.cancelIdleCallback(id);
			else window.clearTimeout(id);
		};
	}, [isStreamingNow]);
	// ── 冻结切分必须先于 streamPlain：不可冻结（prefixEnd=0）时需要据此回退纯文本 ──
	// 每条 MarkdownStream 实例跟一段流：非 append 升 generation，冻结节点整段重建。
	// settle 等待全量渲染期间（settleFull=false）继续用冻结渲染展示完整文本（轻量插件），
	// 空闲调度切全量后（usingFrozen=false）才 reset frontier。
	const frontierRef = useRef<IncrementalMarkdownFrontier | undefined>(undefined);
	if (!frontierRef.current) frontierRef.current = new IncrementalMarkdownFrontier();
	const usingFrozen = isStreamingNow || !settleFull;
	const frozenSplit =
		usingFrozen && !props.light && displayText.length <= STREAM_LIGHT_MAX_CHARS
			? frontierRef.current.update(displayText)
			: undefined;
	if (!usingFrozen) frontierRef.current.reset();
	// 流式纯文本兜底（长度单调递增，一旦触发保持到 settle，不会反复横跳）：
	// 1. 整体超长（>40K）：marked 解析成本线性增长，流式期间回退纯文本；
	// 2. 不可冻结（未闭合代码围栏等，prefixEnd=0）且超过小阈值：每帧都是全量
	//    重渲染（大代码块流式输出时 GC 追不上，原生内存实测 200-450MB/min 爬升），
	//    同样回退纯文本，settle 后一次全量渲染。
	const streamPlain =
		isStreamingNow && displayText.length > STREAM_LIGHT_MAX_CHARS ||
		(frozenSplit !== undefined && frozenSplit.prefixEnd === 0 && displayText.length > STREAM_UNFREEZABLE_MIN_CHARS);
	// 流式中精简插件：gfm/codeMeta/linkifyPaths 与 math 等插件都留到静态渲染；
	// 外部显式传入的插件（FileDiffViewer 等场景）不受流式精简影响。
	const resolvedRemarkPlugins = isStreamingNow
		? NO_STREAM_REMARK_PLUGINS
		: (props.remarkPlugins ?? [
				remarkGfmNoSingleTilde,
				defaultRemarkPlugins.codeMeta,
				remarkLinkifyPaths,
			]);
	const resolvedRehypePlugins = isStreamingNow
		? NO_STREAM_REHYPE_PLUGINS
		: (props.rehypePlugins ?? [defaultRehypePlugins.raw]);
	// 显式 Components 标注：让 a 的 props 走上下文类型推断（streamdown 的
	// Components 是「具名槽位 | 索引签名」联合，直接内联会触发索引签名分支的类型不兼容）
	// useMemo 依赖回调 props：回调引用变化时 components 重建，streamElement 随之重建，
	// 闭包不会捕获过期回调（比裸对象 + eslint-disable 的做法依赖链完整）。
	// 公式复制不再走 p 层拦截：rehype-katex 产物不进组件 map，p 层只能覆盖
	// “单个行内公式独占一段”的罕见场景；改为 FormulaCopyLayer 事件委托浮层。
	const components: Components = useMemo(
		() =>
			props.components ?? {
				a: (linkProps) => (
					<MarkdownLink
						{...(linkProps as unknown as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
						onOpenExternal={props.onOpenExternal}
						onOpenFile={props.onOpenFile}
					/>
				),
			},
		[props.components, props.onOpenExternal, props.onOpenFile],
	);
	const pipe: StreamdownPipe = useMemo(
		() => ({
			// 学 Proma：流式期间也用 static 模式（同步渲染）。streamdown 的 streaming 模式
			// 内部用 useTransition 低优先级更新块，React 会把多帧 transition 合并提交 →
			// DOM 一帧跳多帧步进（视觉蹦字）；static 模式与 Proma 的 react-markdown 同为
			// 同步提交，每帧独立渲染，DOM 增量 = useSmoothStream 每帧步进。
			isAnimating: props.isStreaming,
			remarkPlugins: resolvedRemarkPlugins,
			rehypePlugins: resolvedRehypePlugins,
			urlTransform: props.urlTransform ?? markdownUrlTransform,
			plugins: (effectiveLight
				? { math: mathPlugin }
				: {
						code,
						mermaid,
						math: mathPlugin,
					}) as Parameters<typeof Streamdown>[0]["plugins"],
			mermaid: {
				config: {
					theme: isDark ? "dark" : "default",
					securityLevel: "strict",
				},
			},
			components,
		}),
		[
			components,
			props.isStreaming,
			effectiveLight,
			resolvedRemarkPlugins,
			resolvedRehypePlugins,
			props.urlTransform,
			isDark,
		],
	);
	// 冻结切分与 streamPlain 已在上面（settle effect 之后）先行计算，
	// 此处直接消费 frozenSplit：节流窗口内 displayText 不变时 useMemo 返回
	// 同一 element 引用，React 直接 bailout，Streamdown 子树（含 marked 解析）完全跳过。
	const streamElement = useMemo(
		() => {
			if (streamPlain) {
				// 超长兜底：流式期间纯文本节点（主线程只做字符串切片），
				// 排版交给容器 markdown-body（pre-wrap 语义由此处补上）。
				// 冻结/活动两段拆分：每帧 layout 成本 ≤4K 字符，不随全文增长。
				return <PlainStreamSplit text={displayText} />;
			}
			// settle 后整篇一次渲染：自愈跨冻结边界的链接/脚注/表格，并恢复高亮插件。
			if (!frozenSplit || frozenSplit.prefixEnd === 0) {
				return (
					<Streamdown
						mode="static"
						isAnimating={pipe.isAnimating}
						remarkPlugins={pipe.remarkPlugins}
						rehypePlugins={pipe.rehypePlugins}
						urlTransform={pipe.urlTransform}
						plugins={pipe.plugins}
						mermaid={pipe.mermaid}
						components={pipe.components}
					>
						{displayText}
					</Streamdown>
				);
			}
			// 流式冻结：prefix 用 generation+offset 钉 key，tail 每帧重解析（UNSTABLE_TAIL_BLOCKS）。
			return (
				<Fragment>
					<FrozenMarkdownChunk
						key={`${frozenSplit.generation}:0`}
						text={frozenSplit.prefix}
						frozen
						pipe={pipe}
					/>
					<FrozenMarkdownChunk
						key={`${frozenSplit.generation}:${frozenSplit.prefixEnd}`}
						text={frozenSplit.tail}
						pipe={pipe}
					/>
				</Fragment>
			);
		},
		[displayText, frozenSplit, pipe, streamPlain],
	);
	return (
		<Fragment>
			{streamElement}
			<FormulaCopyLayer />
		</Fragment>
	);
});
