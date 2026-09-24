import { ChevronDown, ChevronRight, ChevronUp, FilePlus, FileText, Globe, Image, ListChecks, MessageCircleQuestion, Network, Search, Sparkles, SquareCode, SquarePen, Terminal, Wrench, type LucideIcon } from "lucide-react";
import { memo, useId, useMemo, useState, type ReactNode } from "react";
import { getToolName } from "../../../../../shared/fileChanges";
import { t } from "../../../i18n";
import { ShimmerText } from "../ShimmerText";
import type { TurnProcessNode } from "../timeline/groupTurnProcess";
import { activityCategoryLabelKey, topActivityKinds, type ActivityCount, type ToolActivityCategory } from "../timeline/toolCategory";
import { getToolPhraseFromArgs } from "../timeline/toolPhrase";
import { boundMountedSteps, PROCESS_GROUP_MEMBER_LIMIT } from "../timeline/turnMountBudget";
import type { TurnProcessEntry } from "../timeline/types";
import { ThinkingStep } from "./ThinkingStep";
import { ToolStep } from "./ToolStep";

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
function runningGroupLabel(topKind: ToolActivityCategory | undefined): string {
	if (!topKind) return t("timeline.processGroup.analyzing");
	return categoryLabel(topKind, "running");
}

/**
 * 组头「已…」文案：取前 3 类 done 文案组装。
 *
 * - 1 类 → 直出；2 类 → `joinTwo`；3 类 → `joinList` + `listSeparator`；
 * - 类别数 > 3 时用 `more` 包裹（组头只列前 3 类，不说明会让人以为这是全部活动）；
 * - `counts` 为空 = 组内只有思考（无工具活动）→「已完成分析」。
 */
function doneGroupLabel(counts: readonly ActivityCount[]): string {
	const kinds = topActivityKinds(counts, 3);
	if (kinds.length === 0) return t("timeline.processGroup.analyzed");
	const labels = kinds.map((kind) => categoryLabel(kind, "done"));
	if (labels.length === 1) return labels[0] ?? "";
	if (labels.length === 2) return t("timeline.processGroup.joinTwo", { first: labels[0] ?? "", second: labels[1] ?? "" });
	const joined = t("timeline.processGroup.joinList", { items: labels.join(t("timeline.processGroup.listSeparator")) });
	const kindTotal = counts.filter((entry) => entry.count > 0).length;
	return kindTotal > 3 ? t("timeline.processGroup.more", { title: joined }) : joined;
}

/** 组内最后一个工具条目的加载态短语（工具名 + 参数）；取不到就返回 undefined（不显示详情）。 */
function lastToolLoadingLabel(members: readonly TurnProcessEntry[]): string | undefined {
	for (let index = members.length - 1; index >= 0; index -= 1) {
		const member = members[index];
		if (member?.kind !== "tool-entry") continue;
		const messages = member.group.messages;
		const message = messages[messages.length - 1];
		if (!message) return undefined;
		const name = getToolName(message);
		if (!name) return undefined;
		return getToolPhraseFromArgs(name, message.meta?.args).loadingLabel || undefined;
	}
	return undefined;
}

export const ProcessGroupStep = memo(function ProcessGroupStep(props: ProcessGroupStepProps) {
	// 组体 id 走 useId：同页多组共存时 aria-controls 不会串。
	const bodyId = useId();
	// 与 TurnRow 的 expandedStepsRunId 同款模式：存「已全量展开的组 id」而不是布尔量，
	// 换组（React key 变化或 id 不同）自然重置，不需要额外 effect。
	const [expandedGroupId, setExpandedGroupId] = useState<string | undefined>(undefined);
	const showAll = expandedGroupId === props.group.id;
	const mounted = useMemo(() => boundMountedSteps(props.group.members, PROCESS_GROUP_MEMBER_LIMIT, showAll), [props.group.members, showAll]);

	const topKind = topActivityKinds(props.group.counts, 1)[0];
	const Icon = topKind ? CATEGORY_ICONS[topKind] : Sparkles;
	// 实时详情只对运行中的组有意义（结束后组头是类别摘要，不再报「正在执行…」）。
	const detail = props.running ? lastToolLoadingLabel(props.group.members) : undefined;
	const runningLabel = props.running ? runningGroupLabel(topKind) : "";
	const doneLabel = props.running ? "" : doneGroupLabel(props.group.counts);

	const renderMember = (entry: TurnProcessEntry): ReactNode => {
		// 组员只有思考/工具两类（重试/错误是组边界，由分组层挡在外面）；其余分支兜底跳过。
		if (entry.kind === "thinking-entry") {
			return <ThinkingStep group={entry.group} hidden={false} showThinking={props.showThinking} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
		}
		if (entry.kind === "tool-entry") {
			return <ToolStep group={entry.group} hidden={false} stopped={!props.running} sessionId={props.sessionId} onOpenFile={props.onOpenFile} />;
		}
		return null;
	};

	return (
		<div className="flex min-w-0 flex-col" data-process-group-id={props.group.id}>
			{/* 组头：w-full 占满内容列（与流式输出同宽），hover 底色因此铺满整行；
			    内部与现有过程行同构：22px 类别图标方块 → 文案 → chevron，左对齐右侧留白。
			    尺寸规则（2026 用户反馈修正）：组头**不得小于组体里的行**——成员行是
			    text-control(13px)/min-h-7(28px)/图标 16px，组头取同档 13px/28px 才不会出现
			    「容器比内容小」的倒置层级；层级改由字重（600 vs 400）与颜色（secondary vs faint）承担。
			    data-process-group-head 是 e2e/结构测试的稳定锚点（组头、组体、scroller 各一个）。 */}
			<button
				type="button"
				data-process-group-head=""
				className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md pl-0.5 pr-[7px] text-left text-control font-semibold text-text-secondary transition-colors duration-150 hover:bg-[color:color-mix(in_srgb,var(--color-text-primary)_4%,transparent)] hover:text-text-primary focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
				aria-expanded={props.open}
				aria-controls={bodyId}
				onClick={() => props.onToggle(!props.open)}
			>
				{/* 类别图标方块：运行中 = 工具身份色（12% 透明底 + 该色图标），已结束 = 中性灰（弱化） */}
				<span aria-hidden="true" className={`grid size-[22px] shrink-0 place-items-center rounded-md ${props.running ? "bg-[color:color-mix(in_srgb,var(--color-tool)_12%,transparent)] text-[var(--color-tool)]" : "bg-[color:color-mix(in_srgb,var(--color-text-tertiary)_13%,transparent)] text-text-tertiary"}`}>
					<Icon size={14} aria-hidden="true" />
				</span>
				{props.running ? (
					<>
						<ShimmerText text={runningLabel} className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" />
						{detail && (
							<>
								<span aria-hidden="true" className="shrink-0 text-text-faint">
									{t("timeline.processGroup.separator")}
								</span>
								<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-caption font-normal text-text-tertiary">{detail}</span>
							</>
						)}
					</>
				) : (
					<span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{doneLabel}</span>
				)}
				<span aria-hidden="true" className="inline-flex shrink-0 text-text-faint">
					{props.open ? <ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />}
				</span>
			</button>

			{props.open && (
				// 组体：缩进 + 竖线沿用现有展开区语言；限高交给内层 scroller，滚轮不外溢到时间线。
				<div id={bodyId} data-process-group-body="" className="ml-5 mt-1 border-l-2 border-border-subtle pl-3">
					<div data-process-group-scroller="" className="flex max-h-[min(320px,30vh)] flex-col overflow-y-auto overscroll-contain">
						{mounted.hiddenCount > 0 && (
							// 超出挂载预算的早期成员入口：与 TurnRow 的「显示更早的 N 条步骤」同款观感。
							<button
								type="button"
								className="mt-1 inline-flex h-[26px] shrink-0 items-center gap-2 self-start rounded-[var(--radius-md)] border border-border-subtle bg-[var(--color-chat-card-bg)] px-3 text-[length:var(--font-size-caption)] font-medium text-text-secondary transition-colors hover:border-border-strong hover:bg-bg-hover hover:text-text-primary"
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
			)}
		</div>
	);
});
