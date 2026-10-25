import { memo, useCallback, useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { ProcessEntryReturnToStart } from "./turn/ProcessEntryReturnToStart";
import { useProcessEntryStickyHeader } from "./turn/useProcessEntryStickyHeader";
import { Brain, Check, ChevronDown, ChevronRight, CircleX, FileText, Folder, Globe2, Loader2, MessageCircle, Network, Scissors, Search, Square, SquarePen, Terminal, Wrench } from "lucide-react";
import { countTextLines, getToolEditDiff, getToolFilePath, parseToolArgs, type ToolGroupItem } from "../app/AppUtils";
import { t } from "../../i18n";
import { formatAskTitle } from "../../utils/askUi";
import { Badge } from "../ui-shadcn/badge";
import { detectSubagentFailure } from "./subagentStatus";
import { Button } from "../ui-shadcn/button";
import type { ChatMessage } from "../../../../shared/types";
import { TimelineMarker } from "./TimelineMarker";
import { RowText } from "./RowText";
import { LiveDuration } from "./LiveDuration";
import { getToolKind, getToolKindLabel } from "./toolKind";
import { getToolPhraseFromArgs } from "./timeline/toolPhrase";
import { ToolResult, ToolResultOutput } from "../agents/tool-result";
import { FileDiff } from "../agents/file-diff";
import { desktopApi } from "../../desktopApi";
import { copyTextWithCopiedNotice } from "../../utils/clipboardNotice";
import { formatDuration, getToolDetailText, getToolDiffTarget, getToolExitCode, getToolLiveStartTimestamp, getToolName, getToolStatus, fileChangeToDiffLines } from "./TimelineFormat";
import { useInsideProcessGroupBody } from "./turn/processGroupScrollContext";

export type DiffFileHandler = (path: string, originalContent?: string, content?: string) => void;

type AskCardSummary = {
	question?: string;
	type?: string;
	answered?: boolean;
	answer?: unknown;
	answerLabel?: string;
	options?: Array<string | { label?: string; value?: unknown; description?: string }>;
	questions?: AskCardSummary[];
};

function askAnswerText(answer: unknown, label?: string): string {
	if (label?.trim()) return label;
	if (typeof answer === "string") return answer;
	if (typeof answer === "boolean") return answer ? t("common.true") : t("common.false");
	// multi_select 的 answer 是选中项数组；label 缺失时拼接展示而非误标未回答
	if (Array.isArray(answer)) return answer.join("、");
	return t("ask.unanswered");
}

function toolIcon(toolName: string): ReactNode {
	const key = toolName.toLowerCase();
	if (key.includes("read") || key.includes("view")) return <FileText size={16} />;
	if (key.includes("write") || key.includes("edit") || key.includes("apply_patch") || key.includes("patch")) return <SquarePen size={16} />;
	if (key.includes("bash") || key.includes("shell") || key.includes("terminal")) return <Terminal size={16} />;
	if (key.includes("grep") || key.includes("search")) return <Search size={16} />;
	if (key.includes("glob") || key.includes("list") || key.includes("ls")) return <Folder size={16} />;
	if (key.includes("task") || key.includes("subagent") || key.includes("agent")) return <Network size={16} />;
	if (key.includes("web") || key.includes("fetch")) return <Globe2 size={16} />;
	if (key.includes("todo")) return <Check size={16} />;
	return <Wrench size={16} />;
}

/** 从工具消息 meta 中提取副标题（文件路径或命令），让 trigger 行能体现工具作用对象。
 *  pi 的工具参数可能是对象，也可能已被主进程截断/序列化为 JSON 字符串；两种格式都要兼容，否则 bash 命令摘要会丢失。 */
function getToolSubtitle(message: ChatMessage): string {
	const meta = message.meta;
	if (!meta) return "";
	// 优先从 args 取参数（pi 工具事件的标准结构）
	const args = parseToolArgs(meta.args);
	if (args) {
		for (const key of [
			// 文件操作类
			"filePath",
			"file_path",
			"path",
			"file",
			// bash/shell 命令
			"command",
			// 搜索/查询类（grep、web_search 等）
			"pattern",
			"query",
			"queries",
			// 网络获取类（fetch_content 等）
			"url",
			"urls",
			// 待办事项类（todo 等）
			"action",
			"text",
		]) {
			const v = args[key];
			if (typeof v === "string" && v) return v;
			// queries 和 urls 是数组，取第一条
			if (Array.isArray(v) && v.length > 0 && typeof v[0] === "string") return v[0];
		}
	}
	// 兼容历史平铺写法
	const path = meta.path;
	if (typeof path === "string" && path) return path;
	const command = meta.command;
	if (typeof command === "string" && command) return command;
	const file = meta.file;
	if (typeof file === "string" && file) return file;
	// 兜底：取 args 中第一个非空字符串值
	if (args && typeof args === "object") {
		for (const val of Object.values(args as Record<string, unknown>)) {
			if (typeof val === "string" && val) return val;
		}
	}
	return "";
}

/**
 * 识别模型主动触发的 skill：pi 系统提示会指示 LLM 用 read 工具读取 SKILL.md 来加载 skill，
 * 所以 toolName==="read" 且 path 以 SKILL.md 结尾时，视为 skill 调用，返回 skill 名（父目录名）。
 * 这是模型侧的 skill 触发，与用户侧 /skill:name 展开成 <skill> 块不同。
 */
function getReadSkillName(message: ChatMessage): string | undefined {
	const meta = message.meta;
	if (!meta) return;
	const toolName = typeof meta.toolName === "string" ? meta.toolName : "";
	if (toolName.toLowerCase() !== "read") return;
	const args = meta.args as Record<string, unknown> | undefined;
	if (!args || typeof args !== "object") return;
	const rawPath = String(args.path ?? args.filePath ?? args.file_path ?? "");
	if (!rawPath) return;
	// 取最后一段文件名与父目录名，跨平台分隔符兼容
	const segs = rawPath.split(/[\\/]/).filter(Boolean);
	const fileName = segs[segs.length - 1] ?? "";
	if (fileName.toUpperCase() !== "SKILL.MD") return;
	return segs[segs.length - 2] ?? fileName;
}

/** 计算工具的语气色：running 黄、error 红、其余 ok。
 * 工具内部命令失败（exitCode != 0）不影响工具调用本身的成功状态，
 * 因此不根据 exitCode 变色，只有工具调用层面出错才标红。 */
function getToolTone(message: ChatMessage): "running" | "error" | "ok" {
	const status = getToolStatus(message);
	if (status === "running") return "running";
	if (status === "error" || message.meta?.isError === true) return "error";
	return "ok";
}

/**
 * AI Elements Tool 风格的实时工具活动卡片：运行阶段使用轻量 shimmer 和状态轨道，
 * 不依赖工具结果消息，避免 streaming 期间出现空白或跳变。
 */
export const ToolActivityCard = memo(function ToolActivityCard(props: { name: string }) {
	return (
		<section className="tool-activity-card" data-status="running" aria-live="polite">
			<span className="tool-activity-icon">{toolIcon(props.name)}</span>
			<div className="tool-activity-copy">
				<span className="tool-activity-name">{props.name}</span>
				<span>{t("tool.statusRunning")}</span>
			</div>
			<span className="tool-activity-pulse" aria-hidden="true">
				<i />
				<i />
				<i />
			</span>
		</section>
	);
});

/**
 * 工具结果内层的限高：组体内让位（null），组外保持既有 320。
 *
 * 见 `turn/processGroupScrollContext.ts`：组体已经是「限高 + 一条滚轮」，组内再套一层
 * 限高滚动区就是用户看到的双层滚动条（内层到边即被 contain 切断，外层不动）。
 */
const TOOL_RESULT_MAX_HEIGHT_OUTSIDE_GROUP = 320;

/** 单个工具调用卡片：trigger 行（图标+工具名+副标题+状态+耗时）+ 展开后详情。 */
export const ToolCard = memo(function ToolCard(props: {
	message: ChatMessage;
	defaultOpen?: boolean;
	/** 停止时 tool end 可能永远不会到达，避免遗留 running 状态继续播放动画。 */
	stopped?: boolean;
	/** 所属会话 id：运行期绑定不可用时（历史会话 _viewer 投影）回退会话文件定位 */
	sessionId?: string;
	/** 通过会话工作区路由打开工具目标文件（相对路径由 App 层补齐工作目录） */
	onOpenFile?: (path: string) => void;
}) {
	// 组体内：外层组体已经限高并自带滚轮，这里的内层必须让位，否则是双层滚动条。
	const insideProcessGroupBody = useInsideProcessGroupBody();
	const [expanded, setExpanded] = useState(props.defaultOpen ?? false);
	const sticky = useProcessEntryStickyHeader(expanded);
	const toggleExpanded = useCallback(() => {
		sticky.prepareCollapse();
		setExpanded((value) => !value);
	}, [sticky.prepareCollapse]);
	const messageStatus = getToolStatus(props.message);
	const status = props.stopped && messageStatus === "running" ? "stopped" : messageStatus;
	const toolName = getToolName(props.message);
	const detailText = getToolDetailText(props.message);
	// pi-subagents 的 Agent/get_subagent_result 失败时返回普通文本结果（无 isError 标记），
	// 失败只能从结果头部的 "Status: error|stopped|aborted" 探测；探测到则整卡按失败渲染。
	const subagentFailure = toolName === "Agent" || toolName === "get_subagent_result" ? detectSubagentFailure(`${typeof props.message.meta?.result === "string" ? props.message.meta.result : ""}\n${detailText}`) : undefined;
	// 工具结果截断标记（主进程 truncateDetailWithMeta 写入）：展开区可「查看完整输出」
	// 按需读取（运行期走主进程内存缓存，历史会话定位读会话文件）。
	const isTruncated = props.message.meta?.truncated === true;
	// pi 侧截断（pi 0.99 起 bash/powershell 输出 >1 MiB 时 result.details.truncation）：
	// 丢的是 pi 没进上下文的内容，完整文件在 resultTruncation.fullOutputPath，与上面
	// 展示层截断是两件事，因此单独给一行可复制路径而不是复用「查看完整输出」。
	const piTruncation = props.message.meta?.resultTruncation as { fullOutputPath?: string } | undefined;
	const [fullText, setFullText] = useState<string | null>(null);
	const [fullLoading, setFullLoading] = useState(false);
	const [fullError, setFullError] = useState(false);
	const displayText = fullText ?? detailText;
	const loadFullText = async () => {
		if (fullLoading) return;
		setFullLoading(true);
		setFullError(false);
		try {
			const result = await desktopApi.sessions.readMessageFullText(props.sessionId, props.message.agentId, props.message.id, typeof props.message.meta?.entryId === "string" ? props.message.meta.entryId : undefined);
			setFullText(result.text);
		} catch {
			setFullError(true);
		} finally {
			setFullLoading(false);
		}
	};
	const tone = subagentFailure ? "error" : status === "stopped" ? "ok" : getToolTone(props.message);
	const subtitle = getToolSubtitle(props.message);
	const kindLabel = getToolKindLabel(toolName);
	// write/edit/create/patch 工具：从参数直接取 diff 目标（写整文件新内容 /
	// 编辑的 oldText→newText 变动区），展开区优先展示 diff 而不是原始结果文本。
	const diffTarget = getToolDiffTarget(props.message);
	const showDiff = diffTarget !== undefined;
	// 学 ZCode 过程行：主标签是语义动词（「读取」「执行」），作用对象进等宽 chip 单行截断；
	// 原始工具名退到行 tooltip，不再常驻行内与动词重复占位。
	const phrase = getToolPhraseFromArgs(toolName, props.message.meta?.args);
	const durationMs = typeof props.message.meta?.durationMs === "number" ? props.message.meta.durationMs : undefined;
	// 模型用 read 工具读取 SKILL.md 来加载 skill：识别后以 skill 徽标样式渲染
	const skillName = getReadSkillName(props.message);
	const isSkillRead = Boolean(skillName);
	// 历史会话中从 ask_question 工具结果反推的提问卡片数据；运行中（等待回答）时
	// 结果尚未落地、meta 没有 _askCard，只能靠 toolName + running 识别，否则等待期
	// 会退化为普通工具卡用 LiveDuration 持续计时（2026-09 用户反馈「ask 时时间还在计时」）。
	const askCard = props.message.meta?._askCard as AskCardSummary | undefined;
	const isAskCard = Boolean(askCard?.question) || (toolName.toLowerCase() === "ask_question" && status === "running");
	// 状态徽章：running / stopped / error（含子代理失败）保留 pill 一眼可辨；
	// 2026-10 对齐 ZCode 静默完成态——普通完成**不再渲染徽章**，「无状态即成功」，
	// 完成行回归安静的一行灰（此前常驻绿色「完成」徽章让整屏过程行比正文还吵）。
	// ask_question 例外：已回答保留低强调徽章，「等待→已回答」的跃迁对它有信息量。
	// 2026-11：移除 running 的转圈动画（用户反馈动画具干扰性），只保留「进行中」文字；
	// 状态仍由 tool_execution_start/end 事件驱动，语义不变。
	const statusBadge = (() => {
		if (status === "running") {
			return (
				<Badge variant="outline" className="gap-1 border-warning/40 px-1 py-0 text-chat-detail text-warning">
					{t("tool.statusRunning")}
				</Badge>
			);
		}
		if (status === "stopped") {
			return (
				<Badge variant="outline" className="gap-1 border-border-subtle px-1 py-0 text-chat-detail text-text-tertiary">
					<Square size={8} aria-hidden="true" />
					{t("tool.statusStopped")}
				</Badge>
			);
		}
		if (subagentFailure) {
			// 子代理失败：插件返回普通文本结果（无 isError），此处按探测出的终态渲染失败徽标
			const label = subagentFailure === "stopped" ? t("tool.statusStopped") : subagentFailure === "aborted" ? t("tool.statusAborted") : t("tool.statusError");
			return (
				<Badge variant="outline" className="gap-1 border-danger/40 bg-danger-soft px-1 py-0 text-chat-detail text-danger">
					<CircleX size={9} aria-hidden="true" />
					{label}
				</Badge>
			);
		}
		if (status === "error") {
			// 失败用 soft 红（danger-soft 淡红底 + danger 红字 + 淡红描边），
			// 不采用实心 destructive 红底白字——单条工具失败不需要最高警告级的视觉冲击。
			return (
				<Badge variant="outline" className="gap-1 border-danger/40 bg-danger-soft px-1 py-0 text-chat-detail text-danger">
					<CircleX size={9} aria-hidden="true" />
					{t("tool.statusError")}
				</Badge>
			);
		}
		if (askCard?.answered) {
			return (
				<Badge variant="outline" className="gap-1 border-success/40 bg-success-soft px-1 py-0 text-chat-detail text-success">
					{t("ask.answered")}
				</Badge>
			);
		}
		return null;
	})();
	// 行 tooltip 承接从行内撤下的信息（2026-10 ZCode 式静默行）：原始工具名、完整参数摘要、
	// 完成后的耗时——行内只留「动词 + chip 预览」，细节 hover 可达而不是常驻噪音。
	const rowTitleParts = [isSkillRead ? `skill:${skillName}` : toolName, subtitle].filter(Boolean);
	if (status !== "running" && durationMs !== undefined) rowTitleParts.push(`${t("tool.durationTitle")} ${formatDuration(durationMs)}`);
	const rowTitle = rowTitleParts.join("\n");
	return (
		<TimelineMarker
			kind="tool"
			tone={tone === "error" ? "error" : tone === "running" ? "active" : "success"}
			// 工具/思考同为过程行：底距都压到 pb-1，不再给工具单独留卡片呼吸空间
			contentClassName="pb-1"
		>
			<section
				// 无框过程行（与 ThinkingBlock 同一语言）：边框/面板底由 timeline.css 的
				// .tool-card 保证为 0/transparent，这里不再叠 border / bg-bg-panel。
				className={`tool-card w-full min-w-0 tone-${tone}${isSkillRead ? " tool-card--skill" : ""}${isAskCard ? " tool-card--ask" : ""}${status === "running" ? " tool-card--running" : ""}`}
				ref={sticky.entryRef}
				data-status={status}
				data-tool-kind={isSkillRead ? "skill" : getToolKind(toolName)}
				data-message-id={props.message.id}
			>
				<div
					ref={sticky.headerRef}
					data-process-entry-header=""
					data-process-entry-pinned={sticky.pinned}
					className={cn(
						"relative flex min-h-7 items-center overflow-hidden rounded-md transition-colors duration-fast hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)]",
						sticky.sticky && "sticky top-0 z-10",
						sticky.pinned && "rounded-none bg-bg-app shadow-[0_1px_0_var(--color-border-subtle)] hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,var(--color-bg-app))]",
					)}
				>
					{/* 工具运行中整行扫光（dsh-web command-row-sweep 同款，与思考扫光同 keyframes）。
					    status === "running" 才挂载：stopped/error/done 立即消失（stopped 由 props.stopped 短路）；
					    pointer-events-none 不挡 trigger 点击展开 */}
					{status === "running" && <span aria-hidden className="pointer-events-none absolute inset-y-0 left-[-300px] w-[300px] animate-tool-sweep motion-reduce:animate-none bg-[linear-gradient(90deg,transparent,color-mix(in_srgb,var(--color-bg-app)_55%,transparent),transparent)]" />}
					<button type="button" className="flex min-h-7 min-w-0 flex-[1_1_auto] cursor-pointer items-center gap-2 border-0 bg-transparent py-1 pr-0.5 pl-1 text-left text-chat-row text-text-faint focus-visible:-outline-offset-2 focus-visible:outline-2" onClick={toggleExpanded} aria-expanded={expanded} title={rowTitle}>
						<span className="tool-card-icon inline-flex shrink-0 items-center justify-center">{isSkillRead ? <Brain size={16} /> : isAskCard ? <MessageCircle size={16} /> : toolIcon(toolName)}</span>
						{/* 文本段：动词标签（14px）与等宽 chip 预览（12px）必须共基线，否则等宽详情
						    比正文高约 3px、看起来「没纵向居中」（原理解释见 RowText）。
						    徽章 / chevron / kind pill 是盒子，self-center 保持原有居中观感。 */}
						<RowText className="flex-[1_1_auto]">
							{/* 主标签 = 语义动词（「读取」「执行」）：过程层文字，用 faint 浅色退到正文之后；
							    字重保持 normal（不降档），过轻在 CJK 下会有锯齿/发虚。
							    原始工具名已移进行 tooltip，MCP 来源仍由 kind pill 标识。 */}
							<span className="shrink-0 text-chat-row lowercase text-text-faint">{isSkillRead ? `skill:${skillName}` : isAskCard ? t("ask.toolName") : phrase.verb}</span>
							{expanded ? <ChevronDown size={14} className="shrink-0 self-center text-text-faint" aria-hidden="true" /> : <ChevronRight size={14} className="shrink-0 self-center text-text-faint" aria-hidden="true" />}
							{!isSkillRead && kindLabel && <span className="tool-card-kind self-center">{kindLabel}</span>}
							{statusBadge && <span className="inline-flex self-center">{statusBadge}</span>}
							{/* 耗时只对运行中的工具有行内意义（活秒表）；完成后的耗时移入行 tooltip，
							    与静默完成态一致（学 ZCode：单条耗时撤出常驻行，交给 hover）。 */}
							{status === "running" && (
								<span className="shrink-0 text-chat-detail tabular-nums text-text-tertiary" title={isAskCard ? t("ask.waitingHint") : t("tool.durationTitle")}>
									{isAskCard ? (
										// ask 等待用户回答阶段不计入工具耗时：不展示累加秒表，改用「等待回答…」
										// 提示。用户回答后 tool_execution_end 落地的 durationMs 已由主进程扣除等待时长。
										t("ask.waitingForAnswer")
									) : (
										// 工具执行中：以 meta.startedAt 为秒表起点实时计时。消息 timestamp 会被主进程
										// 在每次 update/end 时刷新（见 getToolLiveStartTimestamp），直接用会让长命令的
										// 耗时显示反复归零，结束才突然跳到总时长。
										<LiveDuration startedAt={getToolLiveStartTimestamp(props.message)} isStreaming />
									)}
								</span>
							)}
							{isAskCard && askCard?.question ? (
								<span className="min-w-0 flex-[1_1_auto] whitespace-normal break-words font-mono text-chat-detail text-text-faint" title={askCard.question}>
									| {askCard.question}
								</span>
							) : !isSkillRead && (phrase.object || subtitle) ? (
								// 作用对象预览 chip（学 ZCode）：等宽 + 极浅底 + 单行截断；
								// 长命令/路径的完整内容在行 tooltip 里，chip 只做扫读锚点。
								<span className="min-w-0 flex-[0_1_auto] truncate rounded-[var(--radius-xs)] bg-[color:color-mix(in_srgb,var(--color-text-primary)_5%,transparent)] px-1.5 font-mono text-chat-detail text-text-tertiary" title={phrase.object || subtitle}>
									{phrase.object || subtitle}
								</span>
							) : null}
						</RowText>
					</button>
					{sticky.pinned && <ProcessEntryReturnToStart onClick={sticky.returnToStart} />}
				</div>
				{expanded && (
					<div className="relative ml-5 mt-1 mb-2 rounded-b-sm border-l-2 border-border-subtle bg-transparent pl-3 animate-in fade-in duration-fast motion-reduce:animate-none">
						{isAskCard && askCard ? (
							<div className="ask-question-card-tool-inner">
								<div className="ask-question-card-title">
									<MessageCircle size={13} />
									<span>{t("ask.question")}</span>
									<span className="ask-question-card-status">{askCard.answered ? t("ask.answered") : t("ask.unanswered")}</span>
								</div>
								<div className="ask-question-card-result-list">
									{(askCard.questions?.length ? askCard.questions : [askCard]).map((item, index) => (
										<div key={`${item.question ?? "question"}:${index}`} className="ask-question-card-result-row">
											<span className="ask-question-card-result-index">{(askCard.questions?.length ?? 0) > 1 ? index + 1 : "?"}</span>
											<div className="ask-question-card-result-copy">
												<span className="ask-question-card-result-question">{formatAskTitle(item.question || t("ask.defaultTitle"))}</span>
												<span className={`ask-question-card-result-answer${item.answered ? " answered" : " unanswered"}`}>
													{item.answered ? <Check size={12} aria-hidden="true" /> : null}
													{item.answered ? askAnswerText(item.answer, item.answerLabel) : t("ask.unanswered")}
												</span>
											</div>
										</div>
									))}
								</div>
							</div>
						) : (
							<>
								{showDiff && diffTarget && (
									// 文件工具内联 diff（issue-兼容期：edit/write 的工具卡直接看改动，
									// 不必再点开右侧差异查看器）。折叠态渲染行；maxHeight 上限防长文件撑爆卡片。
									<div className="mb-1.5 flex min-w-0 items-start gap-1">
										<FileDiff className="min-w-0 flex-1" file={diffTarget.path} lines={fileChangeToDiffLines(diffTarget)} status="complete" defaultOpen={false} maxHeight={insideProcessGroupBody ? null : 200} language="diff" />
										{props.onOpenFile && (
											// 打开按钮与 diff 标题同行但不嵌套在 FileDiff 的折叠按钮内，
											// 避免无效的 button 嵌套；路径解析交给会话工作区统一处理。
											<div className="flex h-9 shrink-0 items-center">
												<Button type="button" variant="ghost" size="icon-xs" className="size-6 rounded text-text-tertiary hover:bg-muted hover:text-foreground" aria-label={t("tool.openFile")} title={t("tool.openFile")} onClick={() => props.onOpenFile?.(diffTarget.path)}>
													<FileText size={12} aria-hidden="true" />
												</Button>
											</div>
										)}
									</div>
								)}
								<ToolResult
									showHeader={false}
									tool={toolIcon(toolName)}
									title={toolName}
									status={status === "running" ? "running" : status === "error" ? "error" : "success"}
									kind={toolName.toLowerCase().includes("bash") || toolName.toLowerCase().includes("shell") ? "terminal" : "custom"}
									maxHeight={insideProcessGroupBody ? null : TOOL_RESULT_MAX_HEIGHT_OUTSIDE_GROUP}
									copyText={displayText}
									copyClassName="tool-card-copy"
									contentClassName="text-text-tertiary"
								>
									<ToolResultOutput>{displayText}</ToolResultOutput>
								</ToolResult>
							</>
						)}
						{piTruncation?.fullOutputPath ? (
							// pi 侧截断提示：完整输出在磁盘文件里，给出路径 + 一键复制（PiDeck 不代读
							// pi 的截断文件：那是 pi 的内部产物，路径交给用户自行查看/检索）。
							<div className="flex items-center gap-2 pl-1 pb-1">
								<Scissors size={12} className="shrink-0 text-text-tertiary" aria-hidden="true" />
								<span className="min-w-0 flex-1 truncate text-chat-detail text-text-tertiary" title={piTruncation.fullOutputPath}>
									{t("tool.piOutputTruncated", { path: piTruncation.fullOutputPath })}
								</span>
								<Button type="button" variant="ghost" size="sm" className="h-auto px-1 py-0 text-chat-detail text-text-tertiary hover:text-text-secondary" onClick={() => void copyTextWithCopiedNotice(piTruncation.fullOutputPath ?? "")}>
									{t("tool.copyPath")}
								</Button>
							</div>
						) : null}
						{isTruncated && !fullText && (
							// 截断提示后的按需加载入口：内容完整与否由主进程决定（内存缓存/会话文件），
							// 失败时保留重试，不让用户卡死在加载态。
							<div className="flex items-center gap-2 pl-1 pb-1">
								{fullError ? (
									<>
										<span className="text-chat-detail text-text-tertiary">{t("tool.fullOutputLoadFailed")}</span>
										<Button type="button" variant="ghost" size="sm" className="h-auto px-1 py-0 text-chat-detail text-text-tertiary hover:text-text-secondary" onClick={() => void loadFullText()}>
											{t("tool.retry")}
										</Button>
									</>
								) : (
									<Button type="button" variant="ghost" size="sm" className="h-auto gap-1 px-1 py-0 text-chat-detail text-text-tertiary hover:text-text-secondary" disabled={fullLoading} onClick={() => void loadFullText()}>
										{fullLoading ? <Loader2 size={12} className="animate-pideck-spin" aria-hidden="true" /> : null}
										{fullLoading ? t("tool.loadingFullOutput") : t("tool.viewFullOutput")}
									</Button>
								)}
							</div>
						)}
					</div>
				)}
			</section>
		</TimelineMarker>
	);
});
/** 工具组直接平铺为工具列表；每个 ToolCard 自己默认折叠，避免外层再占一行。 */
export const ToolGroupCard = memo(function ToolGroupCard(props: {
	group: ToolGroupItem;
	stopped?: boolean;
	/** 所属会话 id（转交 ToolCard「查看完整输出」的历史会话文件回退） */
	sessionId?: string;
	/** 转交给每张工具卡的文件打开路由 */
	onOpenFile?: (path: string) => void;
}) {
	// 组内标题要越过工具组裁切边界吸住组体；组外继续保留原裁切行为。
	const insideProcessGroupBody = useInsideProcessGroupBody();
	return (
		<section className={cn("tool-group-card w-full min-w-0 rounded-none border-0 bg-transparent", insideProcessGroupBody ? "overflow-visible" : "overflow-hidden")} data-message-id={props.group.id}>
			<div className="flex flex-col gap-0 p-0">
				{props.group.messages.map((message) => (
					<ToolCard key={message.id} message={message} stopped={props.stopped} sessionId={props.sessionId} onOpenFile={props.onOpenFile} />
				))}
			</div>
		</section>
	);
});
