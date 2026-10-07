import { ChevronDown, ChevronRight, ChevronUp, FilePlus, FileText, Globe, Image, ListChecks, MessageCircleQuestion, Network, Puzzle, Search, Sparkles, SquareCode, SquarePen, Terminal, Wrench, type LucideIcon } from "lucide-react";
import { memo, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getToolName } from "../../../../../shared/fileChanges";
import { t } from "../../../i18n";
import { ShimmerText } from "../ShimmerText";
import { RowText } from "../RowText";
import type { TurnProcessNode } from "../timeline/groupTurnProcess";
import { lastToolCategory } from "../timeline/groupTurnProcess";
import { activityCategoryLabelKey, topActivityKinds, type ToolActivityCategory } from "../timeline/toolCategory";
import { getToolPhraseFromArgs } from "../timeline/toolPhrase";
import { boundMountedSteps, PROCESS_GROUP_MEMBER_LIMIT } from "../timeline/turnMountBudget";
import type { TurnProcessEntry } from "../timeline/types";
import { ThinkingStep } from "./ThinkingStep";
import { ToolStep } from "./ToolStep";
import { ExtensionEntryStep } from "./ExtensionEntryStep";
import { useStickToBottom } from "../../../lib/stick-to-bottom";
import { ProcessGroupBodyScrollContext } from "./processGroupScrollContext";

/**
 * 过程组（组头 + 可折叠组体）。
 *
 * 契约见 `docs/process-group-implementation-contract.md` §4。三件事必须守住：
 * 1. **组头全宽**：`<button>` 是 `flex w-full`（绝不是 `inline-flex`/`self-start`）——
 *    用户反复强调「悬停/触控框要和流式输出同宽」，按内在宽度收缩就是返工。
 * 2. **组体限高 + 内部滚轮**：`max-h-[min(320px,30vh)] overflow-y-auto overscroll-contain`，
 *    外层沿用现有「思考展开正文」的缩进语言（`ml-5` + 2px 竖线 + `pl-3`）。
 *    限高 flex 列的子项一律 `shrink-0`（AGENTS.md 记录过的高度塌陷事故：不写会被压扁且滚不动）。
 * 3. **组内挂载预算**：一个组可能有几百个成员，全挂 DOM 会重演 2026-08 渲染进程 OOM
 *    事故（见 `timeline/turnMountBudget.ts` 注释），故对 `group.members` 套
 *    `boundMountedSteps`，超出部分给「显示更早的 N 条步骤」入口。
 *
 * 行内容一律复用既有组件（`ThinkingStep` / `ToolStep`），本组件不改任何行样。
 */

export type ProcessGroupStepProps = {
	group: Extract<TurnProcessNode, { kind: "group" }>;
	/** 该组是否「最新组且在跑」→ 组头走「正在…」文案 + shimmer */
	running: boolean;
	/** 该组当前是否展开 */
	open: boolean;
	/** 本次展开是否来自自动通道（流式最新组）：展开瞬间自动=落底跟底，手动=保持顶部不跟底 */
	autoOpen: boolean;
	onToggle: (open: boolean) => void;
	showThinking?: boolean;
	sessionId?: string;
	onOpenFile?: (path: string) => void;
	onOpenExternal: (url: string) => void;
};

/**
 * 类别 → 组头图标（契约 §4 冻结的映射）。
 * 类别是「做了哪类事」的概括，图标只做辅助识别，不承载状态。
 */
const CATEGORY_ICONS: Record<ToolActivityCategory, LucideIcon> = {
	read: FileText,
	readImage: Image,
	search: Search,
	write: FilePlus,
	edit: SquarePen,
	commands: Terminal,
	code: SquareCode,
	webSearch: Globe,
	webFetch: Globe,
	subagents: Network,
	plan: ListChecks,
	questions: MessageCircleQuestion,
	tools: Wrench,
};

/**
 * 类别文案 key → 文案。
 *
 * `activityCategoryLabelKey` 返回的是模板字面量联合（13 类 × 2 态 = 26 个真实键），
 * 本身就是 `TranslationKey` 的子集，因此这里不需要任何断言。
 * 返回 `string` 是因为下游要做 `join` 拼接，不是类型收窄不够。
 */
function categoryLabel(kind: ToolActivityCategory, phase: "running" | "done"): string {
	return t(activityCategoryLabelKey(kind, phase));
}

/** 组头「正在…」文案；纯思考组（无工具活动）退回「正在分析请求」。 */
function runningGroupLabel(kind: ToolActivityCategory | undefined): string {
	if (!kind) return t("timeline.processGroup.analyzing");
	return categoryLabel(kind, "running");
}

/**
 * 组头「已…」文案：取前 3 类 done 文案组装。
 *
 * - 1 类 → 直出；2 类 → `joinTwo`；3 类 → `joinList` + `listSeparator`；
 * - 类别数 > 3 时用 `more` 包裹（组头只列前 3 类，不说明会让人以为这是全部活动）；
 * - 组内含扩展输出时追加扩展段（用户决策 2026-10：appendEntry 折进过程组后组头要有踪迹）；
 * - `counts` 为空且无扩展 = 组内只有思考（无工具活动）→「已完成分析」；纯扩展组只报扩展段。
 */
function doneGroupLabel(group: Extract<TurnProcessNode, { kind: "group" }>): string {
	const kinds = topActivityKinds(group.counts, 3);
	const extension = group.extensionCount > 0 ? extensionLabel(group.extensionCount) : "";
	if (kinds.length === 0) return extension || t("timeline.processGroup.analyzed");
	const labels = kinds.map((kind) => categoryLabel(kind, "done"));
	let label: string;
	if (labels.length === 1) label = labels[0] ?? "";
	else if (labels.length === 2) label = t("timeline.processGroup.joinTwo", { first: labels[0] ?? "", second: labels[1] ?? "" });
	else {
		const joined = t("timeline.processGroup.joinList", { items: labels.join(t("timeline.processGroup.listSeparator")) });
		const kindTotal = group.counts.filter((entry) => entry.count > 0).length;
		label = kindTotal > 3 ? t("timeline.processGroup.more", { title: joined }) : joined;
	}
	return extension ? t("timeline.processGroup.joinTwo", { first: label, second: extension }) : label;
}

function extensionLabel(count: number): string {
	return t("timeline.processGroup.extension", { count });
}

/**
 * 组头「正在…」的实时详情：只看当前（最后）工具条目的加载态短语。
 * 若最新成员已切回思考，旧工具详情必须一起消失。
 */
function lastToolLoadingLabel(members: readonly TurnProcessEntry[]): string | undefined {
	const current = members[members.length - 1];
	if (current?.kind !== "tool-entry") return undefined;
	const message = current.group.messages[current.group.messages.length - 1];
	if (!message) return undefined;
	const name = getToolName(message);
	return name ? getToolPhraseFromArgs(name, message.meta?.args).loadingLabel || undefined : undefined;
}

export const ProcessGroupStep = memo(function ProcessGroupStep(props: ProcessGroupStepProps) {
	// 组体 id 走 useId：同页多组共存时 aria-controls 不会串。
	const bodyId = useId();
	// 与 TurnRow 的 expandedStepsRunId 同款模式：存「已全量展开的组 id」而不是布尔量，
	// 换组（React key 变化或 id 不同）自然重置，不需要额外 effect。
	const [expandedGroupId, setExpandedGroupId] = useState<string | undefined>(undefined);
	const showAll = expandedGroupId === props.group.id;
	const mounted = useMemo(() => boundMountedSteps(props.group.members, PROCESS_GROUP_MEMBER_LIMIT, showAll), [props.group.members, showAll]);
	// ── 组体内部滚轮跟底 ──
	// 组体被 max-h 钳住后，外层时间线不再随成员增加而增高，新成员只落在**内部**滚动容器下方；
	// 外层引擎的 ResizeObserver 因此收不到增长通知，内层必须自己跟底（否则滚珠停在上面）。
	// 这里刻意**复用时间线同一个跟底引擎**（`lib/stick-to-bottom`，use-stick-to-bottom 本地移植），
	// 不另写简化版：引擎里沉淀了 8 个历史修复（离散增高强制 instant 防砰抖、内容收缩不追底、
	// clamp 不被误判为用户滚动、resizeScrollGuard 隔离布局滚动等），自造简化版会把这些坑重踩一遍——
	// 用户反复反馈的「跟底偶发跳动」正是这类问题的表现。
	// resize 取 instant：内层是限高小窗，直接同步贴底，不引入弹簧变量（弹簧滞后在窄视口里更显跳）。
	// 不传用户意图回调：组内滚动不上报外层 controller，保持契约 §7 已记录的「组内滚动不解锁外层跟随」。
	const stick = useStickToBottom({ initial: "instant", resize: "instant" });
	// 解构出稳定引用：stick 每次渲染是新对象，effect 依赖与 ref 都得用具体字段。
	const stickScrollRef = stick.scrollRef;
	const stickContentRef = stick.contentRef;
	const stickScrollToBottom = stick.scrollToBottom;
	const stickRestoreAt = stick.restoreAt;
	const stickNoteWheel = stick.noteWheel;
	// 展开（含首次挂载）后的定位按「本次展开来自哪条通道」分流（2026 用户反馈：点开组体
	// 想从头看执行的命令，展开即拽到底反而要再滚回最前面）：
	// - 自动通道（流式最新组）：落底并跟随——组体在长、滚珠不能停在上面（既有契约，e2e 钉住）；
	// - 手动通道（用户点开）：restoreAt(0) 原子完成「定位到顶 + 解锁锁底 + 取消在途动画」，
	//   后续成员到达不再拽底；用户滚回物理底仍按引擎语义重锁跟随。
	// 定位只在「关→开」上升沿执行一次：开着期间 autoOpen 变化（如手动重开的组被 syncLatest
	// 重新并入自动槽）不得重新定位，否则又会把浏览中的用户拽走。
	// layout 阶段执行，绘制前完成，无可见跳动。
	const wasOpenRef = useRef(false);
	useLayoutEffect(() => {
		if (!props.open) {
			wasOpenRef.current = false;
			return;
		}
		if (wasOpenRef.current) return;
		wasOpenRef.current = true;
		if (props.autoOpen) {
			stickScrollToBottom({ animation: "instant" });
		} else {
			stickRestoreAt(0);
		}
	}, [props.open, props.autoOpen, stickScrollToBottom, stickRestoreAt]);

	const topKind = topActivityKinds(props.group.counts, 1)[0];
	// 运行中的「正在…」必须用**当前**工具类别，不能用 topKind（整组摘要）：
	// 组内从搜索切到读取后，摘要仍是搜索 → 组头写「正在搜索代码」，右侧实时详情却是
	// 「正在读取 main.ts」，同一行自相矛盾（2026-08 审计）。已结束的组头仍用摘要。
	const runningKind = props.running ? lastToolCategory(props.group.members) : undefined;
	const headKind = props.running ? runningKind : topKind;
	// 纯扩展组（无工具类别）：已结束用 Puzzle 标识来源；运行中退回 Sparkles（无工具活动可报）。
	const Icon = headKind ? CATEGORY_ICONS[headKind] : !props.running && props.group.extensionCount > 0 ? Puzzle : Sparkles;
	// 实时详情只对运行中的组有意义（结束后组头是类别摘要，不再报「正在执行…」）。
	const detail = props.running ? lastToolLoadingLabel(props.group.members) : undefined;
	const runningLabel = props.running ? runningGroupLabel(runningKind) : "";
	const doneLabel = props.running ? "" : doneGroupLabel(props.group);

	const renderMember = (entry: TurnProcessEntry): ReactNode => {
		// 组员有思考/工具/扩展输出三类（重试/错误是组边界，由分组层挡在外面）；其余分支兜底跳过。
		if (entry.kind === "thinking-entry") {
			return <ThinkingStep group={entry.group} hidden={false} showThinking={props.showThinking} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
		}
		if (entry.kind === "tool-entry") {
			return <ToolStep group={entry.group} hidden={false} stopped={!props.running} sessionId={props.sessionId} onOpenFile={props.onOpenFile} />;
		}
		if (entry.kind === "extension-entry") {
			return <ExtensionEntryStep messages={entry.messages} />;
		}
		return null;
	};

	return (
		<div className="flex min-w-0 flex-col" data-process-group-id={props.group.id}>
			{/* 组头：w-full 占满内容列（与流式输出同宽），hover 底色因此铺满整行；
			    内部与现有过程行同构：22px 类别图标方块 → 文案 → chevron，左对齐右侧留白。
			    尺寸规则（2026 用户反馈修正）：组头**不得小于组体里的行**——成员行是
			    text-chat-row（正文 −2px，默认档 13px）/min-h-7/图标 16px，组头取同档才不会出现
			    「容器比内容小」的倒置层级。
			    轨道规则（2026-08）：组头与整个过程层都在**会话正文轨道**上（字号由 --font-size-chat
			    派生，见 foundation.css 的 --font-size-chat-row/-detail/-micro），随「会话正文字号」
			    缩放、**不随界面字号**。因此这里用 min-h-7 而不是固定 h-7：字号放大后固定高度会裁切行。
			    自重规则（2026-08 用户反馈「组头喧宾夺主」修正）：降权只能走**颜色 / 填充 / 字重**，
			    **不得再靠缩小字号**（那会退回上面的倒置）。
			      ① 不填色：类别图标方块去掉底色，只留图标；运行中保留工具身份色作为「正在跑」信号。
			      ④ 静止降色：标签 text-tertiary（#6b7280，对白底 4.82:1，过 WCAG AA），hover 回 secondary。
			         **不用 opacity**——text-secondary 压到 60% 实测只有约 2.87:1，不过 AA。
			      ② 降字重：标签 600 → 500（font-medium）。降之前组头是**整轮唯一的 600**：
			         大折叠栏胶囊与「显示更早」都是 500，过程行与正文都是 400 —— 也就是说它是
			         一屏里最粗的一行，这才是「比中间回复还重」的机械原因。降到 500 后与胶囊同档。
			         不再降到 400：那样组头与成员行完全同权，只剩颜色可区分，会失去「这是一组」的形态。
			         hover **不改字重**（CJK 下字重变化会改宽度，导致行内 chevron 抖动）；
			         hover 已有颜色 + 底色两重反馈。
			    于是层级由字重（500 vs 400）+ 颜色承担，中间回复（text-chat，默认 15px / text-primary）成为正文主角。
			    回归守卫：tests/processGroupRendering.test.mjs「组头不得靠填充/字号抢戏」。
			    data-process-group-head 是 e2e/结构测试的稳定锚点（组头、组体、scroller 各一个）。 */}
			<button
				type="button"
				data-process-group-head=""
				className="flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md pl-0.5 pr-[7px] text-left text-chat-row font-medium text-text-tertiary transition-colors duration-fast hover:bg-[color:color-mix(in_srgb,var(--color-text-primary)_4%,transparent)] hover:text-text-secondary focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
				aria-expanded={props.open}
				aria-controls={bodyId}
				onClick={() => props.onToggle(!props.open)}
			>
				{/* 类别图标：① 不填色——运行中 = 工具身份色图标，已结束 = 中性灰，
				    两者都不再有底色（底色曾是整屏唯一的实心块，正是「喧宾夺主」的来源） */}
				<span aria-hidden="true" className={`grid size-[22px] shrink-0 place-items-center rounded-md ${props.running ? "text-[var(--color-tool)]" : "text-text-tertiary"}`}>
					<Icon size={14} aria-hidden="true" />
				</span>
				{props.running ? (
					/* 文本段：主标签（text-chat-row）与「·」后的 12px 等宽实时详情必须共基线，
					   否则详情整体高出约 3px、看起来「没纵向居中」（原理解释见 RowText）。 */
					<RowText>
						<ShimmerText text={runningLabel} className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" />
						{detail && (
							<>
								<span aria-hidden="true" className="shrink-0 text-text-faint">
									{t("timeline.processGroup.separator")}
								</span>
								<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-chat-detail font-normal text-text-tertiary">{detail}</span>
							</>
						)}
					</RowText>
				) : (
					<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{doneLabel}</span>
				)}
				<span aria-hidden="true" className="inline-flex shrink-0 text-text-faint">
					{props.open ? <ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />}
				</span>
			</button>

			{props.open && (
				// 组体：缩进 + 竖线沿用现有展开区语言；限高交给内层 scroller，滚轮不外溢到时间线。
				// 组体内层限高交给 ProcessGroupBodyScrollContext：组内工具卡展开后不再自带滚轮，
				// 整组只有这一条滚轮（否则是双层滚动条，内层到边就滚不动了）。
				<ProcessGroupBodyScrollContext.Provider value={true}>
					<div id={bodyId} data-process-group-body="" className="ml-5 mt-1 border-l-2 border-border-subtle pl-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-fast">
						<div
							ref={stickScrollRef}
							data-process-group-scroller=""
							// 滚轮交给引擎才能产生「上滚逃逸 / 回底重锁」：引擎的 wheel 意图是从外部路由进来的
							// （noteWheel），不注册自己的 wheel 监听。虽然同一事件会冒泡到外层时间线，
							// 但外层会先判定滚动链归属：组内有余量时由内层认领，到边后 contain 切断，
							// 两种情况都不能改变外层跟随态。
							onWheel={(event) => stickNoteWheel(event.deltaY, event.target)}
							className="flex max-h-[min(320px,30vh)] flex-col overflow-y-auto overscroll-contain"
						>
							{/* 内容包装盒：引擎的 ResizeObserver 观察这一层才能感知「内容变高」——
						    外层 scroller 被 max-height 钳住、尺寸恒定，观察它收不到增长通知。 */}
							<div ref={stickContentRef} className="flex shrink-0 flex-col">
								{mounted.hiddenCount > 0 && (
									// 超出挂载预算的早期成员入口：与 TurnRow 的「显示更早的 N 条步骤」同款观感。
									<button
										type="button"
										className="mt-1 inline-flex h-[26px] shrink-0 items-center gap-2 self-start rounded-[var(--radius-md)] border border-border-subtle bg-[var(--color-chat-card-bg)] px-3 text-chat-detail font-medium text-text-secondary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
										onClick={() => setExpandedGroupId(props.group.id)}
										title={t("timeline.showEarlierSteps", { count: mounted.hiddenCount })}
									>
										<ChevronUp size={12} aria-hidden="true" />
										<span>{t("timeline.showEarlierSteps", { count: mounted.hiddenCount })}</span>
									</button>
								)}
								{mounted.items.map((entry) => (
									<div key={entry.id} className="shrink-0">
										{renderMember(entry)}
									</div>
								))}
							</div>
						</div>
					</div>
				</ProcessGroupBodyScrollContext.Provider>
			)}
		</div>
	);
});
