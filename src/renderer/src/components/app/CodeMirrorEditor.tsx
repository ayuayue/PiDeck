import { memo, useEffect, useRef } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, indentUnit } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { baseEditorExtensions, resolveEditorLanguage } from "../../utils/codemirrorSetup";

export type CodeMirrorEditorProps = {
	value: string;
	onChange?: (value: string) => void;
	/** 文件扩展名（"ts"）或旧 Monaco 语言 id（"markdown"），解析见 resolveEditorLanguage。 */
	language?: string;
	height?: string;
	readOnly?: boolean;
};

/** 统一封装：与旧 MonacoEditor 的 props 完全兼容（value/onChange/language/height/readOnly），
 * 外部切换时零成本替换。EditorView 生命周期由本组件托管：卸载 dispose、外部 value 变化
 * 以「与当前文档不同才替换」的方式同步，避免覆盖用户正在输入的内容。 */
export const CodeMirrorEditor = memo(function CodeMirrorEditor({
	value,
	onChange,
	language,
	height = "100%",
	readOnly = false,
}: CodeMirrorEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	// 外部 value 快照：仅用于跳过「onChange 已同步过」的重复 dispatch
	const lastValueRef = useRef(value);

	useEffect(() => {
		if (!hostRef.current) return;
		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					...baseEditorExtensions({ readOnly, wordWrap: true, language: resolveEditorLanguage(language) }),
					// 与 Monaco 默认一致的编辑体验：行号/折叠/自动换行/括号匹配/补全/查找
					lineNumbers(),
					foldGutter(),
					history(),
					drawSelection(),
					dropCursor(),
					indentOnInput(),
					bracketMatching(),
					closeBrackets(),
					autocompletion(),
					rectangularSelection(),
					crosshairCursor(),
					highlightActiveLine(),
					highlightActiveLineGutter(),
					highlightSelectionMatches(),
					indentUnit.of("  "),
					keymap.of([
						...closeBracketsKeymap,
						...defaultKeymap,
						...searchKeymap,
						...historyKeymap,
						...foldKeymap,
						...completionKeymap,
						indentWithTab,
					]),
					EditorView.updateListener.of((update) => {
						if (update.docChanged) {
							const next = update.state.doc.toString();
							lastValueRef.current = next;
							onChangeRef.current?.(next);
						}
					}),
				],
			}),
		});
		viewRef.current = view;
		lastValueRef.current = value;
		return () => {
			view.destroy();
			viewRef.current = null;
		};
	// 语言/只读变化需重建实例（CM6 无热切换语言的标准路径，重建成本低且简单可靠）
	}, [language, readOnly]);

	// 外部 value 同步：只在文档确实不同时替换（防止覆盖用户输入、防止 onChange 回环）
	useEffect(() => {
		const view = viewRef.current;
		if (!view || view.state.doc.toString() === value) return;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
	}, [value]);

	return <div ref={hostRef} style={{ height, minHeight: 60 }} className="codemirror-host" />;
});
