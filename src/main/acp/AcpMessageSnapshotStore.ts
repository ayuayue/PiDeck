/**
 * ACP 消息内存快照存储：acpSessionId → 最近一次 flush 的消息列表。
 *
 * 用途：stop/升级强杀后 runtime 删除，重入会话时（readMessagesByAcpSessionId）
 * 的临时数据源，避免时间线空白；激活后 session/load 重放会覆盖为完整历史。
 *
 * 防内存失控的双层护栏（此前无淘汰，会话数无上限）：
 * - 每会话条数上限 MESSAGE_SNAPSHOT_LIMIT：不能小于一个正常长回合的消息量——
 *   一个带工具调用的回合 assistant/tool 条目就能上双位数，取 16 会把关闭重开后的
 *   历史截到只剩最后一小段（ACP CLI 不支持 loadSession 重放时无第二数据源，
 *   2026-10-14 实测丢史放人）。
 * - 会话数上限 MAX_TRACKED_SESSIONS：Map 迭代序=插入序，set 时 delete+set 刷新
 *   LRU 位置，超限逐出最旧条目；32 个会话 × 400 条 ≈ 单会话峰值内存的量级上限。
 */
import type { ChatMessage } from "../../shared/types/session";

/** 每会话保留的快照条数（见文件头注释：上限只需防内存失控，不能截断正常长回合）。 */
const MESSAGE_SNAPSHOT_LIMIT = 400;
/** 追踪的会话数上限，超出逐出最旧（LRU）。 */
const MAX_TRACKED_SESSIONS = 32;

export class AcpMessageSnapshotStore {
	private readonly sessions = new Map<string, ChatMessage[]>();

	set(acpSessionId: string, messages: ChatMessage[]): void {
		// delete+set：同会话重写时刷新 LRU 位置，保证逐出的是“最久未更新”的会话。
		this.sessions.delete(acpSessionId);
		this.sessions.set(acpSessionId, messages.slice(-MESSAGE_SNAPSHOT_LIMIT));
		while (this.sessions.size > MAX_TRACKED_SESSIONS) {
			const oldest = this.sessions.keys().next().value;
			if (oldest === undefined) break;
			this.sessions.delete(oldest);
		}
	}

	get(acpSessionId: string): ChatMessage[] | undefined {
		return this.sessions.get(acpSessionId);
	}
}
