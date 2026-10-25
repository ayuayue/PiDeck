/**
 * TipTap editorProps：把上层 Composer 回调桥成 ProseMirror DOM 事件。
 * 与 React 组件生命周期解耦，便于单测与复用。
 */

import type { EditorProps } from "@tiptap/pm/view";
import type { ComposerChip } from "../chips";
import { stripChipDisplayPrefix } from "../chips";
import { htmlToPlainText } from "../../../../utils/clipboard";
import { toComposerDomKeyboardEvent } from "./domEventBridge";
import { insertComposerPlainText } from "./insertComposerPlainText";

export type ComposerEditorDomHandlers = {
	composingRef: { current: boolean };
	onKeyDown?: (event: KeyboardEvent) => void;
	onPaste?: (event: ClipboardEvent) => void;
	onDrop?: (event: DragEvent) => void;
	onDragOver?: (event: DragEvent) => void;
	onChipClick?: (chip: ComposerChip) => void;
};

function readChipFromDom(chipEl: HTMLElement): ComposerChip | null {
	const raw = chipEl.getAttribute("data-raw") ?? "";
	const kind = chipEl.getAttribute("data-type");
	if (kind !== "file" && kind !== "skill" && kind !== "session" && kind !== "quote") return null;
	// DOM 中的展示文本必须按类型剥前缀（file 的 @、skill 的 /skill:），
	// 不能统一剥 [@/&❝]——那会把 label 自身的 / & ❝ 当成前缀吃掉（引用路径/命令场景）。
	const rawLabel = chipEl.querySelector(".input-chip__label")?.textContent?.trim() || raw.slice(1);
	const label = stripChipDisplayPrefix(kind, rawLabel);
	return { start: 0, end: raw.length, raw, kind, label };
}

export function buildComposerEditorProps(
	handlers: ComposerEditorDomHandlers,
	options: {
		className?: string;
		placeholder?: string;
		disabled?: boolean;
	},
): EditorProps {
	return {
		attributes: {
			class: ["rich-input", "ProseMirror", options.className].filter(Boolean).join(" "),
			role: "textbox",
			"aria-multiline": "true",
			...(options.placeholder ? { "data-placeholder": options.placeholder } : {}),
			...(options.disabled ? { "aria-disabled": "true" } : {}),
		},
		handleKeyDown: (_view, event) => {
			handlers.onKeyDown?.(toComposerDomKeyboardEvent(event));
			return event.defaultPrevented;
		},
		handlePaste: (view, event) => {
			// 先给 controller：文件路径 / 位图 / 单条绝对路径由上层接管
			handlers.onPaste?.(event);
			if (event.defaultPrevented) return true;
			// 普通文本一律按纯文本插入。TipTap 默认会解析 text/html，
			// Windows 剪贴板残留的 &amp; / mention 标签会把正文搅成重复 & 或 chip。
			const text = event.clipboardData?.getData("text/plain") ?? "";
			const html = text ? "" : (event.clipboardData?.getData("text/html") ?? "");
			const payload = text || (html ? htmlToPlainText(html) : "");
			if (!payload) return false;
			event.preventDefault();
			insertComposerPlainText(view, payload);
			return true;
		},
		handleDOMEvents: {
			compositionstart: () => {
				handlers.composingRef.current = true;
				return false;
			},
			compositionend: () => {
				handlers.composingRef.current = false;
				return false;
			},
			dragover: (_view, event) => {
				handlers.onDragOver?.(event);
				return event.defaultPrevented;
			},
			drop: (_view, event) => {
				handlers.onDrop?.(event);
				return event.defaultPrevented;
			},
			click: (_view, event) => {
				if (!handlers.onChipClick) return false;
				const target = event.target as HTMLElement | null;
				// 定位引用元素：文件/技能引用已做普通文本化（span[data-raw]，无 chip class），
				// session/quote 仍是 .input-chip；统一按 [data-raw][data-type] 向上找，两种形态均命中。
				const chipEl = target?.closest?.("[data-raw][data-type]") as HTMLElement | null;
				if (!chipEl) return false;
				const chip = readChipFromDom(chipEl);
				if (!chip) return false;
				// 仅 session 引用需要拦截点击（跳转到被引用的会话）；
				// file/skill/quote 点击放行编辑器默认光标定位（用户反馈：点击不应打开文件/分屏）。
				if (chip.kind !== "session") return false;
				handlers.onChipClick(chip);
				return true;
			},
		},
	};
}
