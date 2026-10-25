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
function readEntryId(meta: unknown): string | undefined {
	if (meta === null || typeof meta !== "object" || !("entryId" in meta)) return undefined;
	const entryId = meta.entryId;
	return typeof entryId === "string" && entryId.length > 0 ? entryId : undefined;
}

export function resolveJumpMessageIndex(messages: ReadonlyArray<{ id: string; meta?: unknown }>, targetId: string): number {
	if (!targetId) return -1;
	const direct = messages.findIndex((message) => message.id === targetId);
	if (direct >= 0) return direct;
	return messages.findIndex((message) => readEntryId(message.meta) === targetId);
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
