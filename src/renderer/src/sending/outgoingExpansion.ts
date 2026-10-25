import { replaceOutsideProtected } from "../utils/protectedText";

/**
 * 发送前展开管线（发布乐观气泡之后的两步）。
 *
 * 完整顺序（见 `docs/chip-rendering-refactor-plan.md` §3.2）：
 *   1) 引用 token `#q<id>` → `<quoted_context>`：在乐观发布**之前**同步完成
 *      （见 `components/session/composer/quoteChip.expandQuoteTokens`，纯函数、无 IO，
 *      先展开才能让气泡不闪 `#q` token）。
 *   2) 会话引用 `&名称` → `<referenced_session>`：需要读历史消息（IO），发布后异步做。
 *   3) 提示词模板 `/名称` → `<prompt_template>`：纯文本替换，紧接第 2 步。
 *
 * 两步共同规则：**已生成的块区间只读**。否则引用里提到的 `&会话名` / `/模板名`
 * 会被当成真引用展开，落盘的引用原文被改写（2026-10 实测复现，见
 * `tests/expandOutgoingMessage.test.mjs`）。
 */

export type SessionReferenceTarget = {
	/** 会话 id（取参考消息用） */
	id: string;
	/** 会话显示名（`&名称` 里的名称） */
	name: string;
};

/**
 * 把文本中的 `&会话名` 展开成 `<referenced_session>` 块。
 *
 * - 按名称长度降序匹配，避免短名吃掉长名前缀；
 * - 命名是用户可写的，按大小写不敏感匹配（与输入框 chip 解析一致）；
 * - 取不到参考内容时整段丢弃（保持历史行为：无内容的引用不留空块）；
 * - 替换用函数而非字符串：会话正文里的 `$&`、`$'` 不会被当成替换模式。
 */
export async function expandSessionReferences(message: string, sessions: readonly SessionReferenceTarget[], resolveContext: (session: SessionReferenceTarget) => Promise<string> | string): Promise<string> {
	if (!message.includes("&") || sessions.length === 0) return message;
	const byLongestName = [...sessions].sort((left, right) => right.name.length - left.name.length);
	let resolved = message;
	for (const session of byLongestName) {
		const raw = `&${session.name}`;
		if (!raw.length || !resolved.toLowerCase().includes(raw.toLowerCase())) continue;
		const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(escaped, "gi");
		const context = await resolveContext(session);
		const block = context ? `<referenced_session name="${session.name}">\n${context}\n</referenced_session>` : "";
		resolved = replaceOutsideProtected(resolved, pattern, () => block);
	}
	return resolved;
}
