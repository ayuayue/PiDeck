import type { SessionMessagePage } from "../../../shared/types";

/**
 * 磁盘页 → 消息缓存条目 page 快照。
 *
 * 除了「加载更多对话」要继续用的分页游标（nextBefore / nextBeforeEntryId），还必须留住
 * indexVersion：会话激活（disk → runtime 交接）时整个磁盘页会转成 history 前缀，渲染层用
 * indexVersion 与主进程 flush 的 fileVersion（同口径 mtime:size）比对，判断前缀是否仍属于
 * 同一代会话文件；两者不一致（压缩/外部改写）即整段丢弃，避免拼出异代内容。
 * 漏带这里会导致交接时无法证明同代 → 前缀被保守丢弃 → 用户眼前的历史在激活瞬间消失
 * （2026-10-21 用户诊断包：已停止进程会话发消息后历史消失，回复结束才恢复）。
 */
export function sessionDiskPageCursor(page: SessionMessagePage): {
	total: number;
	nextBefore: number | null;
	nextBeforeEntryId?: string;
	indexVersion?: string;
} {
	return {
		total: page.total,
		nextBefore: page.nextBefore,
		...(page.nextBeforeEntryId ? { nextBeforeEntryId: page.nextBeforeEntryId } : {}),
		...(page.indexVersion ? { indexVersion: page.indexVersion } : {}),
	};
}
