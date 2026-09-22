import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Folder, Search, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { getFileIconSeti, getFileIconColor } from "../../fileIcons";
import { t } from "../../i18n";
import type { FileSearchResult } from "../../../../shared/types";
import { findFileNameMatchIndex } from "../../utils/fileSearchFilter";

/**
 * 文件名搜索结果列表（issue #215）：扁平列表，不进文件树，也不吃排序/折叠中间包开关。
 * 交互对齐文件树行：单击预览、双击常驻、右键走同一 onFileContextMenu——
 * 这样「在文件夹中显示/复制路径」等树里已有的能力搜索结果天然具备。
 * 查询词为空时仍要渲染搜索框（只把结果区换成引导文案）：早期实现在空词直接 return null，
 * 整块面板被替换成空白、连输入框都看不见（用户反馈的「输入也不行」）。
 */
export function FileSearchResults(props: {
	query: string;
	onQueryChange: (value: string) => void;
	results: FileSearchResult[] | null;
	isSearching: boolean;
	onViewFile?: (path: string, openMode?: "preview" | "permanent") => void;
	onFileContextMenu: (node: FileSearchResult, x: number, y: number) => void;
	onClear: () => void;
}) {
	const { query, results, isSearching } = props;
	const inputRef = useRef<HTMLInputElement>(null);

	// 打开搜索即聚焦输入框，并把光标放到词尾：类型首字符进搜索时查询词已播种，光标必须在词尾才能接着敲
	useEffect(() => {
		const input = inputRef.current;
		if (!input) return;
		input.focus();
		const end = input.value.length;
		input.setSelectionRange(end, end);
	}, []);
	useEffect(() => {
		if (query.length === 0) inputRef.current?.focus();
	}, [query.length]);

	const trimmed = query.trim();

	// 高亮区间在渲染时现算：主进程不回传命中片段，复用纯函数保证与主进程匹配语义一致
	const rows = useMemo(() => {
		if (!results) return [];
		return results.map((item) => ({
			item,
			index: findFileNameMatchIndex(item.name, trimmed),
		}));
	}, [results, trimmed]);

	return (
		<div className="file-search-results flex min-h-0 flex-1 flex-col overflow-hidden">
			<div className="flex h-8 shrink-0 items-center gap-1.5 border-b border-border/40 px-2">
				<Search size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
				<input
					ref={inputRef}
					value={query}
					onChange={(event) => props.onQueryChange(event.target.value)}
					onKeyDown={(event) => {
						// Esc 两段语义：先清词留在搜索态（输入框不失焦），词已空再退出搜索回到完整文件树
						if (event.key !== "Escape") return;
						event.stopPropagation();
						if (query.length > 0) props.onQueryChange("");
						else props.onClear();
					}}
					placeholder={t("drawer.fileSearchPlaceholder")}
					className="file-search-input h-full min-w-0 flex-1 border-0 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
					spellCheck={false}
				/>
				{isSearching && <span className="mini-loader animate-pideck-spin" aria-hidden="true" />}
				<Button type="button" variant="ghost" size="icon-sm" className="icon-only inline-grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-accent-foreground" onClick={props.onClear} title={t("common.close")} aria-label={t("common.close")}>
					<X size={13} />
				</Button>
			</div>
			<div className="file-search-list min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
				{trimmed.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-muted-foreground">{t("drawer.fileSearchEmptyHint")}</div>
				) : rows.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-muted-foreground">{isSearching ? t("drawer.fileSearchScanning") : t("drawer.fileSearchNoResults", { query: trimmed })}</div>
				) : (
					rows.map(({ item, index }) => <FileSearchRow key={item.path} item={item} matchIndex={index} matchLength={trimmed.length} onViewFile={props.onViewFile} onFileContextMenu={props.onFileContextMenu} />)
				)}
			</div>
		</div>
	);
}

function FileSearchRow(props: { item: FileSearchResult; matchIndex: number; matchLength: number; onViewFile?: (path: string, openMode?: "preview" | "permanent") => void; onFileContextMenu: (node: FileSearchResult, x: number, y: number) => void }) {
	const { item, matchIndex, matchLength } = props;
	// Seti 图标与文件树行同源，视觉上「搜索结果就是文件」而不是另一个列表
	let icon: ReactNode = null;
	if (item.type === "file") {
		try {
			const { svg, colorName } = getFileIconSeti(item.name);
			icon = <span aria-hidden="true" className="file-node-seti-icon" style={{ color: getFileIconColor(colorName) }} dangerouslySetInnerHTML={{ __html: svg }} />;
		} catch {
			icon = null;
		}
	}
	const before = matchIndex >= 0 ? item.name.slice(0, matchIndex) : item.name;
	const hit = matchIndex >= 0 ? item.name.slice(matchIndex, matchIndex + matchLength) : "";
	const after = matchIndex >= 0 ? item.name.slice(matchIndex + matchLength) : "";
	return (
		<button
			type="button"
			className={cn(
				"file-node-row inline-flex h-[28px] w-full items-center justify-start gap-1.5 rounded-sm border-0 bg-transparent px-2 py-0 text-left text-body font-normal text-foreground transition-[background-color] duration-200 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
			)}
			title={item.relativePath}
			onClick={() => props.onViewFile?.(item.path)}
			onDoubleClick={(event) => {
				event.preventDefault();
				props.onViewFile?.(item.path, "permanent");
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				props.onFileContextMenu(item, event.clientX, event.clientY);
			}}
		>
			<span className="file-node-icon">{item.type === "directory" ? <Folder size={18} aria-hidden="true" /> : icon}</span>
			<span className="file-node-name truncate">
				{before}
				{hit && <mark className="bg-transparent font-semibold text-foreground underline decoration-2 underline-offset-2">{hit}</mark>}
				{after}
			</span>
			<span className="file-node-type-label ml-auto shrink-0">{item.relativePath}</span>
		</button>
	);
}
