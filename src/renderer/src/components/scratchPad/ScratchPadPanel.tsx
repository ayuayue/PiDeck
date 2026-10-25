import { memo, useCallback, useRef } from "react";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkMath from "remark-math";
import { Download, Eye, FilePlus, MoreHorizontal, Pencil, Trash2, X } from "lucide-react";
import { remarkGfmNoSingleTilde } from "../../utils/markdownPlugins";
import { remarkInlineMathGuard } from "../../utils/markdownInlineMath";
import { MarkdownStream } from "../session/MarkdownStream";
import { continueListOnNewline, normalizeOrderedLists, prepareTaskListPreview } from "./scratchPadLists";
import type { Plugin } from "unified";
import type { Root, Element, Text } from "hast";
import type { DraftMeta } from "../../../../shared/types";
import { t } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui-shadcn/dropdown-menu";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui-shadcn/tabs";

type Mode = "edit" | "preview";

type ScratchPadPanelProps = {
	drafts: DraftMeta[];
	currentDraftPath: string | null;
	content: string;
	mode: Mode;
	isSaving: boolean;
	hasError: boolean;
	onChangeContent: (value: string) => void;
	onSetMode: (mode: Mode) => void;
	onToggleCheckbox: (lineIndex: number) => void;
	onExport: () => void;
	onSelectDraft: (draftPath: string) => void;
	onCreateDraft: () => void;
	onDeleteDraft: (draftPath: string) => void;
	/** 关闭右侧草稿本，仍支持 Escape / Ctrl/Cmd+Shift+S。 */
	onClose: () => void;
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

/*
 * 预览插件列表必须提为模块级常量：内联数组每次重渲染生成新引用，
 * MarkdownStream 的 memo（浅比较）随即失效 → 整篇重新解析（与 FileDiffViewer 同因，2027-02）。
 */
const SCRATCH_PAD_REMARK_PLUGINS = [remarkGfmNoSingleTilde, remarkInlineMathGuard, remarkMath, remarkBreaks];
const SCRATCH_PAD_REHYPE_PLUGINS = [rehypeKatex, rehypeHighlightMark];
const noopOpenExternal = (): void => undefined;

/** 适配右侧栏：草稿选择收进顶部下拉，让窄栏也能保留完整编辑宽度。 */
export const ScratchPadPanel = memo(function ScratchPadPanel(props: ScratchPadPanelProps) {
	const { drafts, currentDraftPath, content, mode, onChangeContent, onSetMode, onToggleCheckbox, onExport, onSelectDraft, onCreateDraft, onDeleteDraft, onClose } = props;

	const empty = !content.trim();
	const lines = content.split("\n");
	const editorRef = useRef<HTMLTextAreaElement>(null);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
			const ta = e.currentTarget;
			const res = continueListOnNewline(ta.value, ta.selectionStart);
			if (!res) return;
			e.preventDefault();
			onChangeContent(res.next);
			requestAnimationFrame(() => {
				ta.selectionStart = ta.selectionEnd = res.cursor;
			});
		},
		[onChangeContent],
	);

	const handleContentChange = useCallback(
		(event: React.ChangeEvent<HTMLTextAreaElement>) => {
			const textarea = event.currentTarget;
			const next = normalizeOrderedLists(textarea.value);
			onChangeContent(next);
			if (next === textarea.value) return;
			const cursor = Math.min(textarea.selectionStart, next.length);
			requestAnimationFrame(() => {
				textarea.selectionStart = textarea.selectionEnd = cursor;
			});
		},
		[onChangeContent],
	);

	/* 点击删除按钮（仅剩一份草稿时不删除，保留最后一份） */
	const handleDeleteDraft = useCallback(
		(draftPath: string) => {
			if (drafts.length <= 1) {
				return;
			}
			onDeleteDraft(draftPath);
		},
		[drafts.length, onDeleteDraft],
	);

	const canDeleteCurrent = Boolean(currentDraftPath) && drafts.length > 1;

	return (
		<Tabs
			value={mode}
			onValueChange={(value) => {
				if (value === "edit" || value === "preview") onSetMode(value);
			}}
			className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col gap-0 overflow-hidden bg-transparent"
			data-testid="scratch-pad-panel"
		>
			<header className="flex h-10 min-w-0 shrink-0 items-center gap-1 border-b border-border px-2">
				<div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium text-foreground">
					<Pencil size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
					<span className="truncate">{t("scratchPad.title")}</span>
				</div>
				{/* 图标分段为编辑器让出宽度，名称仍向键盘与辅助技术公开。 */}
				<TabsList className="w-auto shrink-0 p-0.5" aria-label={t("scratchPad.title")}>
					<TabsTrigger value="edit" className="size-7 p-0" title={t("scratchPad.edit")}>
						<Pencil size={12} aria-hidden="true" />
						<span className="sr-only">{t("scratchPad.edit")}</span>
					</TabsTrigger>
					<TabsTrigger value="preview" className="size-7 p-0" title={t("scratchPad.preview")}>
						<Eye size={12} aria-hidden="true" />
						<span className="sr-only">{t("scratchPad.preview")}</span>
					</TabsTrigger>
				</TabsList>
				{/* 低频操作（新建/导出/删除）收进 ⋯ 菜单；关闭保持独立入口 */}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button variant="ghost" size="icon-sm" className="size-7" title={t("tabs.moreActions")} aria-label={t("tabs.moreActions")}>
							<MoreHorizontal className="size-4" aria-hidden="true" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end" className="min-w-36">
						<DropdownMenuItem onClick={onCreateDraft}>
							<FilePlus size={14} aria-hidden="true" />
							{t("scratchPad.newDraft")}
						</DropdownMenuItem>
						<DropdownMenuItem onClick={onExport}>
							<Download size={14} aria-hidden="true" />
							{t("scratchPad.export")}
						</DropdownMenuItem>
						{canDeleteCurrent && (
							<>
								<DropdownMenuSeparator />
								<DropdownMenuItem
									className="text-destructive focus:text-destructive"
									onClick={() => {
										if (currentDraftPath) handleDeleteDraft(currentDraftPath);
									}}
								>
									<Trash2 size={14} aria-hidden="true" />
									{t("scratchPad.deleteDraft")}
								</DropdownMenuItem>
							</>
						)}
					</DropdownMenuContent>
				</DropdownMenu>
				{/* X 与工作区抽屉开关共用关闭入口。 */}
				<Button variant="ghost" size="icon-sm" className="size-7" title={t("common.close")} aria-label={t("common.close")} onClick={onClose}>
					<X className="size-4" aria-hidden="true" />
				</Button>
			</header>

			{drafts.length > 0 && (
				<div className="shrink-0 border-b border-border px-2 py-2">
					<Select value={currentDraftPath ?? undefined} onValueChange={onSelectDraft}>
						<SelectTrigger size="sm" className="w-full min-w-0 *:data-[slot=select-value]:min-w-0 *:data-[slot=select-value]:truncate" aria-label={t("scratchPad.showFileList")}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="start">
							<SelectGroup>
								{drafts.map((draft) => (
									<SelectItem key={draft.path} value={draft.path}>
										<span className="truncate" title={draft.name}>
											{draft.name}
										</span>
									</SelectItem>
								))}
							</SelectGroup>
						</SelectContent>
					</Select>
				</div>
			)}

			<TabsContent value="edit" className="mt-0 flex min-h-0 min-w-0 flex-1 overflow-hidden">
				<Textarea
					ref={editorRef}
					className="min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-3 font-mono text-sm leading-relaxed shadow-none [field-sizing:fixed] focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
					aria-label={t("scratchPad.edit")}
					value={content}
					placeholder={t("scratchPad.placeholder")}
					onChange={handleContentChange}
					onKeyDown={handleKeyDown}
					autoFocus
					spellCheck={false}
				/>
			</TabsContent>
			<TabsContent value="preview" className="mt-0 min-h-0 min-w-0 flex-1 overflow-y-auto p-3 text-foreground">
				{empty ? (
					<div className="grid h-full place-items-center text-sm text-muted-foreground">
						<em>{t("scratchPad.empty")}</em>
					</div>
				) : (
					<div className="scratch-pad-md">
						<MarkdownStream
							key={`scratch-pad-${content}`}
							text={prepareTaskListPreview(content)}
							onOpenExternal={noopOpenExternal}
							remarkPlugins={SCRATCH_PAD_REMARK_PLUGINS}
							rehypePlugins={SCRATCH_PAD_REHYPE_PLUGINS}
							components={{
								/* GFM task list：用 AST 节点行号直接定位源码行，避免 render-order 计数器漂移 */
								li: ({ node, className, children, ...liProps }) => {
									const classes = String(className ?? "");
									const lineIndex = typeof node?.position?.start?.line === "number" ? node.position.start.line - 1 : undefined;
									const isTaskItem = typeof lineIndex === "number" && /^\s*(?:[-*+]|\d+[.)])\s+\[[ xX]\]/.test(lines[lineIndex] ?? "");
									if (!isTaskItem) {
										return (
											<li {...liProps} className={classes}>
												{children}
											</li>
										);
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
								input: ({ className, size: _nativeSize, ...inputProps }) => {
									if (inputProps.type === "checkbox") {
										/* 任务项 checkbox 不能用共享 Input：h-9 w-full 会把方框
													   撑成整行，文字被挤到下一行 */
										return <input {...inputProps} className={className ? `scratch-pad-checkbox ${className}` : "scratch-pad-checkbox"} disabled={false} readOnly tabIndex={-1} />;
									}
									return <Input {...inputProps} className={className} />;
								},
							}}
						/>
					</div>
				)}
			</TabsContent>
		</Tabs>
	);
});
