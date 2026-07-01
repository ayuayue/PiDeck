import { memo, useCallback, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { Eye, Pencil } from "lucide-react";
import type { Plugin } from "unified";
import type { Root, Element, Text } from "hast";
import { t } from "../../i18n";
import { IconButton } from "../ui/IconButton";

type Mode = "edit" | "preview";

function ToolButton({ icon, label, text, active, onClick }: {
	icon?: ReactNode;
	label: string;
	text?: string;
	active?: boolean;
	onClick: () => void;
}) {
	return (
		<IconButton label={label} onClick={onClick} className={active ? "scratch-pad-tool-btn active" : "scratch-pad-tool-btn"}>
			{icon}
			{text && <span className="scratch-pad-tool-text">{text}</span>}
		</IconButton>
	);
}

type ScratchPadPanelProps = {
	content: string;
	mode: Mode;
	isClosing?: boolean;
	isSaving: boolean;
	hasError: boolean;
	onChangeContent: (value: string) => void;
	onSetMode: (mode: Mode) => void;
	onToggleCheckbox: (lineIndex: number) => void;
	onExport: () => void;
};

/* 列表回车续号：覆盖 GFM task list + 普通列表 + 有序列表 */
function handleListNewline(value: string, selectionStart: number): { next: string; cursor: number } | null {
	const before = value.slice(0, selectionStart);
	const after = value.slice(selectionStart);
	const lines = before.split("\n");
	const currentLine = lines[lines.length - 1];

	/* GFM task list: - [ ] / - [x] / - [X] */
	const taskMatch = currentLine.match(/^(\s*-\s+\[[ xX]\]\s+)(.*)$/);
	if (taskMatch) {
		const [, prefix, content] = taskMatch;
		if (content.trim() === "") {
			const removed = before.slice(0, before.length - currentLine.length);
			const next = (removed.endsWith("\n") ? removed.slice(0, -1) : removed) + "\n" + after;
			return { next, cursor: next.length - after.length };
		}
		return {
			next: before + "\n" + prefix + after,
			cursor: before.length + 1 + prefix.length,
		};
	}

	/* 普通无序列表: -, *, + */
	const ul = currentLine.match(/^(\s*)([-*+]) (.*)$/);
	if (ul) {
		const [, indent, marker, content] = ul;
		if (content.trim() === "") {
			const removed = before.slice(0, before.length - currentLine.length);
			const next = (removed.endsWith("\n") ? removed.slice(0, -1) : removed) + "\n" + after;
			return { next, cursor: next.length - after.length };
		}
		return {
			next: before + "\n" + indent + marker + " " + after,
			cursor: before.length + 1 + indent.length + marker.length + 1,
		};
	}

	/* 有序列表: 1. */
	const ol = currentLine.match(/^(\s*)(\d+)\. (.*)$/);
	if (ol) {
		const [, indent, num, content] = ol;
		if (content.trim() === "") {
			const removed = before.slice(0, before.length - currentLine.length);
			const next = (removed.endsWith("\n") ? removed.slice(0, -1) : removed) + "\n" + after;
			return { next, cursor: next.length - after.length };
		}
		const nextNum = Number(num) + 1;
		const insert = `${indent}${nextNum}. `;
		return {
			next: before + "\n" + insert + after,
			cursor: before.length + 1 + insert.length,
		};
	}

	return null;
}

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


export const ScratchPadPanel = memo(function ScratchPadPanel(props: ScratchPadPanelProps) {
	const {
		content,
		mode,
		isClosing,
		isSaving,
		hasError,
		onChangeContent,
		onSetMode,
		onToggleCheckbox,
		onExport,
	} = props;

	const empty = !content.trim();
	const lines = content.split("\n");

	const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
		const ta = e.currentTarget;
		const res = handleListNewline(ta.value, ta.selectionStart);
		if (!res) return;
		e.preventDefault();
		onChangeContent(res.next);
		requestAnimationFrame(() => {
			ta.selectionStart = ta.selectionEnd = res.cursor;
		});
	}, [onChangeContent]);

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
						icon={<Pencil size={15} />}
						label={t("scratchPad.edit")}
						text={t("scratchPad.edit")}
						active={mode === "edit"}
						onClick={() => onSetMode("edit")}
					/>
					<ToolButton
						icon={<Eye size={15} />}
						label={t("scratchPad.preview")}
						text={t("scratchPad.preview")}
						active={mode === "preview"}
						onClick={() => onSetMode("preview")}
					/>
					<ToolButton
						label={t("scratchPad.export")}
						text={t("scratchPad.export")}
						onClick={onExport}
					/>
				</div>
			</header>

			<div className="scratch-pad-content">
				{mode === "edit" ? (
					<textarea
						className="scratch-pad-editor"
						value={content}
						placeholder={t("scratchPad.placeholder")}
						onChange={(e) => onChangeContent(e.target.value)}
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
								<ReactMarkdown
									remarkPlugins={[remarkGfm, remarkMath, remarkBreaks]}
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
													role="button"
													tabIndex={0}
													onClick={(event) => {
														const target = event.target as HTMLElement;
														if (target.closest("a,button")) return;
														onToggleCheckbox(lineIndex);
													}}
													onKeyDown={(event) => {
														if (event.key !== "Enter" && event.key !== " ") return;
														event.preventDefault();
														onToggleCheckbox(lineIndex);
													}}
												>
													{children}
												</li>
											);
										},
										input: ({ ...inputProps }) => (
											<input
												{...inputProps}
												disabled={inputProps.type === "checkbox" ? false : inputProps.disabled}
												readOnly={inputProps.type === "checkbox" ? true : inputProps.readOnly}
												tabIndex={inputProps.type === "checkbox" ? -1 : inputProps.tabIndex}
											/>
										),
									}}
								>
									{content}
								</ReactMarkdown>
							</div>
						)}
					</div>
				)}
			</div>

			<div className={`scratch-pad-status${hasError ? " error" : ""}`}>
				<span className="scratch-pad-status-text">
					{hasError
						? t("scratchPad.saveError")
						: isSaving
							? t("scratchPad.saving")
							: content
								? t("scratchPad.saved")
								: ""}
				</span>
			</div>
		</div>
	);
});
