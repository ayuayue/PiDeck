import type { ChatMessage } from "../../shared/types";
import { stoppedMessageFingerprint, type RetainedMessageIdentity } from "./stoppedMessageIdentity";

/**
 * 消息内容指纹：跨「运行期事件身份（randomUUID）」与「文件投影身份
 * （agentId-history-entryId）」匹配同一 pi 消息的唯一可靠手段——
 * 两条通道的 ChatMessage.id 永不相同（事件消息无 pi id 可用），
 * 但同一条 pi 消息的正文内容一致。
 *
 * 指纹组成（按角色区分）：
 * - tool：meta.toolCallId（两通道同源，pi 的 toolCallId；text 不可靠——
 *   运行期带 ▶/✓ 前缀、投影带 ✓/✗ 前缀，且随执行状态变化）；
 * - user/assistant/system/error：role + text + thinking + 图片签名
 *   （图片签名 = mimeType + data 长度 + 首尾采样，避免大 base64 全量参与比较）。
 */
function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function imageSignature(message: ChatMessage): string {
	const images = message.images ?? [];
	if (images.length === 0) return "";
	return images
		.map((image) => {
			const data = image.data ?? "";
			const head = data.slice(0, 64);
			const tail = data.length > 128 ? data.slice(-64) : "";
			return `${image.mimeType}:${data.length}:${head}${tail}`;
		})
		.join(",");
}

export function messageFingerprint(message: ChatMessage): string {
	const role = message.role;
	const toolCallId =
		message.role === "tool"
			? (message.meta as Record<string, unknown> | undefined)?.toolCallId
			: undefined;
	if (typeof toolCallId === "string" && toolCallId) {
		return `tool\u0000${toolCallId}`;
	}
	return [
		role,
		stripAnsi(message.text),
		stripAnsi(message.thinking ?? ""),
		imageSignature(message),
	].join("\u0000");
}

/**
 * 指纹匹配只允许在投影「尾部窗口」内进行：加载期间新发的消息若已落盘，
 * 其文件副本必然位于投影末尾（最近写入）；头部/中部的同文本旧消息不可能是
 * 「双份」。否则高频同文本消息（「继续」「好」）会被误判为历史双份而丢弃
 * （2026-12 回归修复：preserved 消息真实丢失）。
 */
const FINGERPRINT_MATCH_TAIL = 32;

/**
 * 时间容差：同一条 pi 消息的投影副本（落盘记录）与运行期事件副本携带的
 * timestamp 同源（都是 pi 消息时间戳），应几乎相等；超过该值视为不同消息。
 */
const FINGERPRINT_MATCH_TIME_TOLERANCE_MS = 5_000;

/**
 * 后台加载历史消息完成后，把加载期间新增的实时消息接回历史尾部。
 * 大会话 get_messages 可能很慢；用户在等待期间发送的消息不能被历史结果覆盖。
 *
 * 去重语义（修复双份回归）：投影结果（get_messages 快照）与运行期缓存
 * （事件流/乐观写入）可能包含「同一条 pi 消息的两个副本」——快照晚于消息
 * 落盘时投影含完整版（带 entryId），运行期缓存里还有事件版（randomUUID）。
 * 旧实现只按 ChatMessage.id 去重（两通道 id 永不相同）→ 双份进入渲染层，
 * 被用户消息切分到上下两个 run（「中间回复在上一轮/下一轮都显现」）。
 *
 * 现在按「内容指纹」一一消耗匹配：preserved（加载期间新增）消息与投影消息
 * 指纹相同 → 视为同一条，丢弃运行期副本（以投影为准：位置正确、带 entryId）；
 * 指纹不匹配 → 真正未落盘的进行中消息，保留在尾部等待事件流继续 upsert。
 */
export function mergeHistoryWithPreservedMessages(
	historyMessages: ChatMessage[],
	currentMessages: ChatMessage[],
	preserveMessagesAfter?: number,
): ChatMessage[] {
	if (!preserveMessagesAfter) return historyMessages;
	// 投影侧指纹预索引（fingerprint → 未消耗下标队列）：大会话投影几千条时避免
	// 对每条 preserved 做全表扫描（O(p×n) → O(p + n)），后台加载完成不卡主线程。
	const fingerprintToHistoryIndices = new Map<string, number[]>();
	historyMessages.forEach((historyMessage, index) => {
		const fingerprint = messageFingerprint(historyMessage);
		const indices = fingerprintToHistoryIndices.get(fingerprint);
		if (indices) indices.push(index);
		else fingerprintToHistoryIndices.set(fingerprint, [index]);
	});
	const consumedHistory = new Set<number>();
	const preservedMessages = currentMessages.filter((message) => {
		if (
			message.timestamp < preserveMessagesAfter ||
			message.meta?.historyLoading === true
		) {
			return false;
		}
		const fingerprint = messageFingerprint(message);
		const candidates = fingerprintToHistoryIndices.get(fingerprint);
		if (!candidates) return true;
		// 只允许匹配投影尾部窗口内的副本（见 FINGERPRINT_MATCH_TAIL 注释）；
		// 且时间须在容差内（同一条消息两通道 timestamp 同源）。两者都满足
		// 才消耗：既避免双份，又不误删加载期间真实新增的同文本消息。
		const tailStart = Math.max(0, historyMessages.length - FINGERPRINT_MATCH_TAIL);
		const timeTolerantCandidates = candidates.filter(
			(index) =>
				index >= tailStart &&
				Math.abs((historyMessages[index].timestamp ?? 0) - (message.timestamp ?? 0)) <=
					FINGERPRINT_MATCH_TIME_TOLERANCE_MS,
		);
		// 从最新往旧一一消耗（投影尾部即最近写入，先消耗最近的），避免错配删多。
		for (let i = timeTolerantCandidates.length - 1; i >= 0; i--) {
			const historyIndex = timeTolerantCandidates[i];
			if (!consumedHistory.has(historyIndex)) {
				consumedHistory.add(historyIndex);
				return false;
			}
		}
		return true;
	});
	return preservedMessages.length > 0
		? [...historyMessages, ...preservedMessages]
		: historyMessages;
}

/**
 * 身份摘要表 → 投影消息 id 还原（runtime 换绑场景）。
 *
 * 与 stabilizeReloadedMessageIds 的分工：那个函数用「同一 agent 上一次的本地消息列表」
 * 做指纹对齐；本函数用会话级身份摘要（stop/restart 时留存，见 StoppedMessageIdentityCache）
 * 对齐，覆盖「新 agent 首次投影、旧 id 只存在于身份摘要里」的场景（重启/崩溃后重连）。
 * 重启后若把带全新 id 的窗口下发，渲染层 React key 全变 → 已渲染消息全部 remount →
 * 入场/settle 动画重放（与压缩重载同一问题，2026-09 重启后窗口重下发的配套修复）。
 *
 * 匹配优先级：
 * 1. entryId（文件条目身份，最可靠：正文随流式/压缩变化时也必须沿用同一 key）；
 * 2. 内容指纹 + 时间容差（live 消息没有 entryId，只能按正文核对，与摘要同口径）。
 * 同一身份只消耗一次，时间超容差视为不同消息——宁可换 key（个别消息重挂载）也不能张冠李戴。
 */
export function stabilizeProjectedIdsFromIdentities(
	identities: readonly RetainedMessageIdentity[],
	projectedMessages: ChatMessage[],
): ChatMessage[] {
	if (identities.length === 0 || projectedMessages.length === 0) return projectedMessages;
	// entryId → 身份：后捕获的覆盖先捕获的（同一文件条目多次重启后可能留下多条身份，
	// 最新一次捕获才是 UI 当前展示的 id）。
	const byEntryId = new Map<string, RetainedMessageIdentity>();
	// 指纹 → 身份队列：保持捕获先后顺序，同文本高频消息（连发「继续」）一一消耗不串位。
	const byFingerprint = new Map<string, RetainedMessageIdentity[]>();
	for (const identity of identities) {
		if (identity.entryId) byEntryId.set(identity.entryId, identity);
		const list = byFingerprint.get(identity.fingerprint);
		if (list) list.push(identity);
		else byFingerprint.set(identity.fingerprint, [identity]);
	}
	const consumed = new Set<string>();
	return projectedMessages.map((message) => {
		const entryId = message.meta?.entryId;
		if (typeof entryId === "string" && entryId) {
			const preferred = byEntryId.get(entryId);
			// entryId 匹配不再做指纹二次校验：entryId 就是文件条目的稳定身份，
			// 正文改写/流式补全后指纹变了但同一逻辑消息仍应沿用同一 key。
			if (preferred && !consumed.has(preferred.id)) {
				consumed.add(preferred.id);
				return { ...message, id: preferred.id };
			}
		}
		const candidates = byFingerprint.get(stoppedMessageFingerprint(message));
		if (!candidates) return message;
		for (const candidate of candidates) {
			if (consumed.has(candidate.id)) continue;
			if (Math.abs(candidate.timestamp - (message.timestamp ?? 0)) > FINGERPRINT_MATCH_TIME_TOLERANCE_MS) continue;
			consumed.add(candidate.id);
			return { ...message, id: candidate.id };
		}
		return message;
	});
}

/**
 * 重载后投影消息身份稳定化。事件通道（randomUUID id）与文件投影通道
 * （agentId-history-entryId id）对同一条 pi 消息的 id 永不相同；压缩/attach
 * 重连等场景 loadMessages 会用投影整体替换运行期缓存，若直接替换，渲染层
 * React key 全部变化 → 已渲染消息全部 remount → 回答入场/settle 动画重放
 * （视觉上「回复又被加载了一遍」）。
 *
 * 本函数按内容指纹把投影消息的 id 重写为旧缓存中同一条消息的 id（时间容差内、
 * 一一消耗，规则与 mergeHistoryWithPreservedMessages 一致），保留投影的
 * entryId 等 meta；无旧匹配的新消息（如压缩摘要卡）保持投影 id。
 *
 * 幂等：旧缓存已是投影版时，指纹匹配到的是同 id，重写无副作用。
 */
export function stabilizeReloadedMessageIds(
	previousMessages: ChatMessage[],
	projectedMessages: ChatMessage[],
): ChatMessage[] {
	if (previousMessages.length === 0 || projectedMessages.length === 0) {
		return projectedMessages;
	}
	// 指纹 → 旧缓存下标队列（同文本高频消息如连发「继续」会共享一个指纹）
	const fingerprintToPrevIndices = new Map<string, number[]>();
	previousMessages.forEach((message, index) => {
		const fingerprint = messageFingerprint(message);
		const indices = fingerprintToPrevIndices.get(fingerprint);
		if (indices) indices.push(index);
		else fingerprintToPrevIndices.set(fingerprint, [index]);
	});
	const consumed = new Set<number>();
	return projectedMessages.map((message) => {
		const fingerprint = messageFingerprint(message);
		const candidates = fingerprintToPrevIndices.get(fingerprint);
		if (!candidates) return message;
		// 从最旧往最新一一消耗，保持投影与旧缓存的顺序对应（同文本消息
		// 如连发「继续」按出现顺序各匹配各的，避免交错串位）
		for (let i = 0; i < candidates.length; i++) {
			const prevIndex = candidates[i];
			if (consumed.has(prevIndex)) continue;
			const prev = previousMessages[prevIndex];
			if (
				Math.abs((prev.timestamp ?? 0) - (message.timestamp ?? 0)) >
				FINGERPRINT_MATCH_TIME_TOLERANCE_MS
			) {
				continue;
			}
			consumed.add(prevIndex);
			return { ...message, id: prev.id };
		}
		return message;
	});
}
