import { memo, useState } from "react";
import { ChevronDown, ChevronRight, Puzzle } from "lucide-react";
import type { ChatMessage } from "../../../../shared/types";
import { t } from "../../i18n";
import { formatTime } from "./TimelineFormat";
import { TimelineMarker } from "./TimelineMarker";
import { SingleLinePreview } from "./SingleLinePreview";
import { formatExtensionEntryFields } from "./extensionEntry";
import { Collapsible, CollapsibleContent } from "../ui-shadcn/collapsible";

/**
 * ExtensionEntryCard — 扩展输出条目（pi appendEntry / type:"custom"）的时间线卡片。
 *
 * RPC 模式下 pi 的 registerEntryRenderer 不工作（issue #285），扩展写入的
 * appendEntry 在 pi TUI 里有专属渲染器、在 PiDeck 里原本完全不可见。主进程
 * 读侧把非内部记账类条目投影成本卡片；这里默认收成一行（对齐
 * NotifyMessageCard 的折叠语言），展开按字段浏览 data 载荷。
 * text 是主进程提取的折叠行预览（首个字符串字段），展开态以 meta.data 为准。
 */
export const ExtensionEntryCard = memo(function ExtensionEntryCard(props: { message: ChatMessage }) {
	const [expanded, setExpanded] = useState(false);
	const meta = props.message.meta ?? {};
	const customType = String(meta.customType ?? "");
	const fields = formatExtensionEntryFields(meta.data);
	const truncated = meta.dataTruncated === true;

	return (
		<TimelineMarker kind="diagnostic" tone="neutral">
			<article className="mb-4 w-full min-w-0 overflow-hidden rounded-md border border-border-subtle bg-[var(--color-chat-muted-bg)]" data-message-id={props.message.id} data-role={props.message.role} data-custom-type={customType || undefined}>
				{/* 整行可点：图标 + 标题 + customType + 折叠预览 + 时间 + chevron */}
				<button
					type="button"
					className="flex min-h-7 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-caption transition-colors duration-fast hover:bg-[color:color-mix(in_srgb,var(--color-bg-hover)_50%,transparent)] focus-visible:-outline-offset-2 focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]"
					onClick={() => setExpanded((value) => !value)}
					aria-expanded={expanded}
					title={expanded ? t("notify.collapse") : t("notify.expand")}
				>
					<Puzzle size={14} className="shrink-0 text-text-faint" aria-hidden="true" />
					<span className="shrink-0 font-semibold text-text-secondary">{t("notify.extensionEntryTitle")}</span>
					{customType ? <span className="shrink-0 max-w-[16rem] truncate text-text-tertiary">{customType}</span> : null}
					{!expanded && props.message.text ? <SingleLinePreview text={props.message.text} showSweep={false} className="min-w-0 flex-[1_1_auto] text-text-faint" /> : null}
					<time className="ml-auto shrink-0 text-micro tabular-nums text-text-tertiary">{formatTime(props.message.timestamp)}</time>
					{expanded ? <ChevronDown size={14} className="shrink-0 text-text-faint" aria-hidden="true" /> : <ChevronRight size={14} className="shrink-0 text-text-faint" aria-hidden="true" />}
				</button>
				{/* 折叠体走共享折叠原语：真高度渐变 + exit 后卸载；display:contents 根不生成盒子，折叠态零空档。 */}
				<Collapsible open={expanded} className="contents">
					<CollapsibleContent className="border-t border-border-subtle px-2 py-1.5">
						{fields.length === 0 && !truncated ? <p className="m-0 text-caption text-text-tertiary">{t("notify.extensionEntryEmpty")}</p> : null}
						{fields.map((field, index) => (
							<div key={`${field.key}-${index}`} className="flex flex-col gap-0.5 py-0.5">
								{field.key ? <span className="text-micro font-semibold uppercase tracking-wide text-text-tertiary">{field.key}</span> : null}
								<p className="m-0 whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-text-secondary">{field.value}</p>
							</div>
						))}
						{truncated ? <p className="m-0 pt-1 text-micro text-text-faint">{t("notify.extensionEntryTruncated")}</p> : null}
					</CollapsibleContent>
				</Collapsible>
			</article>
		</TimelineMarker>
	);
});
