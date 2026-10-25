/**
 * 视觉桥块提取的渲染层入口。
 *
 * 块识别/剥离的纯逻辑已上移到 shared/expandedRefBlocks（主进程的会话标题派生同样要用，
 * 且 shared 不能反向依赖渲染层）；本文件只保留渲染层专属的「实时消息 ↔ 事件批次」匹配。
 */

import type { VisionBridgeEvent } from "../../../shared/types/vision";

export { extractVisionBridgeBlocks, type VisionBridgeBlock } from "../../../shared/expandedRefBlocks";

/**
 * 把视觉桥事件文件里的 input 批次匹配到「实时发送中的用户消息」。
 * 匹配规则：kind=input、ts 不早于消息发送时间、items 的 imageHash 全部命中本消息图片集合。
 * 返回匹配批次（新到旧取最近一条）；无匹配返回 null。
 * 背景：pi 只把转换结果写进会话文件、不推送给实时消息流，渲染层的实时用户消息
 * 只有原文 + 图片附件；靠图片哈希把事件匹配回来，才能在实时气泡上渲染视觉桥卡片。
 */
export function matchVisionBridgeEvent(events: VisionBridgeEvent[] | undefined, imageHashes: string[], sentAt: number): VisionBridgeEvent | null {
	if (!events || events.length === 0) return null;
	if (imageHashes.length === 0) return null;
	const hashSet = new Set(imageHashes);
	const candidates = events.filter((event) => event.kind === "input" && event.ts >= sentAt);
	for (let i = candidates.length - 1; i >= 0; i--) {
		const itemHashes = candidates[i].items.map((item) => item.imageHash).filter((hash): hash is string => typeof hash === "string" && hash.length > 0);
		if (itemHashes.length === 0) continue;
		// 批次必须完全由本消息的图片构成（至少一张），避免把别的会话/别的消息的批次误配
		if (itemHashes.every((hash) => hashSet.has(hash))) return candidates[i];
	}
	return null;
}
