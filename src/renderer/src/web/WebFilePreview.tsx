/**
 * WebFilePreview — Web 端文件/改动全屏预览（第三批）。
 *
 * 两个入口：
 * - 消息里的文件路径链接（MarkdownStream onOpenFile）→ 文件预览：md 走 MarkdownStream、
 *   其余文本带行号渲染并滚动定位到引用行；二进制/超大/项目外与后端结构化标记对齐。
 * - 会话文件修改 strip 的 chip → Git diff 预览：两栏（原始/修改后）对比 untracked 整文件。
 *
 * 路径安全：后端 /api/file-content 已有项目根沙箱（越界 403、缺失 404），这里只负责把
 * 消息里可能出现的绝对路径裁成项目相对路径；裁不进项目根的（项目外/盘符不符）直接给
 * 「项目外不可读」提示，不发请求。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { t } from "@/i18n";
import { fetchFileContent, fetchGitDiff, fetchGitStatus } from "./webApi";
import { useDismissOnBack } from "./useDismissOnBack";

export type WebFilePreviewTarget = { kind: "file"; projectId: string; projectRoot: string; path: string; line?: number } | { kind: "diff"; projectId: string; projectRoot: string; path: string };

type FileState = { content?: string; tooLarge?: boolean; truncated?: boolean; binary?: boolean };
type DiffState = { originalContent: string; modifiedContent: string } | null;

/** 把链接里的原始路径裁成项目相对路径；绝对路径按盘符大小写不敏感前缀匹配，裁不进返回 null。 */
export function toProjectRelative(rawPath: string, projectRoot: string): string | null {
	if (!rawPath) return null;
	const normalized = rawPath.replace(/\\/g, "/");
	const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!root) return null;
	// 相对路径：原样交给后端（其沙箱会做 `..`/越界拒绝）
	if (!/^[a-zA-Z]:\//.test(normalized) && !normalized.startsWith("/")) {
		return normalized.replace(/^\.\//, "");
	}
	const lowerPath = normalized.toLowerCase();
	const lowerRoot = root.toLowerCase();
	if (lowerPath === lowerRoot) return "";
	if (lowerPath.startsWith(`${lowerRoot}/`)) return normalized.slice(root.length + 1);
	return null;
}

function basename(path: string): string {
	const parts = path.split(/[\\/]/);
	return parts[parts.length - 1] || path;
}

/** 头部：文件名 + 完整相对路径 + 关闭按钮（移动端全屏覆盖层的唯一出口，触达区放大）。 */
function PreviewHeader({ path, onClose }: { path: string; onClose: () => void }) {
	return (
		<header className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2">
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium text-foreground">{basename(path)}</div>
				<div className="truncate text-micro text-muted-foreground">{path}</div>
			</div>
			<button type="button" aria-label={t("web.previewClose")} className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/60 active:bg-muted/80 hover:text-foreground" onClick={onClose}>
				<X className="size-5" aria-hidden="true" />
			</button>
		</header>
	);
}

/** 行号 + 内容的纯文本渲染；引用行高亮并滚动定位（MarkdownStream 渲染的 md 不做行定位）。 */
function NumberedText({ content, line }: { content: string; line?: number }) {
	const lines = useMemo(() => content.split("\n"), [content]);
	const targetRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		// 行号在异步加载后才能定位：等目标行挂载后再滚一次（等宽字体下无需等布局完成）
		targetRef.current?.scrollIntoView({ block: "center" });
	}, [line]);
	return (
		<div className="min-h-0 flex-1 overflow-auto p-2">
			{lines.map((text, index) => {
				const lineNumber = index + 1;
				const highlighted = line === lineNumber;
				return (
					// data-line 供定位与未来扩展（跳转/复制单行）；行内容原样展示不转义 HTML（React 默认安全）
					<div key={lineNumber} data-line={lineNumber} ref={highlighted ? targetRef : undefined} className={`flex gap-2 whitespace-pre-wrap px-1 text-micro leading-relaxed ${highlighted ? "rounded bg-primary/15 text-foreground" : "text-foreground/90"}`}>
						<span className="w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/70">{lineNumber}</span>
						<span className="min-w-0 flex-1 break-all">{text || " "}</span>
					</div>
				);
			})}
		</div>
	);
}

/** 文件模式：md → MarkdownStream（外链新标签页），其余 → 行号文本。 */
function FilePreviewBody({ projectId, path, line }: { projectId: string; path: string; line?: number }) {
	const [state, setState] = useState<FileState | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		let alive = true;
		setState(null);
		setFailed(false);
		fetchFileContent(projectId, path)
			.then((result) => alive && setState(result))
			.catch(() => alive && setFailed(true));
		return () => {
			alive = false;
		};
	}, [projectId, path]);
	if (failed) return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-muted-foreground">{t("web.previewLoadFailed")}</div>;
	if (!state) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Loader2 className="size-5 animate-pideck-spin text-muted-foreground" aria-hidden="true" />
			</div>
		);
	}
	if (state.tooLarge) return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-warning">{t("web.fileViewerTooLarge")}</div>;
	if (state.binary) return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-muted-foreground">{t("web.fileViewerBinary")}</div>;
	if (state.content == null) return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-muted-foreground">{t("web.previewLoadFailed")}</div>;
	// 截断预览：能看前 512KB 比完全不给强；底部提示告知完整内容请回桌面端
	const truncatedNotice = state.truncated ? <div className="shrink-0 border-t border-border bg-warning/5 px-3 py-1.5 text-micro text-warning">{t("web.fileViewerTruncated")}</div> : null;
	if (path.toLowerCase().endsWith(".md")) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="markdown-body min-h-0 flex-1 overflow-y-auto px-3 py-2">
					<MarkdownStream text={state.content} onOpenExternal={(url: string) => window.open(url, "_blank", "noopener")} />
				</div>
				{truncatedNotice}
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<NumberedText content={state.content} line={line} />
			{truncatedNotice}
		</div>
	);
}

/** diff 模式：先查 git status 定位文件所在分组，再取双栏内容；未跟踪文件=整文件新增。
 * 限制回退：文件已不在任何变更组（git 提交后）、diff 超限或暂存态刚变化 → 自动回退展示
 * 当前文件内容（带提示条），不再让用户面对「找不到改动」的死胡同。 */
function DiffPreviewBody({ projectId, path }: { projectId: string; path: string }) {
	const [diff, setDiff] = useState<DiffState>(null);
	const [loading, setLoading] = useState(true);
	const [missing, setMissing] = useState(false);
	const [tab, setTab] = useState<"original" | "modified">("modified");
	useEffect(() => {
		let alive = true;
		setLoading(true);
		setMissing(false);
		(async () => {
			try {
				const status = await fetchGitStatus(projectId);
				if (!alive) return;
				// 分组优先级与桌面 GitPanel 一致：merge > index > workingTree > untracked
				const groups = status.repo ? status.groups : null;
				const group = groups ? (["merge", "index", "workingTree", "untracked"] as const).find((key) => groups[key].some((resource) => resource.path === path)) : undefined;
				if (!group) {
					setMissing(true);
					return;
				}
				const payload = await fetchGitDiff(projectId, group, path);
				if (!alive) return;
				setDiff(payload);
			} catch {
				if (alive) setMissing(true);
			} finally {
				if (alive) setLoading(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [projectId, path]);
	if (loading) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Loader2 className="size-5 animate-pideck-spin text-muted-foreground" aria-hidden="true" />
			</div>
		);
	}
	if (missing || !diff) {
		// 回退为文件预览：提交后/超限/状态脱节时仍能看到文件本身，提示条说明原因
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-micro text-muted-foreground">{t("web.diffFallbackToFile")}</div>
				<FilePreviewBody projectId={projectId} path={path} />
			</div>
		);
	}
	const isNew = diff.originalContent.length === 0;
	const activeContent = tab === "original" ? diff.originalContent : diff.modifiedContent;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			{/* tab 切换替代旧双栏各 38vh：移动端全高滚动，长 diff 不再被高度上限钳住 */}
			<div className="flex shrink-0 items-center gap-1 border-b border-border bg-card px-2 py-1.5">
				<button type="button" className={`rounded-md px-2.5 py-1 text-caption transition-colors ${tab === "modified" ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60"}`} onClick={() => setTab("modified")}>
					{t("web.diffModified")}
				</button>
				<button type="button" disabled={isNew} className={`rounded-md px-2.5 py-1 text-caption transition-colors ${tab === "original" && !isNew ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60"} ${isNew ? "opacity-40" : ""}`} onClick={() => setTab("original")}>
					{t("web.diffOriginal")}
				</button>
				{isNew ? <span className="ml-auto rounded bg-success/10 px-2 py-0.5 text-micro text-success">{t("web.diffNewFile")}</span> : null}
			</div>
			<NumberedText content={activeContent} />
		</div>
	);
}

/** 全屏覆盖层：fixed inset-0 盖过时间线/composer；body 由 kind 分流。 */
export function WebFilePreview(props: { target: WebFilePreviewTarget; onClose: () => void }) {
	const { target } = props;
	// 系统返回键/手势与 Esc 关闭（移动端主路径，见 hook 注释）；X 按钮是 PWA 无手势时的兑底
	useDismissOnBack(props.onClose, true);
	// 绝对路径裁剪：项目外直接给提示，不发请求（后端本来也会 403）
	const relative = toProjectRelative(target.path, target.projectRoot);
	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-bg-base">
			<PreviewHeader path={relative ?? target.path} onClose={props.onClose} />
			{relative === null ? (
				<div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-muted-foreground">{t("web.previewOutsideProject")}</div>
			) : target.kind === "file" ? (
				<FilePreviewBody projectId={target.projectId} path={relative} line={target.line} />
			) : (
				<DiffPreviewBody projectId={target.projectId} path={relative} />
			)}
		</div>
	);
}
