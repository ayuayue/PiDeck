import type { ChatMessage, ImageContent } from "../../../shared/types";
import { getAppLogger } from "../../logging/sharedLogger";
import type { DshRemoteClient } from "../dshRemoteClient";

/** DSH 历史消息里由投影器登记的持久化图片引用（canonical ImageBlock.attachment）。 */
export type DshImageRef = {
	attachmentId: string;
	mediaType: string;
};

/** 从 ChatMessage.meta 安全读取待回填的 DSH 图片引用。 */
export function dshImageRefsFromMeta(meta: ChatMessage["meta"] | undefined): DshImageRef[] {
	if (!meta || !Array.isArray(meta.dshImageRefs)) return [];
	const refs: DshImageRef[] = [];
	for (const raw of meta.dshImageRefs) {
		if (!raw || typeof raw !== "object") continue;
		const candidate = raw as Record<string, unknown>;
		if (typeof candidate.attachmentId === "string" && candidate.attachmentId && typeof candidate.mediaType === "string" && candidate.mediaType) {
			refs.push({ attachmentId: candidate.attachmentId, mediaType: candidate.mediaType });
		}
	}
	return refs;
}

/**
 * 把 DSH 历史里的 durable image refs 回填成 ChatMessage.images。
 * host 的 sessions.attachment 会先证明该 attachmentId 属于本会话，再返回 base64 data；
 * 失败只记日志并保留 refs（后续页面/重试可再尝试）。
 * @param attempted 运行时复用集合，避免 mux 每帧对同一 ref 重复 RPC。
 */
export async function hydrateDshImageRefs(client: DshRemoteClient, sessionId: import("@deepseek-ai/dsh-session/types").SessionId, messages: ChatMessage[], attempted?: Set<string>): Promise<ChatMessage[]> {
	const pendingByMessage: Array<{ message: ChatMessage; refs: DshImageRef[] }> = [];
	for (const message of messages) {
		const refs = dshImageRefsFromMeta(message.meta);
		if (refs.length === 0) continue;
		const missing = refs.filter((ref) => !attempted?.has(ref.attachmentId));
		if (missing.length > 0) pendingByMessage.push({ message, refs: missing });
	}
	if (pendingByMessage.length === 0) return messages;
	const uniqueRefs = new Map<string, DshImageRef>();
	for (const item of pendingByMessage) {
		for (const ref of item.refs) uniqueRefs.set(ref.attachmentId, ref);
	}
	const resolved = new Map<string, ImageContent>();
	for (const [attachmentId, ref] of uniqueRefs) {
		try {
			const result = await client.sessionsAttachment({
				sessionId,
				attachmentId: ref.attachmentId as import("@deepseek-ai/dsh-attachment").AttachmentIdType,
			});
			if (result.result.ok) {
				attempted?.add(attachmentId);
				resolved.set(attachmentId, {
					type: "image",
					data: result.result.value.data,
					mimeType: result.result.value.attachment.mediaType,
				});
			} else {
				getAppLogger()?.warn("dsh-agent", "attachment resolve rejected", {
					sessionId: String(sessionId),
					attachmentId,
					error: result.result.error,
				});
			}
		} catch (error) {
			getAppLogger()?.warn("dsh-agent", "attachment resolve failed", {
				sessionId: String(sessionId),
				attachmentId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
	if (resolved.size === 0) return messages;
	let changed = false;
	const nextMessages = messages.map((message) => {
		const refs = dshImageRefsFromMeta(message.meta);
		if (refs.length === 0) return message;
		const images = refs.map((ref) => resolved.get(ref.attachmentId)).filter((image): image is ImageContent => Boolean(image));
		if (images.length === 0) return message;
		changed = true;
		return { ...message, images: [...(message.images ?? []), ...images] };
	});
	return changed ? nextMessages : messages;
}
