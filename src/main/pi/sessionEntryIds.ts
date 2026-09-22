/**
 * 会话 JSONL entryId 对齐与重发截断的纯函数。
 * 抽离出 AgentManager 以便单测覆盖「空 assistant 不消费 slot」这类错位回归。
 */

/** 会消费 entryId 槽位的对话角色消息。 */
export const ROLE_MESSAGE_ROLES = ["user", "assistant", "toolResult"] as const;

/**
 * 判断一个 message 条目的 role 是否消费 entryId 槽位。
 *
 * 为什么需要显式判定：会话 JSONL 里 `type:"message"` 的条目不止这三种角色。pi 0.86 起
 * 系统提示与工具清单变更也会落成 `message.role === "system"` 的条目（transcript-backed
 * prompt/tool 更新：首个请求一条完整 sections，之后按 name 打补丁、工具增减走
 * toolsAdded/toolsRemoved，见 pi docs session-format#entry-types）。
 *
 * AgentMessageProjector 只为 user/assistant/toolResult 分配 entryId，因此凡「按 id 与消息
 * 一一对齐」的地方（取尾部 N 条 id、统计文件窗口位置）都必须用同一判定过滤，否则窗口内
 * 出现 system 条目时整段 id 会错位，编辑/删除/重发会落到相邻条目上。
 */
export function isRoleMessageRole(role: unknown): role is (typeof ROLE_MESSAGE_ROLES)[number] {
	return role === "user" || role === "assistant" || role === "toolResult";
}

/**
 * 从 activeEntryIds 消费一个槽位。
 * 业务规则：get_entries 的 message 型 entry 与 get_messages 的
 * user/assistant/toolResult 一一对应；即使桌面端因空文本跳过渲染，
 * 也必须推进 index，否则后续消息的 entryId 会整体前移错位。
 */
export function takeActiveEntryId(activeEntryIds: string[] | undefined, entryIndex: number): { entryId?: string; nextIndex: number } {
	const entryId = activeEntryIds && entryIndex < activeEntryIds.length ? activeEntryIds[entryIndex] : undefined;
	return { entryId, nextIndex: entryIndex + 1 };
}

/**
 * 模拟 convertAgentMessages 的 entryId 对齐逻辑（仅角色 + 空文本跳过规则）。
 * 用于回归：工具调用回合里「无文本的 assistant」不得打乱后续 entryId。
 */
export function alignEntryIdsForDisplayMessages(rawMessages: Array<{ role?: string; content?: unknown }>, activeEntryIds: string[], extractText: (content: unknown) => string): Array<{ role: string; entryId?: string; skipped: boolean }> {
	let entryIndex = 0;
	const result: Array<{ role: string; entryId?: string; skipped: boolean }> = [];

	for (const typed of rawMessages) {
		if (!typed || typeof typed !== "object") continue;
		const role = typed.role;
		if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;

		const { entryId, nextIndex } = takeActiveEntryId(activeEntryIds, entryIndex);
		// 无论是否渲染，message 型 entry 都要消费槽位
		entryIndex = nextIndex;

		if (role === "user" || role === "assistant") {
			const text = extractText(typed.content);
			const skipped = !text.trim();
			if (skipped && role === "assistant") {
				result.push({ role, entryId, skipped: true });
				continue;
			}
			if (skipped && role === "user") {
				result.push({ role, entryId, skipped: true });
				continue;
			}
			result.push({ role, entryId, skipped: false });
			continue;
		}

		// toolResult 始终展示（即使结果为空也有 ✓/✗ 摘要）
		result.push({ role: "tool", entryId, skipped: false });
	}

	return result;
}

/**
 * 收集 rootEntryId 及其全部后代 entry（沿 parentId 向下闭包）。
 * 重发时用于截断「该用户消息 + 之后的 assistant/tool」整段分支。
 */
export function collectDescendantEntryIds(lines: string[], rootEntryId: string): Set<string> {
	const removeIds = new Set<string>([rootEntryId]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const rawLine of lines) {
			const line = rawLine?.trim();
			if (!line) continue;
			try {
				const parsed = JSON.parse(line) as {
					id?: string;
					parentId?: string;
					type?: string;
				};
				if (!parsed?.id || parsed.type === "deleted") continue;
				if (parsed.parentId && removeIds.has(parsed.parentId) && !removeIds.has(parsed.id)) {
					removeIds.add(parsed.id);
					grew = true;
				}
			} catch {
				// 跳过无法解析的行
			}
		}
	}
	return removeIds;
}

/**
 * 在 JSONL 中按「角色 + 文本」找最后一次匹配的用户消息行。
 * 用于乐观更新消息（无 entryId）的重发定位：优先最后一次，避免重复文案命中更早的历史。
 */
export function findLastUserMessageLine(lines: string[], text: string, extractText: (content: unknown) => string): { lineIndex: number; entry: Record<string, unknown> } | null {
	let found: { lineIndex: number; entry: Record<string, unknown> } | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim();
		if (!line) continue;
		try {
			const entry = JSON.parse(line) as Record<string, unknown>;
			if (entry.type === "deleted") continue;
			const message = entry.message as { role?: string; content?: unknown } | undefined;
			if (message?.role !== "user") continue;
			const entryText = extractText(message.content);
			if (entryText === text) {
				found = { lineIndex: i, entry };
			}
		} catch {
			// 跳过
		}
	}
	return found;
}

/**
 * 校验重发根节点必须是 user 消息，且文本与目标一致。
 * 防止 entryId 错位时把 assistant/更早的 user 当成截断根，误删整段历史。
 */
export function assertResendRootEntry(entry: Record<string, unknown>, expectedText: string, extractText: (content: unknown) => string): void {
	const message = entry.message as { role?: string; content?: unknown } | undefined;
	if (!message || message.role !== "user") {
		throw new Error("Resend root must be a user message entry");
	}
	const entryText = extractText(message.content);
	// Image-only messages use a localized UI placeholder that is not present in JSONL.
	const isImagePlaceholder = expectedText === "[图片]" || expectedText === "[Image]";
	if (entryText !== expectedText && !isImagePlaceholder) {
		throw new Error(`Resend root text mismatch: expected ${JSON.stringify(expectedText.slice(0, 80))}, got ${JSON.stringify(entryText.slice(0, 80))}`);
	}
}
