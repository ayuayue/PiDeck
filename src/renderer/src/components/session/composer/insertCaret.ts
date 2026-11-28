import type { ComposerCaretRequest } from "./types";

/**
 * 插入类操作（拖入文件引用 / 粘贴路径 / 选建议）该用哪个光标。
 *
 * 插入路径的协议是「同步改草稿 + 写 `caretRef`」→ 编辑器在**下一趟 layout pass** 才把
 * 内容与选区同步过去。这中间的窗口里 DOM 选区还是旧值，连续拖入第二个文件时常见为 0：
 * 按它拼接会把上一次插入的 `@A` 挤掉（#564）。
 *
 * 判据只有一条：`pending.forValue` 与当前草稿相等，说明这条程序化光标就是这份草稿的，
 * 直接采信；不相等才是过期请求（见 `useTipTapComposerEditor` 的配对消费），退回 DOM 光标。
 */
export function resolveInsertCaret(input: { pending: ComposerCaretRequest | null; liveDraft: string; domCaret: number | null; fallback: number }): number {
	if (input.pending !== null && input.pending.forValue === input.liveDraft) return input.pending.pos;
	return input.domCaret ?? input.fallback;
}

/** 插入文件引用，并把光标放在分隔空格后，让后续输入有独立的文本位置。 */
export function insertFileReferences(draft: string, caret: number, refs: readonly string[]): ComposerCaretRequest {
	const before = draft.slice(0, caret);
	const after = draft.slice(caret);
	const prefix = before && !/\s$/.test(before) ? " " : "";
	const text = before + prefix + refs.join(" ") + " ";
	return { pos: text.length, forValue: text + (after.startsWith(" ") ? after.slice(1) : after) };
}
