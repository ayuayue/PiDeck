import { useEffect, useRef } from "react";
import { ChangeSet, EditorState, Text } from "@codemirror/state";
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, dropCursor, rectangularSelection, crosshairCursor } from "@codemirror/view";
import { foldGutter, foldKeymap, indentOnInput, bracketMatching, indentUnit } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { MergeView, unifiedMergeView, updateOriginalDoc } from "@codemirror/merge";
import { baseEditorExtensions, resolveEditorLanguage } from "../../utils/codemirrorSetup";

export type MergeDiffViewProps = {
	/** 差异基准（只读侧：Git HEAD / 会话缓存原始内容） */
	original: string;
	/** 当前内容（可编辑侧） */
	modified: string;
	/** 文件扩展名，用于语法高亮 */
	language?: string;
	readOnly: boolean;
	/** true = 分栏（MergeView），false = 单栏（unifiedMergeView，只读基准以 widget 展示） */
	sideBySide: boolean;
	/** modified 侧内容变化回调（脏标记跟踪） */
	onChange: (value: string) => void;
};

/** 编辑侧共用扩展：行号/折叠/历史/补全/查找 + 脏标记监听 */
function editableExtensions(onChange: (value: string) => void) {
	return [
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
			if (update.docChanged) onChange(update.state.doc.toString());
		}),
	];
}

/**
 * Git Diff 视图（CodeMirror 6 实现，替代 Monaco DiffEditor）：
 * - 分栏：MergeView 双编辑器左右对齐，折叠未变区（collapseUnchanged）等价旧 hideUnchangedRegions；
 *   基准 a 永远只读，内容 b 在 readOnly=false 时可编辑（保存/脏标记链路不变）。
 * - 单栏：unifiedMergeView 把删除内容渲染为 widget 的只读 diff 展示，主文档仍可编辑。
 * 文档同步策略：外部 original/modified 变化时「与当前文档不同才替换」，
 * 避免覆盖用户正在输入的内容（与 CodeMirrorEditor 同一模式）。
 */
export function MergeDiffView(props: MergeDiffViewProps) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	const mergeRef = useRef<MergeView | null>(null);
	const viewRef = useRef<EditorView | null>(null);
	const onChangeRef = useRef(props.onChange);
	onChangeRef.current = props.onChange;
	// 单栏模式下已同步到 unified 视图的基准文档快照（供 original 变化时对比）
	const originalSyncedRef = useRef(props.original);
	originalSyncedRef.current = props.original;

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const language = resolveEditorLanguage(props.language);
		const base = baseEditorExtensions({ wordWrap: true, language });
		if (props.sideBySide) {
			// 分栏：a = 只读基准，b = 当前内容（可编辑）
			const view = new MergeView({
				a: {
					doc: props.original,
					extensions: [...base, EditorState.readOnly.of(true), EditorView.editable.of(false)],
				},
				b: {
					doc: props.modified,
					extensions: [
						...base,
						...(props.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
						...editableExtensions((value) => onChangeRef.current(value)),
					],
				},
				parent: host,
				gutter: true,
				highlightChanges: true,
				// 不传 revertControls = 不显示 revert 按钮（查看/编辑场景，非 merge 冲突解决）
				// 折叠未变区域：等价旧 Monaco hideUnchangedRegions { minimumLineCount: 3, contextLineCount: 3 }
				collapseUnchanged: { margin: 3, minSize: 4 },
			});
			mergeRef.current = view;
		} else {
			// 单栏：unifiedMergeView 以 extension 形式嵌入单个编辑器
			const view = new EditorView({
				parent: host,
				state: EditorState.create({
					doc: props.modified,
					extensions: [
						...base,
						...(props.readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
						...editableExtensions((value) => onChangeRef.current(value)),
						...unifiedMergeView({
							original: props.original,
							highlightChanges: true,
							gutter: true,
							// 不是 merge 冲突解决场景，去掉 accept/reject 按钮
							mergeControls: false,
							collapseUnchanged: { margin: 3, minSize: 4 },
							allowInlineDiffs: true,
						}),
					],
				}),
			});
			viewRef.current = view;
		}
		return () => {
			mergeRef.current?.destroy();
			viewRef.current?.destroy();
			mergeRef.current = null;
			viewRef.current = null;
		};
	// sideBySide 切换由父组件 key 强制重建，此处不依赖它
	// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [props.language, props.readOnly]);

	// 外部文档同步（分栏：a/b 各自比对；单栏：modified 直接替换，original 走 updateOriginalDoc effect）
	useEffect(() => {
		const merge = mergeRef.current;
		if (merge) {
			if (merge.a.state.doc.toString() !== props.original) {
				merge.a.dispatch({ changes: { from: 0, to: merge.a.state.doc.length, insert: props.original } });
			}
			if (merge.b.state.doc.toString() !== props.modified) {
				merge.b.dispatch({ changes: { from: 0, to: merge.b.state.doc.length, insert: props.modified } });
			}
			return;
		}
		const view = viewRef.current;
		if (!view) return;
		if (view.state.doc.toString() !== props.modified) {
			view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.modified } });
		}
		// unified 视图的基准文档独立于主文档，必须通过专用 effect 更新
		if (originalSyncedRef.current !== props.original) {
			view.dispatch({ effects: updateOriginalDoc.of({
				doc: Text.of(props.original.split("\n")),
				changes: ChangeSet.empty(view.state.doc.length),
			}) });
			originalSyncedRef.current = props.original;
		}
	}, [props.original, props.modified]);

	return <div ref={hostRef} className="codemirror-host merge-diff-host" />;
}
