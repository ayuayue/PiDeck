import { memo, useEffect, useRef, useState } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, indentUnit } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { linter, lintGutter } from "@codemirror/lint";
import { jsonParseLinter } from "@codemirror/lang-json";
import { baseEditorExtensions, foldMarkerDOM, resolveEditorLanguage } from "../../utils/codemirrorSetup";
import { t } from "../../i18n";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";

export type CodeMirrorEditorProps = {
	value: string;
	onChange?: (value: string) => void;
	/** 文件扩展名（"ts"）或旧 Monaco 语言 id（"markdown"），解析见 resolveEditorLanguage。 */
	language?: string;
	height?: string;
	readOnly?: boolean;
	/** 鼠标选中文本后右键菜单「引用选中内容」：携带选区起止行号（1 起），由调用方插入输入框。 */
	onAttachSelection?: (startLine: number, endLine: number) => void;
	/** 挂载/变化时滚动定位到该行（1 起），并把光标移动到行首。
	 * 用于 `path:line` 链接（对齐 VS Code/Claude Code 的行内跳转）；
	 * 行号超界时钳制到最近行。 */
	initialLine?: number;
};

/** 右键选区菜单状态：无选区时保持 null（不接管浏览器右键菜单） */
type SelectionMenu = {
	x: number;
	y: number;
	startLine: number;
	endLine: number;
};

/** 统一封装：与旧 MonacoEditor 的 props 完全兼容（value/onChange/language/height/readOnly），
 * 外部切换时零成本替换。EditorView 生命周期由本组件托管：卸载 dispose、外部 value 变化
 * 以「与当前文档不同才替换」的方式同步，避免覆盖用户正在输入的内容。 */
export const CodeMirrorEditor = memo(function CodeMirrorEditor({ value, onChange, language, height = "100%", readOnly = false, onAttachSelection, initialLine }: CodeMirrorEditorProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(onChange);
	onChangeRef.current = onChange;
	const onAttachSelectionRef = useRef(onAttachSelection);
	onAttachSelectionRef.current = onAttachSelection;
	// 外部 value 快照：仅用于跳过「onChange 已同步过」的重复 dispatch
	const lastValueRef = useRef(value);
	// 目标行最新值：挂载 effect 与变化 effect 都读 ref，memo 组件不因 props 重建函数
	const initialLineRef = useRef(initialLine);
	initialLineRef.current = initialLine;
	const [selectionMenu, setSelectionMenu] = useState<SelectionMenu | null>(null);

	// 右键：存在文本选区时接管默认菜单，弹出「引用选中内容」；无选区不拦截（保留浏览器菜单）。
	// 行号取 selection.main 的起止位置所在行（CM6 行号从 1 起，与编辑器 gutter 一致）。
	const handleContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
		const view = viewRef.current;
		const main = view?.state.selection.main;
		if (!view || !main || main.from === main.to) return;
		event.preventDefault();
		const startLine = view.state.doc.lineAt(main.from).number;
		const endLine = view.state.doc.lineAt(main.to).number;
		setSelectionMenu({ x: event.clientX, y: event.clientY, startLine, endLine });
	};

	useEffect(() => {
		if (!hostRef.current) return;
		const resolvedLanguage = resolveEditorLanguage(language);
		// JSON 语言包（LanguageSupport）的 language 字段为 "json"，用于启用 lint
		const isJson = resolvedLanguage !== null && "language" in resolvedLanguage && resolvedLanguage.language.name === "json";
		const view = new EditorView({
			parent: hostRef.current,
			state: EditorState.create({
				doc: value,
				extensions: [
					...baseEditorExtensions({ readOnly, wordWrap: true, language: resolvedLanguage }),
					// 与 Monaco 默认一致的编辑体验：行号/折叠/自动换行/括号匹配/补全/查找
					lineNumbers(),
					foldGutter({ markerDOM: foldMarkerDOM }),
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
					// JSON 语法错误即时提示（配置文件编辑高价值；YAML 暂无官方 linter）
					...(isJson ? [lintGutter(), linter(jsonParseLinter())] : []),
					keymap.of([
						...closeBracketsKeymap,
						...defaultKeymap,
						...searchKeymap,
						...historyKeymap,
						...foldKeymap,
						...completionKeymap,
						indentWithTab,
						// Ctrl+/ 注释/取消注释（语言包支持时）
						{ key: "Mod-/", run: toggleComment },
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
		// 文档就绪即定位（值为空时跳过：真实内容到达后由 value effect 再定位一次）
		const targetLine = initialLineRef.current;
		if (targetLine !== undefined && view.state.doc.lines > 0) {
			const line = view.state.doc.line(Math.min(targetLine, view.state.doc.lines));
			view.dispatch({
				selection: { anchor: line.from },
				effects: [EditorView.scrollIntoView(line.from, { y: "center" })],
			});
		}
		return () => {
			view.destroy();
			viewRef.current = null;
		};
		// 语言/只读变化需重建实例（CM6 无热切换语言的标准路径，重建成本低且简单可靠）
	}, [language, readOnly]);

	// initialLine 变化（重新点击同文件链接/切换 tab）：文档未变时重新定位
	useEffect(() => {
		const view = viewRef.current;
		const targetLine = initialLineRef.current;
		if (!view || targetLine === undefined) return;
		const line = view.state.doc.line(Math.min(targetLine, view.state.doc.lines));
		view.dispatch({
			selection: { anchor: line.from },
			effects: [EditorView.scrollIntoView(line.from, { y: "center" })],
		});
	}, [initialLine]);

	// 外部 value 同步：只在文档确实不同时替换（防止覆盖用户输入、防止 onChange 回环）
	useEffect(() => {
		const view = viewRef.current;
		if (!view || view.state.doc.toString() === value) return;
		view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
		// 内容替换完成后再定位：mount 时 doc 可能为空，这里拿走目标行
		const targetLine = initialLineRef.current;
		if (targetLine !== undefined) {
			const line = view.state.doc.line(Math.min(targetLine, view.state.doc.lines));
			view.dispatch({
				selection: { anchor: line.from },
				effects: [EditorView.scrollIntoView(line.from, { y: "center" })],
			});
		}
	}, [value]);

	return (
		<div ref={hostRef} style={{ height, minHeight: 60 }} className="codemirror-host" onContextMenu={handleContextMenu}>
			{/* 引用选中内容：虚拟锚点钉在右键坐标上（与 FileContextMenu 同模式，Radix 处理视口碰撞/ESC） */}
			{selectionMenu && (
				<DropdownMenu
					open
					onOpenChange={(open) => {
						if (!open) setSelectionMenu(null);
					}}
				>
					<DropdownMenuTrigger
						aria-hidden
						tabIndex={-1}
						style={{
							position: "fixed",
							left: selectionMenu.x,
							top: selectionMenu.y,
							width: 0,
							height: 0,
							padding: 0,
							border: 0,
							background: "transparent",
							pointerEvents: "none",
						}}
					/>
					<DropdownMenuContent align="start" side="bottom" className="min-w-44">
						<DropdownMenuItem
							onSelect={() => {
								const menu = selectionMenu;
								setSelectionMenu(null);
								onAttachSelectionRef.current?.(menu.startLine, menu.endLine);
							}}
						>
							{t("editor.attachSelectionRange", {
								range: selectionMenu.startLine === selectionMenu.endLine ? String(selectionMenu.startLine) : `${selectionMenu.startLine}-${selectionMenu.endLine}`,
							})}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			)}
		</div>
	);
});
