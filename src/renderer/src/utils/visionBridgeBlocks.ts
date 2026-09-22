/**
 * 视觉桥转换块的识别与提取（纯函数，可单测）。
 *
 * pi-deck-vision 扩展在 input 事件阶段把用户消息里的图片转成文字描述，
 * 转换结果会持久化进会话文件，消息文本里因此留下三类标记块：
 *   成功：[图片 #N（视觉桥已查看，以下为图片实际内容）]\n<描述文本>
 *   失败：[图片 #N 视觉桥转换失败：<原因>。请检查视觉桥设置（模型/接口地址/API Key）后重试，此图片内容不可见]
 *   未发送：[图片 #N 未发送给模型：<原因>]（视觉桥没开/没选模型，属配置事实，不是故障）
 *
 * 渲染层用本函数把它们从正文里剥出，渲染成可视化卡片：
 * 用户一眼看到「走了视觉桥」（成功徽章 / 失败红卡 + 原因），
 * 而不是一段混在气泡里的方括号纯文本。多个图片块按出现顺序排列，
 * 描述文本归属前一个成功标记（直到下一个标记或文本结束）。
 */

import type { VisionBridgeEvent } from "../../../shared/types/vision";

export type VisionBridgeBlock =
	| { kind: "success"; index: number; description: string }
	| { kind: "failed"; index: number; reason: string }
	/** 图片未进入转换流程（桥没开/没选模型）：中性提示卡，不是错误 */
	| { kind: "skipped"; index: number; reason: string };

/** 成功标记：兼容「（视觉桥已查看）」与「（视觉桥已查看，以下为图片实际内容）」两种后缀。 */
const SUCCESS_MARK_RE = /\[图片 #(\d+)（视觉桥已查看[^）]*）\]/g;
/** 失败标记：整块自包含（原因 + 修复指引 + 收尾句），reason 取「。请检查视觉桥设置」之前的部分。 */
const FAILED_MARK_RE = /\[图片 #(\d+)\s+视觉桥转换失败：([\s\S]*?)。请检查视觉桥设置[\s\S]*?此图片内容不可见\]/g;
/** 未发送标记：`[图片 #N 未发送给模型：<原因>]`，原因里不应出现 `]`。 */
const SKIPPED_MARK_RE = /\[图片 #(\d+)\s+未发送给模型：([\s\S]*?)\]/g;
/**
 * 历史遗留标记：旧版把「视觉桥没开/没选模型」也写成失败标记，原因固定以「视觉桥未配置」开头。
 * 那种情形图片压根没进转换流程，重开旧会话时不该再看到红卡——按未发送归一化。
 * 注意只匹配这个固定前缀：接口地址解析失败、超时、HTTP 4xx 等真实故障必须仍是红卡。
 */
const LEGACY_NOT_CONFIGURED_RE = /^视觉桥未配置/;

export function extractVisionBridgeBlocks(text: string): {
	blocks: VisionBridgeBlock[];
	/** 剥除全部视觉桥块后的剩余正文（保留其他内容原样） */
	text: string;
} {
	type Mark = {
		start: number;
		end: number;
		block: VisionBridgeBlock;
	};
	const marks: Mark[] = [];
	for (const m of text.matchAll(FAILED_MARK_RE)) {
		const reason = m[2].trim();
		const index = Number(m[1]);
		marks.push({
			start: m.index,
			end: m.index + m[0].length,
			block: LEGACY_NOT_CONFIGURED_RE.test(reason) ? { kind: "skipped", index, reason } : { kind: "failed", index, reason },
		});
	}
	for (const m of text.matchAll(SKIPPED_MARK_RE)) {
		marks.push({
			start: m.index,
			end: m.index + m[0].length,
			block: { kind: "skipped", index: Number(m[1]), reason: m[2].trim() },
		});
	}
	for (const m of text.matchAll(SUCCESS_MARK_RE)) {
		// 描述文本在第二轮按「下一个标记」边界补齐
		marks.push({
			start: m.index,
			end: m.index + m[0].length,
			block: { kind: "success", index: Number(m[1]), description: "" },
		});
	}
	marks.sort((a, b) => a.start - b.start);
	if (marks.length === 0) return { blocks: [], text };

	// 成功块的完整区间延伸到下一个标记（或文本末尾），中间即描述。
	// 边界说明：描述里若出现「[图片 #N」字样会被误当新块——视觉模型
	// 生成的描述几乎不含这种标记，且属于展示层容错，可接受。
	for (let i = 0; i < marks.length; i++) {
		if (marks[i].block.kind !== "success") continue;
		const nextStart = i + 1 < marks.length ? marks[i + 1].start : text.length;
		const block = marks[i].block as Extract<VisionBridgeBlock, { kind: "success" }>;
		block.description = text.slice(marks[i].end, nextStart).replace(/^\n+/, "").trim();
		marks[i].end = nextStart;
	}

	// 从后往前剥除块区间，避免前面删除后索引漂移
	let cleaned = text;
	for (let i = marks.length - 1; i >= 0; i--) {
		cleaned = cleaned.slice(0, marks[i].start) + cleaned.slice(marks[i].end);
	}
	return {
		blocks: marks.map((m) => m.block),
		text: cleaned.replace(/\n{3,}/g, "\n\n").trim(),
	};
}

/**
 * 把视觉桥事件文件里的 input 批次匹配到「实时发送中的用户消息」。
 * 匹配规则：kind=input、ts 不早于消息发送时间、items 的 imageHash 全部命中本消息图片集合。
 * 返回匹配批次（新到旧取最近一条）；无匹配返回 null。
 * 背景：pi 只把转换结果写进会话文件、不推送给实时消息流，渲染层的实时用户消息
 * 只有原文 + 图片附件；靠图片哈希把事件匹配回来，才能在实时气泡上渲染视觉桥卡片。
 */
export function matchVisionBridgeEvent(events: VisionBridgeEvent[] | undefined, imageHashes: string[], sentAt: number): VisionBridgeEvent | null {
	if (!events || events.length === 0 || imageHashes.length === 0) return null;
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
