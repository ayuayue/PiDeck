/**
 * 模型请求轨迹详情：把 pi 发给供应商的完整请求体结构化展示（替代原始 JSON dump）。
 * 形态对齐 dsh-web Trajectory 的检查器：指标行 + 系统提示词区 + 完整消息流（含工具
 * 调用/结果/思考块）+ 工具定义区，原始 JSON 保留一键切换兜底。
 *
 * 数据来源：RPC 日志「模型」行展开时按 traceId 回读的 payloadJson（双方言解析见
 * utils/modelTraceParse）；摘要指标（model/provider/bytes/duration）来自条目 data，
 * 不重复解析。
 */
import { useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Copy, FileJson, ImageIcon, Sparkles, Wrench } from "lucide-react";
import { t } from "../../i18n";
import type { ModelTraceLogData } from "../../../../shared/types/rpcLog";
import { parseModelTracePayload, summarizeTraceMessage, type TraceBlock, type TraceMessage } from "../../utils/modelTraceParse";
import { Button } from "../ui-shadcn/button";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";
import { copyTextWithCopiedNotice } from "../../utils/clipboardNotice";
import { VirtualStack } from "../ui-shadcn/virtual-stack";

/** 块级内容最大高度：超长内容保持完整可滚，不截断文本本身 */
const BLOCK_MAX_H = "max-h-64";

function RoleBadge({ role }: { role: TraceMessage["role"] }) {
	const cls = role === "user" ? "bg-primary/15 text-primary" : role === "assistant" ? "bg-accent text-accent-foreground" : "bg-muted text-muted-foreground";
	// 显式映射而非模板拼接 key：t() 的 key 联合类型不接受动态字符串
	const labelKey = role === "user" ? "rpc.traceRoleUser" : role === "assistant" ? "rpc.traceRoleAssistant" : "rpc.traceRoleTool";
	return <span className={`inline-flex h-5 shrink-0 items-center rounded px-1.5 text-micro font-medium ${cls}`}>{t(labelKey)}</span>;
}

function TraceBlockView({ block }: { block: TraceBlock }) {
	switch (block.type) {
		case "text":
			// scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。
			return <div className={`whitespace-pre-wrap break-words text-xs leading-relaxed ${BLOCK_MAX_H} overflow-y-auto`}>{block.text}</div>;
		case "thinking":
			return (
				// scroll-ok: bounded —— 行数有硬上限（受控分页 / 上限常量 / 固定枚举），不随数据无限增长。
				<div className={`border-l-2 border-border pl-2 text-xs italic leading-relaxed text-muted-foreground/80 ${BLOCK_MAX_H} overflow-y-auto`}>
					<span className="mb-1 inline-flex items-center gap-1 text-micro not-italic">{t("rpc.traceThinking")}</span>
					{block.text}
				</div>
			);
		case "image":
			return (
				<span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-micro text-muted-foreground">
					<ImageIcon className="size-3" aria-hidden="true" />
					{t("rpc.traceImage")}
				</span>
			);
		case "tool_call":
			return (
				<div className="rounded-md bg-muted/60 p-2">
					<div className="mb-1 flex items-center gap-1.5 text-xs font-medium">
						<Wrench className="size-3 text-muted-foreground" aria-hidden="true" />
						{block.name}
					</div>
					{/* scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。 */}
					{block.args ? <pre className={`overflow-auto rounded bg-background/60 p-1.5 font-mono text-micro leading-snug ${BLOCK_MAX_H}`}>{block.args}</pre> : null}
				</div>
			);
		case "tool_result":
			return (
				<div className="rounded-md bg-muted/60 p-2">
					<div className="mb-1 flex items-center gap-1.5 text-micro uppercase tracking-wide text-muted-foreground">
						{t("rpc.traceToolResult")}
						{block.isError ? <span className="rounded bg-destructive/15 px-1 text-destructive">{t("rpc.traceToolError")}</span> : null}
					</div>
					{/* scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。 */}
					<pre className={`overflow-auto whitespace-pre-wrap break-words font-mono text-micro leading-snug ${block.isError ? "text-destructive" : ""} ${BLOCK_MAX_H}`}>{block.text}</pre>
				</div>
			);
	}
}

/** 消息行：默认折叠为一行摘要（角色 + 摘要 + 字符数），点击展开完整块内容 */
function TraceMessageRow({ message, index }: { message: TraceMessage; index: number }) {
	const [open, setOpen] = useState(false);
	// 折叠体走共享折叠原语：真高度渐变而非高度硬跳（同 composer 折叠条），reduced-motion 自动回退。
	// 外层直接当 Collapsible 根（仍渲染 div），DOM 层级不变，不引入多余盒模型。
	return (
		<Collapsible open={open} className="border-b border-border/40 last:border-b-0">
			<button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent-soft" onClick={() => setOpen((value) => !value)}>
				<span className="shrink-0 tabular-nums text-micro text-muted-foreground/60">{index + 1}</span>
				{open ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
				<RoleBadge role={message.role} />
				<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{summarizeTraceMessage(message)}</span>
				<span className="shrink-0 tabular-nums text-micro text-muted-foreground/60">{t("rpc.traceChars", { n: message.chars })}</span>
			</button>
			{/* 不再挂 animate-in/fade-in：cn 的 twMerge 会把 animate-* 判同组，保留会盖掉原语的高度动画。 */}
			<CollapsibleContent className="flex flex-col gap-2 px-2 pb-2 pl-9">
				{message.blocks.map((block, blockIndex) => (
					<TraceBlockView key={blockIndex} block={block} />
				))}
			</CollapsibleContent>
		</Collapsible>
	);
}

/** 可折叠区段头（系统提示词 / 工具定义 / 原始 JSON 共用） */
function SectionHeader({ icon, label, meta, open, onToggle, children }: { icon: ReactNode; label: string; meta?: string; open: boolean; onToggle: () => void; children?: ReactNode }) {
	return (
		<Collapsible open={open} className="border-b border-border/40 last:border-b-0">
			<button type="button" className="flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-accent-soft" onClick={onToggle}>
				{open ? <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" /> : <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
				{icon}
				<span className="text-xs font-medium">{label}</span>
				{meta ? <span className="min-w-0 flex-1 truncate text-micro text-muted-foreground/70">{meta}</span> : <span className="flex-1" />}
			</button>
			<CollapsibleContent>{children}</CollapsibleContent>
		</Collapsible>
	);
}

export function ModelTraceDetail({ payloadJson, summary }: { payloadJson: string; summary: ModelTraceLogData }) {
	const [systemOpen, setSystemOpen] = useState(false);
	const [toolsOpen, setToolsOpen] = useState(false);
	// 系统提示词分段的滚动窗交给 VirtualStack 自己驱动：ref 必须真的接到那个 div 上，
	// 否则虚拟器拿不到 scrollElement，视口高度恒 0、一行都不渲染（2026-10 审查抓到）。
	const segmentListRef = useRef<HTMLDivElement | null>(null);
	const [rawOpen, setRawOpen] = useState(false);
	// 解析失败（截断/畸形）时降级：不渲染残缺结构化视图，直接显示原始 JSON
	const view = useMemo(() => parseModelTracePayload(payloadJson), [payloadJson]);
	const showStructured = !view.truncated;

	return (
		<div className="flex flex-col gap-2 text-foreground">
			{/* 指标行：全部来自条目摘要（采集时已算好），不重复扫描 payload */}
			<div className="flex flex-wrap items-center gap-1.5 px-1 text-micro text-muted-foreground">
				{summary.model ? <span className="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">{summary.model}</span> : null}
				{summary.provider ? <span className="rounded bg-muted px-1.5 py-0.5">{summary.provider}</span> : null}
				{showStructured ? (
					<>
						<span className="rounded bg-muted px-1.5 py-0.5">{t("rpc.traceMsgCount", { n: view.messages.length })}</span>
						{view.tools.length > 0 ? <span className="rounded bg-muted px-1.5 py-0.5">{t("rpc.traceToolCount", { n: view.tools.length })}</span> : null}
						{view.stream ? <span className="rounded bg-muted px-1.5 py-0.5">stream</span> : null}
						{view.reasoningEffort ? <span className="rounded bg-muted px-1.5 py-0.5">{view.reasoningEffort}</span> : null}
					</>
				) : null}
				{summary.payloadBytes ? <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">{(summary.payloadBytes / 1024).toFixed(1)} KB</span> : null}
				{summary.durationMs != null ? <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">{(summary.durationMs / 1000).toFixed(2)}s</span> : null}
				{summary.truncated || view.truncated ? <span className="rounded bg-warning/15 px-1.5 py-0.5 text-warning">{t("rpc.traceTruncated")}</span> : null}
				{view.parseError ? (
					<span className="truncate" title={view.parseError}>
						{view.parseError}
					</span>
				) : null}
			</div>

			{showStructured && (
				<div className="overflow-hidden rounded-md border border-border/60 bg-background">
					{/* 系统提示词（含技能上下文等装配产物）：体量大且跨请求基本不变，默认折叠 */}
					{view.system ? (
						<SectionHeader
							icon={<Sparkles className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />}
							label={t("rpc.traceSystemPrompt")}
							meta={t("rpc.traceSystemMeta", { chars: view.system.text.length, segments: view.system.segments.length })}
							open={systemOpen}
							onToggle={() => setSystemOpen((value) => !value)}
						>
							<div className="flex flex-col">
								{/*
									 系统提示词分段列表：段数随供应商/工具定义增长（几十到上百段），
									 而外层是 `max-h-72` 的限高窗——正是「行数随数据无限增长 + 有滚动视口」
									 的形态，接虚拟栈。

									 行高方差很大（每段是 whitespace-pre-wrap 的正文），所以必须靠 measureElement
									 实测而不是估值；VirtualStack 的默认行为就是实测。

									 短列表（≤ minRows，这里给的 8 段）时 VirtualStack 直出 Fragment，DOM 与接入前逐字一致。
									*/}
								<div ref={segmentListRef} className="max-h-72 overflow-y-auto px-3 py-2">
									<VirtualStack scrollRef={segmentListRef} items={view.system.segments} getKey={(_segment, index) => String(index)} estimateHeight={28} minRows={8} renderItem={(segment) => <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{segment}</p>} rowClassName="pb-1" />
								</div>
								<div className="flex justify-end border-t border-border/40 px-2 py-1">
									<Button type="button" variant="ghost" size="sm" className="h-6 gap-1 px-2 text-micro" onClick={() => void copyTextWithCopiedNotice(view.system!.text)}>
										<Copy className="size-3" aria-hidden="true" />
										{t("common.copy")}
									</Button>
								</div>
							</div>
						</SectionHeader>
					) : null}

					{/* 消息流：完整对话轨迹（用户/助手/工具调用与结果/思考块） */}
					<div className="flex items-center gap-2 border-b border-border/40 bg-muted/30 px-2 py-1 text-xs font-medium">{t("rpc.traceMessages")}</div>
					{view.messages.map((message, index) => (
						// key 不能用下标：切换 trace 目标时同位置的展开态会挂到另一条消息上。
						// 指纹用「下标 + 角色 + 字符数」——不要用 summarizeTraceMessage：它对整段正文跑正则，
						// 行内还要再算一次，等于每次渲染两遍全量替换。缺口：同位置、同角色、同字符数但内容
						// 不同时仍会复用展开态——payload 固定，这里接受。
						<TraceMessageRow key={`${index}:${message.role}:${message.chars}`} message={message} index={index} />
					))}

					{/* 工具定义：请求携带的工具表，默认折叠 */}
					{view.tools.length > 0 ? (
						<SectionHeader icon={<Wrench className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />} label={t("rpc.traceToolDefs")} meta={t("rpc.traceToolCount", { n: view.tools.length })} open={toolsOpen} onToggle={() => setToolsOpen((value) => !value)}>
							<div className="flex flex-col gap-1 px-3 py-2">
								{view.tools.map((tool) => (
									<div key={tool.name} className="text-xs">
										<span className="font-mono font-medium">{tool.name}</span>
										{tool.description ? <span className="ml-1.5 text-muted-foreground">{tool.description.replace(/\s+/g, " ").slice(0, 140)}</span> : null}
									</div>
								))}
							</div>
						</SectionHeader>
					) : null}
				</div>
			)}

			{/* 原始 JSON 兜底：结构化视图覆盖不了的细节（新增供应商字段/解析失败）从这里看 */}
			<SectionHeader icon={<FileJson className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />} label={t("rpc.traceRawJson")} open={rawOpen} onToggle={() => setRawOpen((value) => !value)}>
				{/* scroll-ok: text —— 单一文本块（原始 JSON 全文），没有「行列表」可虚拟化；整段给浏览器原生滚动 */}
				<pre className="rpc-log-detail max-h-72 overflow-auto">{payloadJson}</pre>
			</SectionHeader>
		</div>
	);
}
