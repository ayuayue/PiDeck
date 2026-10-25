/**
 * TipTap Composer 编辑器生命周期：创建、受控同步、DOM 注册。
 * 视图层（TipTapComposer）只负责挂载 EditorContent。
 */

import { useEffect, useLayoutEffect, useMemo, useRef, type RefObject } from "react";
import { useEditor, type Editor } from "@tiptap/react";
import type { ComposerEditorProps } from "./types";
import { createComposerExtensions } from "./tiptap/createComposerExtensions";
import { buildComposerEditorProps } from "./tiptap/buildComposerEditorProps";
import { plainTextToComposerDoc, serializeComposerEditorJson } from "./tiptap/plainTextCodec";
import { plainOffsetToPos, posToPlainOffset, registerComposerTipTapEditor } from "./tiptap/caretBridge";

export type UseTipTapComposerEditorArgs = Pick<ComposerEditorProps, "value" | "onChange" | "onCursorChange" | "onKeyDown" | "onPaste" | "onDrop" | "onDragOver" | "onChipClick" | "disabled" | "placeholder" | "className" | "caretRef" | "validCommandNames" | "validFilePaths" | "validSessionRefs" | "validQuotes"> & {
	hostRef: RefObject<HTMLDivElement | null>;
};

function syncEmptyClass(editor: Editor): void {
	editor.view.dom.classList.toggle("is-editor-empty", editor.isEmpty);
}

export function useTipTapComposerEditor(args: UseTipTapComposerEditorArgs): Editor | null {
	const { value, onChange, onCursorChange, onKeyDown, onPaste, onDrop, onDragOver, onChipClick, disabled, placeholder, className, caretRef, validCommandNames, validFilePaths, validSessionRefs, validQuotes, hostRef } = args;

	const whitelist = useMemo(() => ({ validCommandNames, validFilePaths, validSessionRefs, validQuotes }), [validCommandNames, validFilePaths, validSessionRefs, validQuotes]);
	const whitelistRef = useRef(whitelist);
	whitelistRef.current = whitelist;

	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onCursorChangeRef = useRef(onCursorChange);
	onCursorChangeRef.current = onCursorChange;
	const onKeyDownRef = useRef(onKeyDown);
	onKeyDownRef.current = onKeyDown;
	const onPasteRef = useRef(onPaste);
	onPasteRef.current = onPaste;
	const onDropRef = useRef(onDrop);
	onDropRef.current = onDrop;
	const onDragOverRef = useRef(onDragOver);
	onDragOverRef.current = onDragOver;
	const onChipClickRef = useRef(onChipClick);
	onChipClickRef.current = onChipClick;

	const composingRef = useRef(false);
	/** 最近一次由编辑器 onUpdate 推给父层的纯文本；用于区分「父层滞后」与「外部改草稿」。 */
	const lastEmittedRef = useRef(value);

	const emitPlainText = (editor: Editor) => {
		const next = serializeComposerEditorJson(editor.getJSON());
		lastEmittedRef.current = next;
		onChangeRef.current(next, posToPlainOffset(editor, editor.state.selection.from));
	};

	const editor = useEditor({
		immediatelyRender: false,
		editable: !disabled,
		extensions: createComposerExtensions(),
		content: plainTextToComposerDoc(value, whitelist),
		editorProps: buildComposerEditorProps(
			{
				composingRef,
				onKeyDown: (event) => {
					onKeyDownRef.current?.(event as unknown as React.KeyboardEvent<HTMLDivElement>);
				},
				onPaste: (event) => {
					onPasteRef.current?.(event as unknown as React.ClipboardEvent<HTMLDivElement>);
				},
				onDrop: (event) => {
					onDropRef.current?.(event as unknown as React.DragEvent<HTMLDivElement>);
				},
				onDragOver: (event) => {
					onDragOverRef.current?.(event as unknown as React.DragEvent<HTMLDivElement>);
				},
				onChipClick: (chip) => onChipClickRef.current?.(chip),
			},
			{ className, placeholder, disabled },
		),
		onUpdate: ({ editor: ed }) => {
			syncEmptyClass(ed);
			if (composingRef.current) return;
			emitPlainText(ed);
		},
		onSelectionUpdate: ({ editor: ed }) => {
			if (composingRef.current) return;
			onCursorChangeRef.current(posToPlainOffset(ed, ed.state.selection.from));
		},
		onCreate: ({ editor: ed }) => {
			syncEmptyClass(ed);
		},
	});

	useEffect(() => {
		const dom = editor?.view?.dom as HTMLElement | undefined;
		if (!dom || !editor) return;
		registerComposerTipTapEditor(dom, editor);
		const host = hostRef.current;
		if (host) registerComposerTipTapEditor(host, editor);
		return () => {
			registerComposerTipTapEditor(dom, null);
			if (host) registerComposerTipTapEditor(host, null);
		};
	}, [editor, hostRef]);

	useEffect(() => {
		if (!editor || editor.isDestroyed) return;
		editor.setEditable(!disabled);
		editor.setOptions({
			editorProps: buildComposerEditorProps(
				{
					composingRef,
					onKeyDown: (event) => {
						onKeyDownRef.current?.(event as unknown as React.KeyboardEvent<HTMLDivElement>);
					},
					onPaste: (event) => {
						onPasteRef.current?.(event as unknown as React.ClipboardEvent<HTMLDivElement>);
					},
					onDrop: (event) => {
						onDropRef.current?.(event as unknown as React.DragEvent<HTMLDivElement>);
					},
					onDragOver: (event) => {
						onDragOverRef.current?.(event as unknown as React.DragEvent<HTMLDivElement>);
					},
					onChipClick: (chip) => onChipClickRef.current?.(chip),
				},
				{ className, placeholder, disabled },
			),
		});
	}, [editor, disabled, className, placeholder]);

	// composition 结束后补一次同步：合成期间 onUpdate 被跳过，避免草稿 atom 一直为空导致无法发送。
	useEffect(() => {
		if (!editor) return;
		const dom = editor.view.dom;
		const onCompositionEnd = () => {
			composingRef.current = false;
			requestAnimationFrame(() => {
				if (composingRef.current || editor.isDestroyed) return;
				syncEmptyClass(editor);
				emitPlainText(editor);
			});
		};
		dom.addEventListener("compositionend", onCompositionEnd);
		return () => dom.removeEventListener("compositionend", onCompositionEnd);
	}, [editor]);

	/**
	 * 受控同步：只在父层 value 与「我们上次发出的文本」不一致时写回编辑器。
	 * 禁止用 editorText !== value 当条件——打字后父层尚未 re-render 时会把新输入打回旧草稿。
	 * 白名单变化只影响下次 setContent 解析，不作为同步触发依赖。
	 */
	/**
	 * 受控同步：只在父层 value 与「我们上次发出的文本」不一致时写回编辑器。
	 * 禁止用 editorText !== value 当条件——打字后父层尚未 re-render 时会把新输入打回旧草稿。
	 * 白名单变化只影响下次 setContent 解析，不作为同步触发依赖。
	 *
	 * 光标恢复是配对消费：写入方在事件处理器里同步 setDraft + 写 caretRef，
	 * 本 effect 只在 value 变化时重跑，因此同一趟 layout pass 里 value 就是请求
	 * 的 forValue。不匹配的请求 = 过期（要么其 value 从未渲染就被覆盖，要么写入
	 * 发生在 layout pass 之后），必须丢弃而非保留——否则会被下一次输入误用
	 * （旧实现：切换会话后第一次输入光标被重置回 draft.length）。
	 */
	useLayoutEffect(() => {
		if (!editor || editor.isDestroyed) return;
		const pending = caretRef?.current;
		const needsContentSync = value !== lastEmittedRef.current;
		if (needsContentSync) {
			editor.commands.setContent(plainTextToComposerDoc(value, whitelistRef.current), {
				emitUpdate: false,
			});
			lastEmittedRef.current = value;
			syncEmptyClass(editor);
		}
		const caret = pending && pending.forValue === value ? pending.pos : null;
		if (typeof caret === "number" && caretRef) {
			// 程序化改动（引用插入/历史回填/运行时 editorText 恢复等）配对消费。
			editor.commands.setTextSelection(plainOffsetToPos(editor, Math.min(caret, value.length)));
			caretRef.current = null;
		} else if (needsContentSync) {
			// 外部同步（切换会话/草稿回填/发送清空）没有配对光标请求时，
			// setContent 会把选区映射到旧文档的任意位置；兜底恢复到文末。
			editor.commands.setTextSelection(plainOffsetToPos(editor, value.length));
		}
		if (pending && caretRef && pending.forValue !== value) {
			// 过期请求：随它所属的 value 已不可能再渲染，丢弃而非保留。
			caretRef.current = null;
		}
	}, [value, editor, caretRef]);

	return editor;
}
