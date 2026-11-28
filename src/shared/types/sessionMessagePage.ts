import type { ChatMessage } from "./session";

/**
 * 历史不可读的结构化原因（渲染层据此出专态 UI，而不是让 IPC 抛裸错误）。
 * - dsh-host-stopped：DSH host 被用户手动停止，host 不会自动拉起，「启动 host」是唯一恢复路径。
 * - file-missing：pi 会话文件还不存在——新建会话（含微信/飞书桥建的会话）在收到第一条
 *   消息前不落盘，此前打开会读到 ENOENT；这是「还没内容」而不是读取故障。
 */
export type SessionHistoryUnavailableReason = "dsh-host-stopped" | "dsh-runtime-missing" | "file-missing";

/** A bounded historical timeline slice. `nextBefore` is the exclusive index for an older page. */
export type SessionMessagePage = {
	messages: ChatMessage[];
	total: number;
	nextBefore: number | null;
	/**
	 * 本页不是「读到了空历史」而是「历史暂时读不了」：messages 为空且原因为 unavailable。
	 * 渲染层必须据此进错误专态，不能按空会话渲染起始页——DSH 会话没有 pi 会话文件，
	 * 把 host 未运行显示成「文件已删除/路径失效」会把用户引向错误方向。
	 */
	unavailable?: SessionHistoryUnavailableReason;
	/** 当前活动分支最后使用的模型；由历史索引读取时顺手提取。 */
	model?: { provider: string; modelId: string };
	/** 当前活动分支最后记录的思考档位；无显式记录但有模型时回退为 off。 */
	thinkingLevel?: string;
	/**
	 * 下一页锚点（entryId，2026-11 缓存优先）：页最旧条目的 entryId。
	 * 主进程缓存命中路径用它做续页游标（跨下标空间稳定）；文件路径同义于 nextBefore 指向的条目。
	 * 到顶（nextBefore === null）时缺省。
	 */
	nextBeforeEntryId?: string;
	/** Next newer page starts after this entry id; present only while newer history exists. */
	nextAfterEntryId?: string;
	/** 会话文件版本标识：本机为 `mtime:size`，远端为 `remote:<inode>:<mtime>:<size>`，用于跨页拒绝异代历史。 */
	indexVersion?: string;
};
