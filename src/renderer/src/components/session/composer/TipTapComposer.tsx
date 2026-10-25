/**
 * TipTapComposer —— 会话输入框视图壳。
 * 编辑器生命周期见 useTipTapComposerEditor；本文件只做 ref / 焦点壳 / EditorContent /
 * 右键粘贴菜单（纯文本粘贴 / 原样粘贴）。
 */

import { forwardRef, useRef } from "react";
import { EditorContent, type Editor } from "@tiptap/react";
import { ClipboardPaste } from "lucide-react";
import type { ComposerEditorProps } from "./types";
import { useTipTapComposerEditor } from "./useTipTapComposerEditor";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../../ui-shadcn/context-menu";
import { htmlToPlainText, readClipboardHtmlConsistent, readClipboardText } from "../../../utils/clipboard";
import { insertComposerPlainTextFromEditor } from "./tiptap/insertComposerPlainText";
import { t } from "../../../i18n";

export type TipTapComposerProps = ComposerEditorProps;

/**
 * 右键粘贴：始终落到纯文本。
 * 即便 HTML 与 text 槽同源，也不走 TipTap HTML 插入——mention chip / &amp;
 * 会被 TipTap 解析成原子节点或重复 &，后续每个按键再同步一次就「输入一个字多一个 &」。
 * 同源 HTML 只用来还原换行结构（htmlToPlainText），再按纯文本插入。
 */
function insertClipboard(editor: Editor) {
	const text = readClipboardText();
	const html = readClipboardHtmlConsistent();
	const payload = html ? htmlToPlainText(html) : text;
	if (!payload) return;
	insertComposerPlainTextFromEditor(editor, payload);
}

export const TipTapComposer = forwardRef<HTMLDivElement, TipTapComposerProps>(function TipTapComposer(props, ref) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const setHostRef = (node: HTMLDivElement | null) => {
		hostRef.current = node;
		if (typeof ref === "function") ref(node);
		else if (ref) ref.current = node;
	};

	const editor = useTipTapComposerEditor({
		...props,
		hostRef,
	});

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div
					ref={setHostRef}
					// overflow-hidden：把滚动关进 ProseMirror；否则 EditorContent 中间层
					// 不传高度约束时，内容会直接撑出 composer-box。
					// relative：输入预测的 ghost 文案以绝对定位怼齐 ProseMirror 的 padding。
					className="tiptap-composer-host relative flex min-w-0 flex-1 flex-col overflow-hidden"
					data-placeholder={props.placeholder}
					onFocus={props.onFocus}
					onBlur={props.onBlur}
				>
					<EditorContent editor={editor} className="tiptap-composer-surface flex min-w-0 flex-1 flex-col overflow-hidden" />
					{
						// 只作视觉层：pointer-events-none 不抢光标，aria-hidden 不进读屏（否则会被当成
						// 已输入的正文）。字号/行高/边距全部跟随 .rich-input 的 token，保证「看起来就像
						// 用户已经打了这几个字」，位置与 placeholder 完全重合（placeholder 此时被置空）。
						// 颜色必须走 text-text-faint（主题最浅文字档）：正文色继承自 .rich-input，
						// 写成 text-tertiary（少了 text- 前缀）是无效 utility，会退化成正文原色——
						// 2026-10 用户反馈「预测的文字不是灰色、太重」，就是这个类没生效。
						props.suggestion ? (
							<div className="pointer-events-none absolute inset-x-3 top-[10px] flex items-start gap-2 text-text-faint" style={{ fontSize: "var(--font-size-input)", lineHeight: "var(--line-height-input)" }} aria-hidden="true">
								<span className="min-w-0 truncate">{props.suggestion}</span>
								{/* 键帽比文案深一档：ghost 句子要「轻」，但 Tab 提示必须读得清（faint 再叠 opacity 会糊）。 */}
								<kbd className="mt-[3px] shrink-0 rounded border border-border-subtle px-1 text-micro leading-4 text-text-tertiary opacity-80">Tab</kbd>
							</div>
						) : null
					}
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent alignOffset={-6}>
				<ContextMenuItem
					onSelect={() => {
						if (!editor) return;
						void (async () => {
							// 图片/文件路径由 controller 统一处理（与 Ctrl+V 同一优先级链）；
							// 纯文本返回 false，走本地纯文本插入（不解析 HTML）
							const handled = await props.onPasteClipboard?.();
							if (!handled) insertClipboard(editor);
							// 菜单点击会让编辑器失焦，无论哪条路径都恢复焦点保证后续输入/光标可见
							editor.commands.focus();
						})();
					}}
				>
					<ClipboardPaste size={13} strokeWidth={2} aria-hidden="true" />
					{t("common.paste")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
});
