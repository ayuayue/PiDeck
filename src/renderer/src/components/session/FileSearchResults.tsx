import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ChevronRight, FileText, Folder, FolderOpen, Search, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Button } from "../ui-shadcn/button";
import { getFileIconSeti, getFileIconColor } from "../../fileIcons";
import { t } from "../../i18n";
import type { FileContentSearchHit, FileContentSearchResult, FileSearchResult, ProjectFileTarget } from "../../../../shared/types";
import { findFileNameMatchIndex } from "../../utils/fileSearchFilter";
import { shouldShowFileNameOnlyHint } from "../../utils/fileSearchCapability";
import { buildFileSearchTree, countSearchTreeFiles, type FileSearchTreeDir, type FileSearchTreeEntry } from "../../utils/fileSearchTree";
import { FILE_ROW_BUTTON_CLASS } from "./FileTreeRows";

/**
 * 文件名搜索结果（issue #215）：按命中路径的前缀目录归并成树（不再平铺），
 * 也不吃文件树的排序/折叠中间包开关——那些是浏览态的偏好，不该改变搜索结果的次序。
 * 交互对齐文件树行：目录行点一下折叠，文件行单击预览、双击常驻、右键走同一
 * onFileContextMenu——这样「在文件夹中显示/复制路径」等树里已有的能力搜索结果天然具备。
 * 查询词为空时仍要渲染搜索框（只把结果区换成引导文案）：早期实现在空词直接 return null，
 * 整块面板被替换成空白、连输入框都看不见（用户反馈的「输入也不行」）。
 */
export function FileSearchResults(props: {
	query: string;
	onQueryChange: (value: string) => void;
	results: FileSearchResult[] | null;
	isSearching: boolean;
	/** 正文命中（Go sidecar）；null = 未就绪/失败/词太短，此时不渲染正文分区 */
	contentResults: FileContentSearchResult | null;
	isContentSearching: boolean;
	/**
	 * 该位置是否支持内容检索（缺省 true 保持本机行为）。远端/WSL 为 false：
	 * 不渲染正文分区与正文 spinner，改在查询非空时显示「仅文件名搜索」提示。
	 */
	contentSearchSupported?: boolean;
	onViewFile?: (path: string | ProjectFileTarget, openMode?: "preview" | "permanent") => void;
	onFileContextMenu: (node: FileSearchResult, x: number, y: number) => void;
	onClear: () => void;
}) {
	const { query, results, isSearching } = props;
	const contentSearchSupported = props.contentSearchSupported ?? true;
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

	// 扁平命中 → 树：命中路径的前缀目录由 buildFileSearchTree 补出来，否则一长串
	// 「src/components/session/xxx.tsx」平铺在同一列，看不出命中集中在哪个目录。
	const tree = useMemo(() => (results ? buildFileSearchTree(results) : []), [results]);
	// 默认全展开（搜索结果本来就少）；只记录被收起的目录，换查询词时保持用户的折叠选择
	const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(() => new Set());
	const toggleDir = (key: string) =>
		setCollapsedDirs((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

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
			{/* scroll-ok: nested —— 这个滚动窗里是**两段异质列表**：文件名字结果 + 正文命中分区
			     （FileContentSection 自带 header 与自己的 hits 数组）。要虚拟化必须先把两段摊平成
			     一个行序列，否则虚拟器算的高度只是其中一段、与容器 scrollHeight 不一致，滚动位置会错。 */}
			<div className="file-search-list min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
				{trimmed.length === 0 ? (
					<div className="px-3 py-6 text-center text-xs text-muted-foreground">{t("drawer.fileSearchEmptyHint")}</div>
				) : (
					<>
						{tree.length === 0 ? (
							<div className="px-3 py-6 text-center text-xs text-muted-foreground">{isSearching ? t("drawer.fileSearchScanning") : t("drawer.fileSearchNoResults", { query: trimmed })}</div>
						) : (
							tree.map((entry) => <SearchTreeRow key={entry.key} entry={entry} depth={0} query={trimmed} collapsedDirs={collapsedDirs} onToggleDir={toggleDir} onViewFile={props.onViewFile} onFileContextMenu={props.onFileContextMenu} />)
						)}
						{contentSearchSupported ? <FileContentSection query={trimmed} result={props.contentResults} isSearching={props.isContentSearching} onViewFile={props.onViewFile} onFileContextMenu={props.onFileContextMenu} /> : null}
						{shouldShowFileNameOnlyHint({ contentSearchSupported, query: trimmed }) ? (
							<p data-testid="file-search-name-only-hint" className="px-3 py-3 text-center text-xs text-muted-foreground">
								{t("drawer.fileSearchNameOnlyHint")}
							</p>
						) : null}
					</>
				)}
			</div>
		</div>
	);
}

/**
 * 正文命中分区：名字结果之下另起一段，不与名字结果抢位置（名字毫秒级先出）。
 * 没有命中且不在扫描中时整段不渲染——避免空白标题占地方。
 * 行内 snippet 已由 Go 侧截好（含省略号），这里只做截断与等宽路径显示。
 */
/**
 * 正文命中分区：本机文件抽屉与远端项目面板共用同一段 UI。
 * 行内 snippet 已由主进程截好（含边界），这里只做截断与等宽路径显示。
 */
export function FileContentSection(props: { query: string; result: FileContentSearchResult | null; isSearching: boolean; onViewFile?: (path: string, openMode?: "preview" | "permanent") => void; onFileContextMenu: (node: FileSearchResult, x: number, y: number) => void }) {
	const hits = props.result?.hits ?? [];
	if (hits.length === 0 && !props.isSearching) return null;
	return (
		<div className="file-search-content mt-1 border-t border-border/40 pt-1">
			<div className="flex items-center gap-1.5 px-2 py-1 text-micro text-muted-foreground">
				<FileText size={12} className="shrink-0" aria-hidden="true" />
				<span className="uppercase tracking-wide">{t("drawer.fileSearchContentSection")}</span>
				{props.isSearching && <span className="mini-loader animate-pideck-spin" aria-hidden="true" />}
				{props.result?.truncated && <span className="ml-auto shrink-0">{t("drawer.fileSearchContentTruncated")}</span>}
			</div>
			{hits.length === 0 ? <div className="px-3 py-3 text-center text-xs text-muted-foreground">{t("drawer.fileSearchContentScanning")}</div> : null}
			{hits.map((hit) => (
				<FileContentRow key={`${hit.path}:${hit.line}`} hit={hit} onViewFile={props.onViewFile} onFileContextMenu={props.onFileContextMenu} />
			))}
		</div>
	);
}

function FileContentRow(props: { hit: FileContentSearchHit; onViewFile?: (path: string, openMode?: "preview" | "permanent") => void; onFileContextMenu: (node: FileSearchResult, x: number, y: number) => void }) {
	const { hit } = props;
	// 右键菜单按文件树节点形状复用：路径类操作只关心 path/name，行号由 title 补充
	const node: FileSearchResult = { name: hit.name, path: hit.path, relativePath: hit.relativePath, type: "file" };
	return (
		<button
			type="button"
			className="file-node-row flex w-full flex-col items-start gap-0.5 rounded-sm border-0 bg-transparent px-2 py-1 text-left text-body font-normal text-foreground transition-[background-color] duration-base hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
			title={`${hit.relativePath}:${hit.line}`}
			onClick={() => props.onViewFile?.(hit.path)}
			onDoubleClick={(event) => {
				event.preventDefault();
				props.onViewFile?.(hit.path, "permanent");
			}}
			onContextMenu={(event) => {
				event.preventDefault();
				props.onFileContextMenu(node, event.clientX, event.clientY);
			}}
		>
			<span className="flex w-full shrink-0 items-center gap-1.5">
				<FileText size={13} className="shrink-0 text-muted-foreground" aria-hidden="true" />
				<span className="truncate text-xs">{hit.relativePath}</span>
				<span className="ml-auto shrink-0 text-micro tabular-nums text-muted-foreground">{hit.line}</span>
			</span>
			<span className="w-full shrink-0 truncate pl-[19px] text-micro text-muted-foreground">{hit.snippet}</span>
		</button>
	);
}

/** 树行内边距与文件树同源：depth × 8px，外层缩进只影响行盒内容，背景仍铺满整行。 */
function treeRowStyle(depth: number): CSSProperties {
	return { paddingLeft: `calc(var(--space-2) + ${depth * 8}px)`, paddingRight: "var(--space-2)" };
}

/** 名称高亮：主进程不回传命中片段，复用纯函数保证与主进程匹配语义一致。 */
function MatchedName(props: { name: string; query: string }) {
	const index = findFileNameMatchIndex(props.name, props.query);
	if (index < 0) return <>{props.name}</>;
	return (
		<>
			{props.name.slice(0, index)}
			<mark className="bg-transparent font-semibold text-foreground underline decoration-2 underline-offset-2">{props.name.slice(index, index + props.query.length)}</mark>
			{props.name.slice(index + props.query.length)}
		</>
	);
}

type SearchTreeRowProps = {
	entry: FileSearchTreeEntry;
	depth: number;
	query: string;
	collapsedDirs: ReadonlySet<string>;
	onToggleDir: (key: string) => void;
	onViewFile?: (path: string | ProjectFileTarget, openMode?: "preview" | "permanent") => void;
	onFileContextMenu: (node: FileSearchResult, x: number, y: number) => void;
};

/**
 * 搜索结果树的一行：目录行可折叠，文件行与文件树行同一套点击语义
 * （单击预览、双击常驻、右键走 onFileContextMenu）。
 */
function SearchTreeRow(props: SearchTreeRowProps) {
	if (props.entry.type === "file") return <FileSearchRow {...props} item={props.entry.item} />;
	return <SearchDirectoryRow {...props} entry={props.entry} />;
}

function SearchDirectoryRow(props: SearchTreeRowProps & { entry: FileSearchTreeDir }) {
	const { entry, depth } = props;
	const hasChildren = entry.children.length > 0;
	const expanded = hasChildren && !props.collapsedDirs.has(entry.key);
	// 折叠态才显示命中数：展开时数得出来，摆着只是噪声
	const hiddenCount = expanded ? 0 : countSearchTreeFiles(entry.children);
	return (
		<div className="file-node">
			<button
				type="button"
				className={cn("directory", FILE_ROW_BUTTON_CLASS, "rounded-none")}
				style={treeRowStyle(depth)}
				title={entry.item ? (entry.item.displayPath ?? entry.item.relativePath) : entry.key}
				aria-expanded={hasChildren ? expanded : undefined}
				onClick={() => {
					if (hasChildren) props.onToggleDir(entry.key);
				}}
				onContextMenu={(event) => {
					// 纯前缀目录不在搜索结果里，没有可操作的路径目标，保留浏览器默认菜单
					if (!entry.item) return;
					event.preventDefault();
					props.onFileContextMenu(entry.item, event.clientX, event.clientY);
				}}
			>
				<span aria-hidden="true" className="inline-flex h-full w-4 shrink-0 translate-x-[3px] items-center justify-center">
					{hasChildren && <ChevronRight className={cn("file-node-chevron size-3.5 shrink-0 transition-transform", expanded ? "rotate-90" : "rotate-0")} aria-hidden="true" />}
				</span>
				<span className="file-node-icon">{expanded ? <FolderOpen size={18} aria-hidden="true" /> : <Folder size={18} aria-hidden="true" />}</span>
				<span className="file-node-name truncate">
					<MatchedName name={entry.name} query={props.query} />
				</span>
				{hiddenCount > 0 && <span className="ml-auto shrink-0 text-micro tabular-nums text-muted-foreground">{hiddenCount}</span>}
			</button>
			{expanded && (
				<div className="file-children">
					{entry.children.map((child) => (
						<SearchTreeRow key={child.key} {...props} entry={child} depth={depth + 1} />
					))}
				</div>
			)}
		</div>
	);
}

function FileSearchRow(props: SearchTreeRowProps & { item: FileSearchResult }) {
	const { item } = props;
	const fileActionTarget = item.target ?? item.path;
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
	return (
		<div className="file-node">
			<button
				type="button"
				className={cn("file", FILE_ROW_BUTTON_CLASS)}
				style={treeRowStyle(props.depth)}
				title={item.displayPath ?? item.relativePath}
				onClick={() => fileActionTarget && props.onViewFile?.(fileActionTarget)}
				onDoubleClick={(event) => {
					event.preventDefault();
					if (fileActionTarget) props.onViewFile?.(fileActionTarget, "permanent");
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					props.onFileContextMenu(item, event.clientX, event.clientY);
				}}
			>
				{/* 文件也保留 16px twistie 槽位，确保与同级目录的图标和名称对齐 */}
				<span aria-hidden="true" className="h-full w-4 shrink-0" />
				<span className="file-node-icon">{item.type === "directory" ? <Folder size={18} aria-hidden="true" /> : icon}</span>
				<span className="file-node-name truncate">
					<MatchedName name={item.name} query={props.query} />
				</span>
			</button>
		</div>
	);
}
