import type { SessionRecord } from "../../../shared/types";

/**
 * 会话内查找（Ctrl/Cmd+Shift+F）可用的唯一判据：入口按钮（SessionHeader）与浮层
 * （ChatSessionPane）必须共用它，否则会出现「点了按钮没反应」或「浮层挂在没有检索
 * 源的会话上永远没有匹配」。
 *
 * 检索源按后端区分（主进程 sessions:search-in-session 按 SessionRecord.id 分派）：
 * - pi：Go session-index sidecar 只索引 pi 会话 JSONL——草稿尚未落盘（filePath 缺省）
 *   也不挂入口（否则放大镜悬在欢迎页上）；
 * - DSH：没有 pi JSONL，检索走 host 历史投影——草稿还没建 host 会话（dshSessionId
 *   缺省）同样没有内容可查；
 * - ACP/生图等其他后端没有可检索的历史源，不挂入口。
 */
export function supportsSessionFind(record: Pick<SessionRecord, "backend" | "filePath" | "dshSessionId"> | undefined): boolean {
	if (!record) return false;
	if (!record.backend || record.backend === "pi") return Boolean(record.filePath);
	if (record.backend === "dsh") return Boolean(record.dshSessionId);
	return false;
}
