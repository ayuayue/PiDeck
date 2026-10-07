import { ChevronDown, ChevronRight, Puzzle } from "lucide-react";
import { memo, useState } from "react";
import type { ChatMessage } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { SingleLinePreview } from "../SingleLinePreview";
import { formatTime } from "../TimelineFormat";
import { formatExtensionEntryFields } from "../extensionEntry";

/**
 * ExtensionEntryStep — 过程组内的扩展输出成员行。
 *
 * appendEntry 投影卡折进过程组后的行形态（用户决策 2026-10：不单独成块）：
 * 折叠行 = 图标 + 「扩展输出」+ customType + 预览 + 时间，展开按字段浏览 data。
 * 与 ThinkingStep/ToolStep 同为组员行：min-h-7、text-chat-row、shrink-0
 * （组体是限高 flex 列，子项漏 shrink-0 会被压扁——AGENTS.md 记录过的事故）。
 * 展开态与独立卡 ExtensionEntryCard 同构（formatExtensionEntryFields + 截断提示）。
 */
export const ExtensionEntryStep = memo(function ExtensionEntryStep(props: { messages: readonly ChatMessage[] }) {
	return (
		<>
			{props.messages.map((message) => (
				<ExtensionEntryRow key={message.id} message={message} />
			))}
		</>
	);
});

function ExtensionEntryRow(props: { message: ChatMessage }) {
	const [expanded, setExpanded] = useState(false);
	const meta = props.message.meta ?? {};
	const customType = String(meta.customType ?? "");
	const fields = formatExtensionEntryFields(meta.data);
	const truncated = meta.dataTruncated === true;

	return (
		<div className="flex min-w-0 shrink-0 flex-col" data-custom-type={customType || undefined}>
			<button
				type="button"
				className="flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-0.5 py-1 text-left text-chat-row text-text-tertiary transition-colors duration-fast hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] hover:text-text-secondary focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
				onClick={() => setExpanded((value) => !value)}
				aria-expanded={expanded}
				title={expanded ? t("notify.collapse") : t("notify.expand")}
			>
				<Puzzle size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
				<span className="shrink-0 font-medium">{t("notify.extensionEntryTitle")}</span>
				{customType ? <span className="max-w-[12rem] shrink-0 truncate text-text-faint">{customType}</span> : null}
				{!expanded && props.message.text ? <SingleLinePreview text={props.message.text} showSweep={false} className="min-w-0 flex-[1_1_auto] text-text-faint" /> : null}
				<time className="ml-auto shrink-0 text-chat-detail tabular-nums text-text-faint">{formatTime(props.message.timestamp)}</time>
				<span aria-hidden="true" className="inline-flex shrink-0 text-text-faint">
					{expanded ? <ChevronDown size={14} strokeWidth={2.4} aria-hidden="true" /> : <ChevronRight size={14} strokeWidth={2.4} aria-hidden="true" />}
				</span>
			</button>
			{expanded ? (
				<div className="ml-6 flex flex-col border-l border-border-subtle pl-2">
					{fields.length === 0 && !truncated ? <p className="m-0 py-1 text-chat-detail text-text-tertiary">{t("notify.extensionEntryEmpty")}</p> : null}
					{fields.map((field, index) => (
						<div key={`${field.key}-${index}`} className="flex shrink-0 flex-col gap-0.5 py-1">
							{field.key ? <span className="text-micro font-semibold uppercase tracking-wide text-text-tertiary">{field.key}</span> : null}
							<p className="m-0 whitespace-pre-wrap break-words font-mono text-chat-detail leading-relaxed text-text-secondary">{field.value}</p>
						</div>
					))}
					{truncated ? <p className="m-0 pb-1 text-micro text-text-faint">{t("notify.extensionEntryTruncated")}</p> : null}
				</div>
			) : null}
		</div>
	);
}
