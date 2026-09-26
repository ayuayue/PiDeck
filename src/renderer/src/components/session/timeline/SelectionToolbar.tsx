import { useMemo } from "react";
import { createPortal } from "react-dom";
import { useAtomValue, useSetAtom } from "jotai";
import { Quote } from "lucide-react";
import { sessionDraftByIdAtom, setSessionDraftAtom, setSessionQuotesAtom } from "../../../atoms";
import { buildDraftWithAppendedQuote, buildQuoteToken, createQuoteId, extractQuoteTokens, pruneUnreferencedQuotes, type QuoteSnippet } from "../composer/quoteChip";
import { computeToolbarPosition } from "./selectionToolbarPolicy";
import type { TimelineSelectionQuote } from "../../../hooks/useTimelineSelection";
import { t } from "../../../i18n";

/** 浮层按钮尺寸估算（与 computeToolbarPosition 的入参一致；宽度自适应文案，取中值估计） */
const TOOLBAR_WIDTH = 104;
const TOOLBAR_HEIGHT = 28;

/**
 * 时间线划选浮层：「引用并提问」按钮。
 * 点击后同一 tick 完成（chip 是指针，快照在仓库）：
 * 1. 快照登记进 session 域 atom，顺带清理草稿已不引用的孤儿；
 * 2. 草稿末尾追加 #q<id> token（composer 内渲染为 ❝ 引用 chip）；
 * 3. 清除浏览器选区并聚焦本栏 composer。
 */
export function SelectionToolbar(props: { quote: TimelineSelectionQuote | null; sessionId: string; onConsume: () => void }) {
	const drafts = useAtomValue(sessionDraftByIdAtom);
	const setDraft = useSetAtom(setSessionDraftAtom);
	const setQuotes = useSetAtom(setSessionQuotesAtom);
	const quote = props.quote;

	const position = useMemo(() => {
		if (!quote) return null;
		return computeToolbarPosition(quote.rect, { width: window.innerWidth, height: window.innerHeight }, { width: TOOLBAR_WIDTH, height: TOOLBAR_HEIGHT });
	}, [quote]);

	if (!quote || !position) return null;

	const handleInsert = () => {
		const snippet: QuoteSnippet = {
			id: createQuoteId(),
			text: quote.text,
			messageId: quote.messageId,
			createdAt: Date.now(),
		};
		const nextDraft = buildDraftWithAppendedQuote(drafts[props.sessionId] ?? "", buildQuoteToken(snippet.id));
		const referencedIds = new Set(extractQuoteTokens(nextDraft).map((occurrence) => occurrence.id));
		setQuotes({
			sessionId: props.sessionId,
			value: (current) => ({
				...pruneUnreferencedQuotes(current, referencedIds),
				[snippet.id]: snippet,
			}),
		});
		setDraft({ sessionId: props.sessionId, value: nextDraft });
		// 清除浏览器选区，避免浮层残留/再次评估
		window.getSelection()?.removeAllRanges();
		props.onConsume();
		// 聚焦本栏输入框（SurfaceComponents「编辑重发」同款作用域选择器）
		document.querySelector<HTMLElement>(".composer-box .tiptap-composer-host [contenteditable], .composer-box textarea")?.focus();
	};

	return createPortal(
		<button
			type="button"
			// 挂载点标记：useTimelineSelection 的 pointerdown 守卫用它识别「点击浮层自身」，
			// 避免先收起导致随后的 click 拿不到 quote。改名前先同步两处。
			data-quote-toolbar="true"
			// 紧凑工具条（Codex 同款形态）：悬浮卡片 + 毛玻璃，hover 微亮、按下微缩
			className="fixed z-[80] inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg border border-border-subtle bg-bg-panel/90 px-2 text-caption font-medium text-text-primary shadow-[0_6px_20px_rgba(0,0,0,0.16)] backdrop-blur-md transition-[background-color,border-color] duration-150 hover:border-border hover:bg-bg-hover"
			style={{ top: position.top, left: position.left }}
			onClick={handleInsert}
		>
			<Quote size={13} className="shrink-0 text-text-secondary" aria-hidden="true" />
			<span className="whitespace-nowrap">{t("app.quoteAddToPrompt")}</span>
		</button>,
		document.body,
	);
}
