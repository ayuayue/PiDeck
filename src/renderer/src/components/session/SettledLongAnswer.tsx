import { memo, useState } from "react";
import { t } from "../../i18n";
import { MarkdownStream } from "./MarkdownStream";
import { settledCollapsePreview, shouldCollapseSettledText } from "./markdownStreamPolicy";

/**
 * 超长 settled 正文的折叠渲染（2026-10 DSH 长回合事故引入，阈值见 markdownStreamPolicy）：
 * 默认只渲染预览前缀，点「展开全文」才构建完整 markdown DOM（展开后仍受 SETTLE_FULL_MAX_CHARS
 * 轻量插件上限约束）。目的：把单条巨型回复（100-200KB，数千段落）的常驻 DOM 封顶，
 * 避免长回合 settle 后滚动/布局全程卡顿、内存拖慢整机。
 *
 * 2027-02 从 AnswerOutput 提出为共享组件：折叠保护原来只挂在「中间回复」路径，
 * 而最典型的长产出载体——**最终回答**（AssistantText）——没有任何长度守卫，
 * 几万字 final answer settle 后单次 mount 数万~数十万 DOM 节点且常驻（性能审计 #401 同源）。
 * 两条路径现在共用同一份折叠策略。
 */
export const SettledLongAnswer = memo(function SettledLongAnswer(props: { text: string; onOpenExternal: (url: string, forceSystem?: boolean) => void; onOpenFile?: (path: string, line?: number) => void }) {
	const [expanded, setExpanded] = useState(false);
	if (expanded) {
		return (
			<div>
				<MarkdownStream text={props.text} isStreaming={false} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />
				<button type="button" className="mt-1 cursor-pointer rounded-md px-2 py-1 text-caption text-muted-foreground transition-colors duration-fast hover:bg-[var(--color-bg-hover)] hover:text-foreground" onClick={() => setExpanded(false)}>
					{t("session.longAnswer.collapse")}
				</button>
			</div>
		);
	}
	if (!shouldCollapseSettledText(props.text.length)) {
		return <MarkdownStream text={props.text} isStreaming={false} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />;
	}
	return (
		<div data-long-answer-collapsed="1">
			<MarkdownStream text={settledCollapsePreview(props.text)} isStreaming={false} onOpenExternal={props.onOpenExternal} onOpenFile={props.onOpenFile} />
			<button type="button" className="mt-1 cursor-pointer rounded-md px-2 py-1 text-caption text-muted-foreground transition-colors duration-fast hover:bg-[var(--color-bg-hover)] hover:text-foreground" onClick={() => setExpanded(true)}>
				{t("session.longAnswer.expand", { kb: Math.round(props.text.length / 1024) })}
			</button>
		</div>
	);
});
