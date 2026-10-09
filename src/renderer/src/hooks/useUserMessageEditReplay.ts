import { useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { ImageContent } from "../../../shared/types";
import { setSessionAttachmentsAtom, setSessionQuotesAtom } from "../atoms/composer-atoms";
import { extractQuoteTokens, pruneUnreferencedQuotes, rehydrateDraftFromMessage } from "../components/session/composer/quoteChip";

/**
 * 「编辑重发 / fork 重放」把用户消息回填到输入框。
 *
 * 消息文本里可能含自包含引用块（`<quoted_context>` / `<referenced_session>` /
 * `<skill>` / `<prompt_template>`）；直接回填会把 XML 原文塞进输入框。这里还原成 chip
 * 形态：quote 重建快照 + `#q<id>` token，其余还原为 mention 文本，由 composer 的
 * 白名单解析重新渲染成 chip（见 rehydrateDraftFromMessage）。
 */
export function useUserMessageEditReplay(args: { setPrompt: (value: string | ((current: string) => string)) => void; pendingComposerCaretRef: MutableRefObject<number | null>; composerRef: RefObject<HTMLElement | null>; currentSessionIdRef: MutableRefObject<string | undefined> }): void {
	const setQuotes = useSetAtom(setSessionQuotesAtom);
	const setAttachments = useSetAtom(setSessionAttachmentsAtom);
	// setPrompt 每次渲染都是新函数：放 ref 里，避免监听器每次渲染重挂、也避免闭包过期。
	const setPromptRef = useRef(args.setPrompt);
	setPromptRef.current = args.setPrompt;
	const { pendingComposerCaretRef, composerRef, currentSessionIdRef } = args;

	useEffect(() => {
		const handler = (event: Event) => {
			const detail = (event as CustomEvent<{ text?: string; images?: ImageContent[] }>).detail;
			if (typeof detail?.text !== "string") return;
			const { draft, quotes } = rehydrateDraftFromMessage(detail.text);
			const sessionId = currentSessionIdRef.current;
			// 编辑回填替换整份附件；纯文本要清掉旧图，ref 图片保留引用，发送时再按需读取。
			if (sessionId) setAttachments({ sessionId, value: [...(detail.images ?? [])] });
			if (sessionId && quotes.length > 0) {
				// 与时间线「引用追问」同一登记语义：只保留新草稿仍引用的快照。
				const referencedIds = new Set(extractQuoteTokens(draft).map((occurrence) => occurrence.id));
				setQuotes({
					sessionId,
					value: (current) => ({
						...pruneUnreferencedQuotes(current, referencedIds),
						...Object.fromEntries(quotes.map((snippet) => [snippet.id, snippet])),
					}),
				});
			}
			setPromptRef.current(draft);
			// 光标移至文本末尾，利用 caretRef 机制在渲染后恢复
			pendingComposerCaretRef.current = draft.length;
			requestAnimationFrame(() => {
				composerRef.current?.focus();
			});
		};
		window.addEventListener("user-message-edit", handler);
		return () => window.removeEventListener("user-message-edit", handler);
	}, [composerRef, currentSessionIdRef, pendingComposerCaretRef, setAttachments, setQuotes]);
}
