import { useSetAtom } from "jotai";
import { FileSearch } from "lucide-react";
import type { SessionRecord, SessionSearchResult } from "../../../../shared/types";
import { pendingMessageJumpAtom } from "../../atoms";
import { t } from "../../i18n";
import type { SessionContentSearchHitView } from "../../utils/sessionContentSearchHits";
import { TitleScrollText } from "./TitleScrollText";

/**
 * 侧栏跨会话正文搜索结果：搜索词非空时展示正文命中的会话（标题 + 命中数 + 首条片段）。
 *
 * 结果（`result`）与映射好的命中（`hits`）都由调用方传入：命令面板要用同一份命中
 * 把「正文命中」变成可跳转的会话项（#610），两层各自调一次 sidecar 搜索就是双倍 IPC，
 * hook 只能有一处调用（SidebarContent）。
 *
 * 点击打开会话并挂 pendingMessageJump 定位到首个命中消息。
 * 命中条数用 hitCount（未截断的真实值），首条片段是 Go 侧评分最高的那条。
 * 无 sidecar/降级/无结果时隐藏，不影响既有标题过滤。
 */
export function SessionContentSearchResults(props: { result: SessionSearchResult | null; hits: SessionContentSearchHitView[]; onOpen: (projectId: string, sessionId: string) => void }) {
	const setPendingMessageJump = useSetAtom(pendingMessageJumpAtom);
	const matched = props.hits;
	if (matched.length === 0) return null;

	const openHit = (record: SessionRecord, messageId: string) => {
		setPendingMessageJump({ sessionId: record.id, messageId });
		props.onOpen(record.projectId, record.id);
	};

	return (
		<div className="session-content-search-results flex shrink-0 flex-col gap-1 rounded-lg border border-border-subtle bg-bg-panel/60 p-1.5">
			<div className="flex items-center gap-1.5 px-1 text-micro text-text-tertiary">
				<FileSearch size={10} aria-hidden="true" />
				<span>{t("sidebar.sessionContentResults", { count: props.result?.totalHitSessions ?? matched.length })}</span>
				{props.result?.truncated ? <span className="truncate">{t("sidebar.sessionContentTruncated")}</span> : null}
			</div>
			{matched.map(({ record, matchCount, firstMessageId, snippet }) => (
				<button key={record.id} type="button" className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50" onClick={() => openHit(record, firstMessageId)}>
					<TitleScrollText text={record.title} className="w-full flex-none text-control font-medium text-foreground" />
					<span className="flex min-w-0 items-center gap-1.5 text-caption text-text-tertiary">
						<span className="shrink-0">{t("sidebar.sessionContentMatchCount", { count: matchCount })}</span>
						<span className="truncate text-text-secondary">{snippet}</span>
					</span>
				</button>
			))}
		</div>
	);
}
