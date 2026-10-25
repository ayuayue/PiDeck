import { useAtomValue, useSetAtom } from "jotai";
import { FileSearch } from "lucide-react";
import { useMemo } from "react";
import type { SessionRecord } from "../../../../shared/types";
import { pendingMessageJumpAtom, sessionRecordsAtom } from "../../atoms";
import { useSessionContentSearch } from "../../hooks/useSessionContentSearch";
import { t } from "../../i18n";
import { buildSessionContentSearchHits } from "../../utils/sessionContentSearchHits";
import { TitleScrollText } from "./TitleScrollText";

/**
 * 侧栏跨会话正文搜索结果：搜索词非空时展示正文命中的会话（标题 + 命中数 + 首条片段）。
 * 命中按「会话文件路径」映射回 catalog 记录（策略见 utils/sessionContentSearchHits：
 * SessionRecord.id 是跨重启稳定的身份、不等于 filePath，不能拿 records[filePath] 取）。
 * 点击打开会话并挂 pendingMessageJump 定位到首个命中消息。
 * 命中条数用 hitCount（未截断的真实值），首条片段是 Go 侧评分最高的那条。
 * 无 sidecar/降级/无结果时隐藏，不影响既有标题过滤。
 */
export function SessionContentSearchResults(props: { query: string; onOpen: (projectId: string, sessionId: string) => void }) {
	const results = useSessionContentSearch(props.query);
	const records = useAtomValue(sessionRecordsAtom);
	const setPendingMessageJump = useSetAtom(pendingMessageJumpAtom);
	const matched = useMemo(() => buildSessionContentSearchHits(results, records), [results, records]);
	if (matched.length === 0) return null;

	const openHit = (record: SessionRecord, messageId: string) => {
		setPendingMessageJump({ sessionId: record.id, messageId });
		props.onOpen(record.projectId, record.id);
	};

	return (
		<div className="session-content-search-results flex shrink-0 flex-col gap-1 rounded-lg border border-border-subtle bg-bg-panel/60 p-1.5">
			<div className="flex items-center gap-1.5 px-1 text-micro text-text-tertiary">
				<FileSearch size={10} aria-hidden="true" />
				<span>{t("sidebar.sessionContentResults", { count: results?.totalHitSessions ?? matched.length })}</span>
				{results?.truncated ? <span className="truncate">{t("sidebar.sessionContentTruncated")}</span> : null}
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
