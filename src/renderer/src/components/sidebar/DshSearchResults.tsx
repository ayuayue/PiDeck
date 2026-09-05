import { useAtomValue } from "jotai";
import { Search } from "lucide-react";
import type { SessionRecord } from "../../../../shared/types";
import { sessionRecordsAtom } from "../../atoms";
import { useDshSessionSearch } from "../../hooks/useDshSessionSearch";
import { t } from "../../i18n";
import { TitleScrollText } from "./TitleScrollText";

/**
 * 侧栏 DSH 全文搜索结果（G9）：搜索词非空时展示匹配的 DSH 会话（标题 + 命中片段），
 * 点击打开会话。结果按 dshSessionId 映射回 catalog 记录；无匹配/无 DSH 会话时隐藏。
 */
export function DshSearchResults(props: {
  query: string;
  onOpen: (projectId: string, sessionId: string) => void;
}) {
  const results = useDshSessionSearch(props.query);
  const records = useAtomValue(sessionRecordsAtom);
  const matched = results
    .map((result) => {
      const record = Object.values(records).find(
        (candidate) => candidate.dshSessionId === result.sessionId,
      );
      return record ? { record, snippet: result.snippet } : undefined;
    })
    .filter((item): item is { record: SessionRecord; snippet: string } => Boolean(item));
  if (matched.length === 0) return null;

  return (
    <div className="dsh-search-results flex shrink-0 flex-col gap-1 rounded-lg border border-border-subtle bg-bg-panel/60 p-1.5">
      <div className="flex items-center gap-1.5 px-1 text-micro text-text-tertiary">
        <Search size={10} aria-hidden="true" />
        <span>{t("sidebar.dshSearchResults")}</span>
      </div>
      {matched.map(({ record, snippet }) => (
        <button
          key={record.id}
          type="button"
          className="flex w-full min-w-0 cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/50"
          onClick={() => props.onOpen(record.projectId, record.id)}
        >
          <TitleScrollText
            text={record.title}
            className="w-full flex-none text-control font-medium text-foreground"
          />
          <span className="truncate text-caption text-text-secondary">{snippet}</span>
        </button>
      ))}
    </div>
  );
}
