import { memo, useCallback, useRef, useState, type ReactNode } from "react";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import { defaultRemarkPlugins } from "streamdown";
import { Download, Eye, FilePlus, PanelRightOpen, Pencil, Trash2 } from "lucide-react";
import { MarkdownStream } from "../session/MarkdownStream";
import { continueListOnNewline, normalizeOrderedLists, prepareTaskListPreview } from "./scratchPadLists";
import type { Plugin } from "unified";
import type { Root, Element, Text } from "hast";
import type { DraftMeta } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";

type Mode = "edit" | "preview";

function ToolButton({ icon, label, text, active, onClick }: {
	icon?: ReactNode;
	label: string;
	text?: string;
	active?: boolean;
	onClick: () => void;
}) {
	return (
		<Button variant="ghost" size="icon" aria-label={label} title={label} onClick={onClick} className={active ? "scratch-pad-tool-btn active" : "scratch-pad-tool-btn"}>
			{icon}
			{text && <span className="scratch-pad-tool-text">{text}</span>}
		</Button>
	);
}

type ScratchPadPanelProps = {
	drafts: DraftMeta[];
	currentDraftPath: string | null;
	content: string;
	mode: Mode;
	isClosing?: boolean;
	isSaving: boolean;
	hasError: boolean;
	onChangeContent: (value: string) => void;
	onSetMode: (mode: Mode) => void;
	onToggleCheckbox: (lineIndex: number) => void;
	onExport: () => void;
	onSelectDraft: (draftPath: string) => void;
	onCreateDraft: () => void;
	onDeleteDraft: (draftPath: string) => void;
};

/*
 * 自写 rehype 插件：把文本节点里的 ==text== 模式转成 <mark>text</mark>。
 * 这是 unified v11 / remark v14+ 环境下的稳定方案。
 */
const rehypeHighlightMark: Plugin<[], Root> = () => {
	return (tree) => {
		const walker = (nodes: Root["children"]) => {
			for (let i = 0; i < nodes.length; i++) {
				const node = nodes[i];
				if (node.type === "element" && node.children) {
					walker(node.children as (Text | Element)[]);
				}
				if (node.type === "text") {
					const textNode = node as Text;
					const { value } = textNode;
					const regex = /==([^=\n]+)==/g;
					const children: (Text | Element)[] = [];
					let match: RegExpExecArray | null;
					let lastIndex = 0;

					while ((match = regex.exec(value)) !== null) {
						if (match.index > lastIndex) {
							children.push({ type: "text", value: value.slice(lastIndex, match.index) });
						}
						children.push({
							type: "element",
							tagName: "mark",
							properties: {},
							children: [{ type: "text", value: match[1] }],
						});
						lastIndex = regex.lastIndex;
					}

					if (children.length === 0) continue;
					if (lastIndex < value.length) {
						children.push({ type: "text", value: value.slice(lastIndex) });
					}
					nodes.splice(i, 1, ...children);
					i += children.length - 1;
				}
			}
		};
		walker(tree.children);
	};
};

/* 草稿列表项组件 */
const DraftItem = memo(function DraftItem({
	draft,
	isActive,
	onSelect,
	onDelete,
}: {
	draft: DraftMeta;
	isActive: boolean;
	onSelect: () => void;
	onDelete: () => void;
}) {
	return (
		<div
			className={`scratch-pad-draft-item${isActive ? " active" : ""}`}
			onClick={onSelect}
			role="button"
			tabIndex={0}
			onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
		>
			<span className="scratch-pad-draft-name" title={draft.name}>{draft.name}</span>
			<button
				className="scratch-pad-draft-del-btn"
				title={t("scratchPad.deleteDraft")}
				onClick={(e) => { e.stopPropagation(); onDelete(); }}
				aria-label={t("scratchPad.deleteDraft")}
			>
				<Trash2 size={12} />
			</button>
		</div>
	);
});

export const ScratchPadPanel = memo(function ScratchPadPanel(props: ScratchPadPanelProps) {
	const {
		drafts,
		currentDraftPath,
		content,
		mode,
		isClosing,
		onChangeContent,
		onSetMode,
		onToggleCheckbox,
		onExport,
		onSelectDraft,
		onCreateDraft,
		onDeleteDraft,
	} = props;

	const empty = !content.trim();
	const lines = content.split("\n");
	const editorRef = useRef<HTMLTextAreaElement>(null);

	// 文件列表默认折叠，用户需要时手动展开
	const [showFileList, setShowFileList] = useState(false);

	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
		const ta = e.currentTarget;
		const res = continueListOnNewline(ta.value, ta.selectionStart);
		if (!res) return;
		e.preventDefault();
		onChangeContent(res.next);
		requestAnimationFrame(() => {
			ta.selectionStart = ta.selectionEnd = res.cursor;
		});
	}, [onChangeContent]);

	const handleContentChange = useCallback((event: React.ChangeEvent<HTMLTextAreaElement>) => {
		const textarea = event.currentTarget;
		const next = normalizeOrderedLists(textarea.value);
		onChangeContent(next);
		if (next === textarea.value) return;
		const cursor = Math.min(textarea.selectionStart, next.length);
		requestAnimationFrame(() => {
			textarea.selectionStart = textarea.selectionEnd = cursor;
		});
	}, [onChangeContent]);

	/* 点击草稿列表中的删除按钮 */
	const handleDeleteDraft = useCallback((draftPath: string) => {
		if (drafts.length <= 1) {
			// 只剩一个时不删除，保留最后一份草稿
			return;
		}
		onDeleteDraft(draftPath);
	}, [drafts.length, onDeleteDraft]);

	return (
		<div
			className={"scratch-pad-panel" + (isClosing ? " closing" : "")}
			onClick={(event) => event.stopPropagation()}
		>
			<header className="scratch-pad-header">
				<div className="scratch-pad-title">
					<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M12 20h9" />
						<path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
					</svg>
					<span>{t("scratchPad.title")}</span>
					<kbd className="scratch-pad-kbd">⌘⇧S</kbd>
				</div>
				<div className="scratch-pad-toolbar">
					<ToolButton
						icon={<FilePlus size={15} />}
						label={t("scratchPad.newDraft")}
						onClick={onCreateDraft}
					/>
					{currentDraftPath && drafts.length > 1 && (
						<ToolButton
							icon={<Trash2 size={15} />}
							label={t("scratchPad.deleteDraft")}
							onClick={() => handleDeleteDraft(currentDraftPath)}
						/>
					)}
					<ToolButton
						icon={<Pencil size={15} />}
						label={t("scratchPad.edit")}
						active={mode === "edit"}
						onClick={() => onSetMode("edit")}
					/>
					<ToolButton
						icon={<Eye size={15} />}
						label={t("scratchPad.preview")}
						active={mode === "preview"}
						onClick={() => onSetMode("preview")}
					/>
					<ToolButton
						icon={<Download size={15} />}
						label={t("scratchPad.export")}
						onClick={onExport}
					/>
					{drafts.length > 0 && (
						<ToolButton
							icon={<PanelRightOpen size={15} />}
							label={showFileList ? t("scratchPad.hideFileList") : t("scratchPad.showFileList")}
							active={showFileList}
							onClick={() => setShowFileList(v => !v)}
						/>
					)}
				</div>
			</header>

			<div className="scratch-pad-body">
				{/* 编辑/预览区域 — 左 */}
				<div className="scratch-pad-content">
					{mode === "edit" ? (
						<Textarea
							ref={editorRef}
							className="scratch-pad-editor rounded-none border-0 shadow-none dark:bg-transparent focus-visible:border-transparent focus-visible:ring-0"
							value={content}
							placeholder={t("scratchPad.placeholder")}
							onChange={handleContentChange}
							onKeyDown={handleKeyDown}
							autoFocus
							spellCheck={false}
						/>
					) : (
						<div className="scratch-pad-preview">
							{empty ? (
								<div className="scratch-pad-empty-hint">
									<em>{t("scratchPad.empty")}</em>
								</div>
							) : (
								<div className="scratch-pad-md">
									<MarkdownStream
										key={`scratch-pad-${content}`}
										text={prepareTaskListPreview(content)}
										onOpenExternal={() => undefined}
										remarkPlugins={[defaultRemarkPlugins.gfm, remarkMath, remarkBreaks]}
										rehypePlugins={[rehypeKatex, rehypeHighlightMark]}
										components={{
											/* GFM task list：用 AST 节点行号直接定位源码行，避免 render-order 计数器漂移 */
											li: ({ node, className, children, ...liProps }) => {
												const classes = String(className ?? "");
												const lineIndex = typeof node?.position?.start?.line === "number" ? node.position.start.line - 1 : undefined;
												const isTaskItem = typeof lineIndex === "number" && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(lines[lineIndex] ?? "");
												if (!isTaskItem) {
													return <li {...liProps} className={classes}>{children}</li>;
												}
												return (
													<li
														{...liProps}
														className={classes}
														/* 勾选只响应方框本身：只有点击 checkbox 才切换，点文字不触发 */
														onClick={(event) => {
															const target = event.target as HTMLElement;
															if (!target.closest('input[type="checkbox"]')) return;
															onToggleCheckbox(lineIndex);
														}}
													>
														{children}
													</li>
												);
											},
											input: ({ className, ...inputProps }) => {
												if (inputProps.type === "checkbox") {
													/* 任务项 checkbox 不能用共享 Input：h-9 w-full 会把方框
													   撑成整行，文字被挤到下一行 */
													return (
														<input
															{...inputProps}
															className={className ? `scratch-pad-checkbox ${className}` : "scratch-pad-checkbox"}
															disabled={false}
															readOnly
															tabIndex={-1}
														/>
													);
												}
												return <Input {...inputProps} className={className} />;
											},
										}}
									/>
								</div>
							)}
						</div>
					)}
				</div>

				{showFileList && drafts.length > 0 && (
					<div className="scratch-pad-draft-list">
						<div className="scratch-pad-draft-list-scroll">
							{drafts.map((d) => (
								<DraftItem
									key={d.path}
									draft={d}
									isActive={d.path === currentDraftPath}
									onSelect={() => onSelectDraft(d.path)}
									onDelete={() => handleDeleteDraft(d.path)}
								/>
							))}
						</div>
					</div>
				)}
			</div>

		</div>
	);
});
