import { isJumpInjectedAnchorMeta, readJumpEntryId as readEntryId, resolveJumpMessageIndex, stripProjectionPrefix } from "../../../../../shared/sessionJumpAnchor";
/**
 * 时间线跳转的目标归一（纯函数 + 极小的 DOM 兜底）。
 *
 * 会话内查找（`search-session`）的命中 id 是**会话文件条目 id**：Go 索引读的是
 * JSONL 行的顶层 `id`，在渲染层消息上落在 `meta.entryId`。而时间线节点/消息的
 * `id` 是投影 id（`${agentId}-history-${entryId}`，见 AgentMessageProjector）。
 * 两者不相等，直接拿命中 id 当消息 id 去查 `[data-message-id]` 永远查不到 →
 * 点击命中「什么都没发生」（2027-02 用户反馈）。这里统一归一：先按消息 id 精确
 * 匹配（刻度/大纲等调用方传的就是投影 id），再按条目 id 匹配（会话内查找命中）。
 */
/**
 * 从消息 meta 里读条目 id。`ChatMessage.meta` 是 `Record<string, unknown> & I18nDescriptor`，
 * 这里按 `unknown` 收窄（不做 `as` 强转）：非对象 / 没有 entryId / 非字符串一律当没有。
 */
export { resolveJumpMessageIndex } from "../../../../../shared/sessionJumpAnchor";

/**
 * 从取回的那一页里挑一个**一定能命中**的锚点 id。
 *
 * 为什么要挑：positioned 的目标是空 content / system / 被 context_edit 移出的条目，
 * 投影器根本不为它产生消息。拿它当锚点，渲染层一条都匹配不上，窗口退回有界尾部 ——
 * 用户看到「跳转失败后画面自己滚到底部」。
 *
 * 为什么要筛 -history-：页里混着 `_viewer-custom-*`（compaction 卡片、通知）与
 * `_viewer-meta-*`，它们不在 agent-run 里，锚到它们同样匹配不上。只有 `-history-`
 * 是角色消息，才是轮窗口认的子项。
 *
 * 返回 undefined = 这一页一条 history 消息都没有（整页卡片）。调用方不得硬跳，
 * 交由状态机报可诊断的失败。
 */
export function pickJumpAnchorEntryId(messages: ReadonlyArray<{ id: string; meta?: unknown }>, targetEntryId: string): string | undefined {
	if (!targetEntryId) return undefined;
	targetEntryId = stripProjectionPrefix(targetEntryId);
	// 目标只以**主进程补读的单条**形式存在：页窗口里没有它（被 active branch 排除的
	// error / aborted 条目），那条消息不属于任何 agent-run。拿它当锚点，
	// findAgentRunIndexByItemId 返回 -1、窗口退回有界尾部 —— 用户点中间条目、
	// 画面却滚到会话底部（2026-11-25 实测：12754 条会话里 19 个条目有 1 条
	// stopReason=error、页内 0 次、单读成功）。
	// 注入条在页首，原页首在时间上紧随其后：锚它，落位就在目标旁边。
	if (messages.some((message) => readEntryId(message.meta) === targetEntryId && isJumpInjectedAnchorMeta(message.meta))) {
		for (const message of messages) {
			if (isJumpInjectedAnchorMeta(message.meta)) continue;
			if (typeof message.id !== "string" || !message.id.includes("-history-")) continue;
			const entryId = readEntryId(message.meta);
			if (entryId) return entryId;
		}
		return undefined;
	}
	for (const message of messages) {
		if (isJumpInjectedAnchorMeta(message.meta)) continue;
		if (readEntryId(message.meta) === targetEntryId) return targetEntryId;
	}
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || typeof message.id !== "string" || !message.id.includes("-history-")) continue;
		if (isJumpInjectedAnchorMeta(message.meta)) continue;
		const entryId = readEntryId(message.meta);
		if (entryId) return entryId;
	}
	return undefined;
}

/**
 * 落位元素可能被折叠隐藏：轮内中间回答（阶段正文）随「执行过程」折叠区一起
 * `display:none`，几何矩形全为 0；对它 `scrollTop = 0` 等于跳到时间线顶部。
 * 命中不可见时退到所属轮次行（`.turn-row` / `.user-turn`），用户至少落在这一轮，
 * 折叠区就在眼前。
 */
export function resolveJumpScrollTarget(element: HTMLElement): HTMLElement {
	if (element.getClientRects().length > 0) return element;
	// closest 的默认泛型返回 Element：这里限定到 HTMLElement（轮次行/用户气泡都是 HTMLElement）
	return element.closest<HTMLElement>(".turn-row, .user-turn") ?? element;
}
