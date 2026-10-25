import { createHash } from "node:crypto";
import type { ChatMessage } from "../../shared/types";

export type StoppedMessageIdentity = {
	entryId?: string;
	role: "user" | "assistant";
	timestamp: number;
	fingerprint: string;
};

/** 留存的身份摘要 + 它对应的消息 id（Map 的 key，即 UI 手里的 live/投影 id）。 */
export type RetainedMessageIdentity = StoppedMessageIdentity & { id: string };

/** 内容只用于停止前后的身份核对；摘要避免缓存多份长文本和图片，也不做模糊匹配。 */
export function stoppedMessageFingerprint(message: ChatMessage): string {
	const hash = createHash("sha256");
	hash.update(JSON.stringify([message.role, message.text]));
	for (const image of message.images ?? []) {
		hash.update(JSON.stringify([image.mimeType, image.data]));
	}
	return hash.digest("hex");
}

/**
 * runtime 停止/重启会清空消息缓存，但编辑确认框、重发入口仍可能持有 live ID
 * （投影前的事件身份）。仅留下受限的身份摘要供 catalog 定位，不保留消息正文或已停止的 runtime。
 */
export class StoppedMessageIdentityCache {
	private readonly sessions = new Map<string, Map<string, StoppedMessageIdentity>>();
	private static readonly MAX_SESSIONS = 32;
	private static readonly MAX_MESSAGES = 256;

	/**
	 * 以规范化后的会话文件路径隔离身份；只保存 UI 可编辑的消息。
	 *
	 * 合并而非替换：同一会话文件会被前后多个 runtime 实例持有（stop → restart → stop，
	 * 崩溃后重启等）。UI 手中的 live ID 属于「上一个实例」，若被新实例的身份整体覆盖，
	 * catalog 改写（edit/delete/resend）就会退化成 Message not found（2026-09 用户反馈：
	 * 开启代理重启会话后重发报消息未找到）。同 ID 以最新捕获为准，容量按最旧插入淘汰。
	 */
	capture(sessionPath: string, messages: readonly ChatMessage[]): void {
		const identities = this.sessions.get(sessionPath) ?? new Map<string, StoppedMessageIdentity>();
		for (const message of messages.slice(-StoppedMessageIdentityCache.MAX_MESSAGES)) {
			if (message.role !== "user" && message.role !== "assistant") continue;
			// Map.set 对已存在的 key 只改值、不移动插入顺序：淘汰顺序始终按最早插入者。
			identities.set(message.id, {
				entryId: typeof message.meta?.entryId === "string" ? message.meta.entryId : undefined,
				role: message.role,
				timestamp: message.timestamp,
				fingerprint: stoppedMessageFingerprint(message),
			});
		}
		while (identities.size > StoppedMessageIdentityCache.MAX_MESSAGES) {
			const oldest = identities.keys().next().value;
			if (oldest === undefined) break;
			identities.delete(oldest);
		}
		// 重新插入把该会话挪到 LRU 尾部（Map 迭代顺序 = 插入顺序，头部即最久未访问）。
		this.sessions.delete(sessionPath);
		this.sessions.set(sessionPath, identities);
		while (this.sessions.size > StoppedMessageIdentityCache.MAX_SESSIONS) {
			const oldest = this.sessions.keys().next().value;
			if (oldest === undefined) break;
			this.sessions.delete(oldest);
		}
	}

	/** 同一会话中读取摘要；文件读者还须校验活动分支，不能据缓存直接改盘。 */
	get(sessionPath: string, messageId: string): StoppedMessageIdentity | undefined {
		return this.sessions.get(sessionPath)?.get(messageId);
	}

	/**
	 * 该会话已留存的全部身份（按捕获先后排序，先捕获在前）。
	 * 供 AgentManager 在 runtime 换绑后把新投影的 id 还原成 UI 手里的旧 id：
	 * 重启后若窗口带全新 id 下发，渲染层 React key 全变 → 入场/settle 动画重放。
	 */
	list(sessionPath: string): RetainedMessageIdentity[] {
		const identities = this.sessions.get(sessionPath);
		if (!identities) return [];
		return [...identities].map(([id, identity]) => ({ id, ...identity }));
	}

	/** 应用退出时与 runtime 缓存一起释放。 */
	clear(): void {
		this.sessions.clear();
	}
}
