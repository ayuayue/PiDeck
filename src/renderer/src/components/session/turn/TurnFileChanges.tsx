import { memo, useCallback, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, FileText } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../ui-shadcn/context-menu";
import { collectRunFileChanges, fileChangeDelta } from "../TimelineFormat";
import { hasFileChangePayload } from "../../../../../shared/fileChanges";
import type { AgentRunItem } from "../timeline/types";
import type { DiffFileHandler } from "../ToolCallComponents";
import { getFileIconColor, getFileIconSeti } from "../../../fileIcons";
import { fitOneRow } from "./chipRowFit";
import { t } from "../../../i18n";

/** chip 之间的间距（px），与 className 的 gap-1 必须一致——装箱计算要用真实值。 */
const CHIP_GAP = 4;
/** chip 行的类名常量：折叠态不换行，展开态换行。 */
const ROW_BASE = "flex items-center gap-1";
const ROW_COLLAPSED = `${ROW_BASE} flex-nowrap`;
const ROW_EXPANDED = `${ROW_BASE} flex-wrap`;

type FileEntry = { path: string; count: number; originalContent: string; content: string };

/**
 * ref 回调：挂载时接管 node 并观测尺寸（挂载即量一次），卸载时断开观测并清空 nodeRef。
 *
 * 为什么不写在 useLayoutEffect 里：量宽的触发条件必须覆盖「DOM 从无到有」这个转换，
 * 而 effect 的依赖数组要靠人手工列出所有能改变 DOM 存在性的 props/state，漏一项就永久宕机。
 * 见组件内 attachRow 的注释（2027-03 实际踩到：流式结束那次转换没被依赖捕获）。
 */
function attachMeasured(node: HTMLDivElement | null, nodeRef: { current: HTMLDivElement | null }, observerRef: { current: ResizeObserver | null }, measure: () => void) {
	observerRef.current?.disconnect();
	observerRef.current = null;
	nodeRef.current = node;
	if (!node) return;
	if (typeof ResizeObserver !== "undefined") {
		const observer = new ResizeObserver(() => measure());
		observer.observe(node);
		observerRef.current = observer;
	}
	measure();
}

/**
 * 轮末「修改的文件」chip 行（2px 虚线分隔 + chip 横排）。
 *
 * 为什么在这个位置：一轮的产物（改了哪些文件）属于该轮结论，而不是下一轮的输入。
 * 旧实现把它做成 composer 上方的常驻卡片，位置和轮次脱节、还和待办/子代理条抢空间。
 * 这里贴在正文之后、操作栏之前，用 2px 虚线分隔
 * 把「执行过程 / 结论 / 产物」三段切开——无边框、无折叠头、无卡片。
 *
 * 左对齐：**不加左内缩**。TurnRow 里正文与操作栏都从 0 开始，若按「正文缩进在
 * 头像右侧」的版式凭空加 46px，chip 行会比正文和操作栏都往右偏
 * （2027-02 实际观感 bug）。
 *
 * 单行折叠（与用户确认的方案）：一轮可能改几十个文件，全铺开会把轮末撑成一坨。
 * 规则是「只显示一行，放不下的收进 +N，点 +N 就地展开成多行」。
 * - 装箱规则是纯函数 fitOneRow（可单测），组件只负责测宽度；
 * - 不横向滚动：滚动条隐藏后用户不知道右边还有东西，鼠标滚轮默认也不动横向；
 * - 不弹浮层：轮末位置容易被视口底部裁掉，还要额外处理点外关闭与焦点管理。
 *
 * 数据：collectRunFileChanges(run) 按 run 聚合 write/edit/create/patch，run 完成后
 * 内容不再变化（TurnRow 的 memo 深度比较保证历史轮不重渲染），因此天然固定。
 *
 * 交互（用户调整：默认看 diff，打开文件本体降到右键）：
 * - 左键 chip = 打开该文件的 diff（复用 onDiffFile）。轮末 chip 的默认意图是「这轮改了什么」，
 *   diff 与文件本体都进中间栏 ContentHost，不额外占 chip 内空间；
 * - chip 右键菜单 = 「在 diff 查看器中打开」+「预览打开」（复用 App 级 onOpenFile：
 *   图片预览 / md·html 中间栏 / 内置编辑器）；
 * - onDiffFile 未注入的宿主面左键退回打开文件本体——chip 不能变成看得见点不动的死按钮。
 *
 * 只在轮次结束（非流式）时渲染：流式中文件列表还在长，逐条冒出来会让正文区持续抖动。
 */
export const TurnFileChanges = memo(function TurnFileChanges(props: {
	run: AgentRunItem;
	/** 流式中/运行中：整体不渲染（见组件注释） */
	streaming?: boolean;
	onOpenFile?: (path: string, line?: number) => void;
	onDiffFile?: DiffFileHandler;
}) {
	const files = useMemo(() => collectRunFileChanges(props.run), [props.run]);
	const [expanded, setExpanded] = useState(false);
	const rowRef = useRef<HTMLDivElement | null>(null);
	// 不可见测量层：折叠态只渲染了 visibleCount 个 chip，但装箱需要**全部** chip 的宽度
	const probeRef = useRef<HTMLDivElement | null>(null);
	// 首行能放几个。null = 还没量过（首帧按「全显示」渲染，量完立刻收敛到真实值）
	const [visibleCount, setVisibleCount] = useState<number | null>(null);

	const toggle = useCallback(() => setExpanded((previous) => !previous), []);

	/**
	 * 量宽 → fitOneRow。
	 *
	 * 关键：折叠态只渲染了 visibleCount 个 chip，所以**不能**从可见行里量宽度
	 * （否则量到的永远只是当前已显示的那几个，装箱会锁死在首帧结果）。
	 * 从不可见探测层（里面渲染了全部 chip）量，再从可见行取可用宽度。
	 */
	const recompute = useCallback(() => {
		const row = rowRef.current;
		const probe = probeRef.current;
		if (!row || !probe) return;
		const chips = Array.from(probe.querySelectorAll<HTMLElement>("[data-file-chip]"));
		if (chips.length === 0) {
			setVisibleCount(0);
			return;
		}
		const widths = chips.map((chip) => chip.getBoundingClientRect().width);
		// 可用宽度取行容器的内容宽（本行无 padding，clientWidth 即内容宽）。
		const available = row.clientWidth;
		// 「更多」按钮宽度随剩余数量单调递增（+3 比 +12 窄）。fitOneRow 会迭代收敛，
		// 但不能用「当前已渲染按钮的实测宽度」：首帧该按钮尚未挂载（量不到），
		// 且按钮一旦挂载，它显示的是上一轮算出的剩余数，不是本轮要算的那个。
		// 所以直接按剩余数反算上界：overhead = px-1.5(12) + border(2) + gap-1(4) + chevron(12)，
		// 数字位宽按 text-caption（12px, font-semibold）保守取 0.62em/字符，含 '+' 共 digits+1 位。
		// 宁可少放一个 chip（多一个进 +N），也不可溢出容器。
		const digitCharWidth = 12 * 0.62;
		const moreWidthFor = (remaining: number) => 30 + (String(remaining).length + 1) * digitCharWidth;
		setVisibleCount(fitOneRow(widths, CHIP_GAP, available, moreWidthFor));
	}, []);

	// 量宽由 DOM 生命周期驱动（ref 回调挂载即量 + ResizeObserver 跟尺寸），
	// 而不是 useLayoutEffect 的依赖数组。理由（2027-03 用户反馈的 bug）：
	// 本组件在流式中 return null（DOM 不存在），轮结束才挂载。依赖数组必须手工列举
	// 「哪些变化会让 DOM 出现」——漏一项（当时漏的就是流式结束）就让 visibleCount 永远
	// 停在 null，折叠态按「全显示」渲染整行 chip，溢出到右侧被 .message-timeline 的
	// overflow-x:hidden 裁掉：用户看到「轮结束后不自动折叠」，切走会话（重新挂载）才恢复。
	// ref 回路上没有可漏的依赖，也顺手覆盖了「files 长度不变但 chip 变宽」（换文件名）。
	const rowObserverRef = useRef<ResizeObserver | null>(null);
	const probeObserverRef = useRef<ResizeObserver | null>(null);
	const attachRow = useCallback((node: HTMLDivElement | null) => attachMeasured(node, rowRef, rowObserverRef, recompute), [recompute]);
	// 探测层也要观测：只盯可见行会漏掉「chip 数量不变但文件名变长 / 字体加载完成改了字宽」
	const attachProbe = useCallback((node: HTMLDivElement | null) => attachMeasured(node, probeRef, probeObserverRef, recompute), [recompute]);

	if (props.streaming) return null;
	if (files.length === 0) return null;

	const hiddenCount = visibleCount === null ? 0 : Math.max(0, files.length - visibleCount);
	const shown = visibleCount === null || expanded ? files : files.slice(0, visibleCount);

	return (
		<div className="mt-3" data-testid="turn-file-changes">
			{/* 虚线分隔：2px dashed 上边框。用 2px 是为了在 1px 边框体系里
			    一眼看出「这是分隔，不是卡片边界」。 */}
			<div className="border-t-2 border-dashed border-border-subtle pt-3">
				<div ref={attachRow} className={expanded ? ROW_EXPANDED : ROW_COLLAPSED}>
					{shown.map((entry) => (
						<FileChangeChip key={entry.path} entry={entry} onOpenFile={props.onOpenFile} onDiffFile={props.onDiffFile} />
					))}
					{/* +N / 收起：与文件 chip 同形但虚线描边——它是控件不是文件，必须一眼区分。
					    折叠态只在确实有隐藏时才出现；展开态总是提供收起入口。 */}
					{(expanded || hiddenCount > 0) && (
						<button
							type="button"
							onClick={toggle}
							aria-expanded={expanded}
							title={expanded ? t("common.collapse") : t("sessionFiles.moreChipsHint", { count: hiddenCount })}
							className="inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-xs border border-dashed border-border-strong px-1.5 py-0.5 text-caption font-semibold text-text-tertiary tabular-nums transition-colors duration-fast hover:border-solid hover:border-text-tertiary hover:bg-bg-muted hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
							data-testid="turn-file-changes-more"
						>
							{expanded ? (
								<>
									<span>{t("common.collapse")}</span>
									<ChevronUp size={12} aria-hidden="true" className="shrink-0" />
								</>
							) : (
								<>
									{t("sessionFiles.moreChips", { count: hiddenCount })}
									<ChevronDown size={12} aria-hidden="true" className="shrink-0" />
								</>
							)}
						</button>
					)}
				</div>
			</div>
			{/* 不可见测量层：折叠态也要拿到全部 chip 的自然宽度才能装箱。
			    visibility:hidden + absolute 不参与布局也不可点，但自身布局仍是真实宽度。
			    w-max：绝对定位的容器宽度会塔陷；chip 的 max-w-[min(100%,280px)] 里的 100%
			    会参照塔陷值而失真，所以让容器按内容自然展开。
			    注意：w-max（max-content）尺寸计算时百分比 max-width 按 CSS 规范视为 none，
			    测出的宽度可能大于可见行里被 280px 截断后的真实宽度——这种偏差只会让装箱偏保守
			    （少放一个进 +N），不会溢出，所以接受。 */}
			<div ref={attachProbe} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 -z-10 flex w-max gap-1">
				{files.map((entry) => (
					<FileChangeChip key={entry.path} entry={entry} noInteract />
				))}
			</div>
		</div>
	);
});

/**
 * 单个文件 chip：图标 + 文件名 + 修改次数 + 增/删行数。
 *
 * 尺寸（2027-03 用户反馈「太大、太显眼，不是主要关注元素」）：12px 文字 + 2px 纵向内边距
 * （22px 高，原 13px/4px → 28px）、14px 图标、4px 间距。它是轮末副产物，亮度要低于正文
 * 与操作栏，靠图标原色和 +N/−N 状态色保留可读性。
 *
 * 配色（F）：底色用主题 accent 混 4%（随 data-accent 走，看得出「这是本轮产物」但不抢视线），
 * 文字用 text-secondary 而非 accent——accent 在 PiDeck 里是「面」不是「字」，
 * 直接当文字色时 green/blue/amber/rose 四个主题对比度只有 3.89~4.38，全部不到 WCAG AA 4.5。
 * 用 secondary 还有个信息层次上的好处：文件名比正文弱一档，产物相对结论降权。
 * hover 时文字提到 primary（悬停反馈靠「变清楚」而不是变色），底色加到 8%。
 *
 * data-file-chip：装箱计算靠它取每个 chip 的自然宽度，改名需同步 chipRowFit 的用量处。
 */
const FileChangeChip = memo(function FileChangeChip(props: { entry: FileEntry; onOpenFile?: (path: string, line?: number) => void; onDiffFile?: DiffFileHandler; noInteract?: boolean }) {
	const { entry } = props;
	const fileName = entry.path.split(/[/\\]/).pop() || entry.path;
	// ACP 的编辑工具可能只上报路径（wire 上没有旧/新文本）：文件照样进清单，
	// 但没有增删行数可算，也没有 diff 可打开——左键退回打开文件本体。
	const hasPayload = hasFileChangePayload(entry);
	const delta = useMemo(() => (hasPayload ? fileChangeDelta(entry) : null), [entry, hasPayload]);
	// 主操作是 diff（默认意图：看这轮改了什么）；两个入口各自判可用性，
	// 只接了 onOpenFile 的宿主面（onDiffFile 缺省）左键退回打开文件本体。
	const canDiff = !props.noInteract && Boolean(props.onDiffFile) && hasPayload;
	const canOpen = !props.noInteract && Boolean(props.onOpenFile);
	const handleOpenDiff = () => props.onDiffFile?.(entry.path, entry.originalContent, entry.content);
	const handleOpenFile = () => props.onOpenFile?.(entry.path);

	const chip = (
		<button
			type="button"
			data-file-chip
			// 测量层里的副本只用于量宽：不可聚焦、不响应指针，避免被 Tab 或误点中
			tabIndex={props.noInteract ? -1 : undefined}
			// 两个入口都不可用（或测量层副本）才置灰
			disabled={!canDiff && !canOpen}
			// title 给完整相对路径：chip 只显示文件名，同名文件（多个 index.ts）靠悬停区分
			title={props.noInteract ? undefined : entry.path}
			onClick={props.noInteract ? undefined : canDiff ? handleOpenDiff : handleOpenFile}
			className="inline-flex min-w-0 max-w-[min(100%,280px)] shrink-0 cursor-pointer items-center gap-1 rounded-xs bg-[color:color-mix(in_srgb,var(--color-accent)_4%,transparent)] px-1.5 py-0.5 text-caption font-medium text-text-secondary transition-colors duration-fast hover:bg-[color:color-mix(in_srgb,var(--color-accent)_8%,transparent)] hover:text-text-primary focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-default disabled:opacity-70"
		>
			<FileTypeGlyph fileName={fileName} />
			<span className="min-w-0 truncate">{fileName}</span>
			{/* 同文件本轮被改多次：次数跟在文件名后，避免误以为只有一次编辑 */}
			{entry.count > 1 && <span className="shrink-0 text-micro font-normal tabular-nums opacity-55">×{entry.count}</span>}
			{delta && (
				<span className="shrink-0 text-micro font-semibold tabular-nums">
					<span className="text-success">+{delta.added}</span>
					{delta.removed > 0 && <span className="ml-1 text-danger">−{delta.removed}</span>}
				</span>
			)}
		</button>
	);

	// 两个入口都不可用时不套右键菜单：空菜单比没有菜单更糟（测量层副本也走这条）
	if (!canDiff && !canOpen) return chip;

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{chip}</ContextMenuTrigger>
			<ContextMenuContent className="min-w-40">
				{/* 菜单顺序跟默认操作一致：diff 打头，预览（打开文件本体）是用户在右键里选的第二入口 */}
				{canDiff && <ContextMenuItem onSelect={handleOpenDiff}>{t("sessionFiles.openInDiffViewer")}</ContextMenuItem>}
				{canOpen && <ContextMenuItem onSelect={handleOpenFile}>{t("sessionFiles.previewFile")}</ContextMenuItem>}
			</ContextMenuContent>
		</ContextMenu>
	);
});

/**
 * 文件类型图标（Seti 图标集，与文件抽屉/Git 面板同源）。
 * chip 内的图标是「身份标记」而非文字，保留原色才让 ts/tsx/json 一眼可分；
 * 与输入框内 input-chip 的 currentColor 单色图标不同——那里图标是语法组成部分，这里是列表项标识。
 */
function FileTypeGlyph({ fileName }: { fileName: string }) {
	try {
		const { svg, colorName } = getFileIconSeti(fileName);
		// 14px：与 chip 的 12px 文件名同档略大，图标仍是身份标记；原 16px 配 13px 文字是
		// 28px chip 的比例，chip 收紧到 22px 后 16px 会顶满行高、显得比文件名还重。
		return <span aria-hidden="true" className="inline-flex size-3.5 shrink-0 items-center justify-center [&_svg]:size-full [&_svg]:fill-current" style={{ color: getFileIconColor(colorName) }} dangerouslySetInnerHTML={{ __html: svg }} />;
	} catch {
		return <FileText aria-hidden="true" className="size-3.5 shrink-0" />;
	}
}
