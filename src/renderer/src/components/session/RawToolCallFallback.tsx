import { memo, useState } from "react";
import { ChevronDown, ChevronRight, Unplug } from "lucide-react";
import { t } from "../../i18n";
import { TimelineMarker } from "./TimelineMarker";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";

/**
 * RawToolCallFallback — 「疑似未解析工具调用原文」兜底卡片（issue #315）。
 *
 * 触发：assistant 正文被 detectLeakedToolCallXml 判定为主要是模型/推理服务端
 * 漏出的工具调用协议 XML（如 <atem:function_calls>）。此时工具仍正常执行
 * （服务端同时发出了结构化 tool_calls），漏文本只是协议冗余；直接按 markdown
 * 渲染会刷屏、吞 `<`、把路径误渲染成链接，因此折叠为一条可展开的原始文本。
 *
 * 展示契约与 NotifyMessageCard 同构：默认收成一行（TimelineMarker 语言），
 * 展开看原文（纯 <pre>，不走 MarkdownStream——这正是本卡片存在的原因）。
 */
export const RawToolCallFallback = memo(function RawToolCallFallback(props: { text: string; messageId?: string }) {
	const [expanded, setExpanded] = useState(false);
	const lineCount = props.text.split("\n").length;

	return (
		<TimelineMarker kind="diagnostic" tone="warning">
			<article className="w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-[var(--color-chat-muted-bg)]" data-message-id={props.messageId} data-leaked-tool-call="1">
				<button
					type="button"
					className="flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption transition-colors duration-fast hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					title={expanded ? t("session.leakedToolCall.collapse") : t("session.leakedToolCall.expand")}
				>
					<Unplug className="size-3.5 shrink-0" aria-hidden="true" />
					<span className="min-w-0 flex-1 truncate text-text-secondary">{t("session.leakedToolCall.title")}</span>
					<span className="shrink-0 text-text-faint">{lineCount}</span>
					{expanded ? <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />}
				</button>
				{/* 折叠体走共享折叠原语：真高度渐变 + exit 后卸载；display:contents 根不生成盒子，折叠态零空档。 */}
				<Collapsible open={expanded} className="contents">
					{/* 纯文本渲染：不走 markdown（吞标签/autolink 正是本卡片要避开的行为）。
					    max-h 限高防超长原文撑爆时间线（资源边界规则）。 */}
					<CollapsibleContent>
						<pre className="m-0 max-h-96 overflow-auto border-t border-border-subtle px-3 py-2 text-caption text-text-secondary whitespace-pre-wrap break-all">{props.text}</pre>
					</CollapsibleContent>
				</Collapsible>
			</article>
		</TimelineMarker>
	);
});
