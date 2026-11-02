/**
 * WebFilePreview — Web 端文件/改动全屏预览（第三批）。
 *
 * 两个入口：
 * - 消息里的文件路径链接（MarkdownStream onOpenFile）→ 文件预览：md 走 MarkdownStream、
 *   其余文本带行号渲染并滚动定位到引用行；二进制/超大/项目外与后端结构化标记对齐。
 * - 会话文件修改 strip 的 chip → Git diff 预览：两栏（原始/修改后）对比 untracked 整文件。
 *
 * 路径不在项目根内时不再硬拒：绝对路径 / `~/x` 直接交后端求值——主进程按当前安全等级
 *（会话覆盖优先）给 allow / ask / deny（`src/main/security/policy.ts` 的 evaluateUserReadAccess，
 * 与桌面端项目外文件链接同一套规则）。ask 在预览层渲染一次「只读查看」确认，确认后带
 * `confirm=1` 重请求；deny（命中 denyDirs）永远不降级。项目内路径仍走原项目根沙箱。
 * diff 只能来自本项目 git status，项目外路径回退成文件预览（不弹确认，由文件路径自身求值）。
 */
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
/** 超过这个行数才虚拟化：短文件直接全量渲染，省掉测量与绝对定位开销。 */
const VIRTUALIZE_MIN_LINES = 40;
import { MarkdownStream } from "@/components/session/MarkdownStream";
import { VirtualStack } from "@/components/ui-shadcn/virtual-stack";
import { t, type TranslationKey } from "@/i18n";
import { fetchFileContent, fetchGitDiff, fetchGitStatus } from "./webApi";
import { useDismissOnBack } from "./useDismissOnBack";

export type WebFilePreviewTarget = { kind: "file"; projectId: string; projectRoot: string; path: string; line?: number } | { kind: "diff"; projectId: string; projectRoot: string; path: string };

type FileState = { content?: string; tooLarge?: boolean; truncated?: boolean; binary?: boolean };
type DiffState = { originalContent: string; modifiedContent: string } | null;

/** 服务端 ask/deny 的 reason → 文案键（与 useExternalPathOpenGate 同一组键；Web 包不引那个
 *  hook，以免把 desktopApi 拖进 Web 构建）。未知 reason 一律按「不在允许目录内」解释。 */
const ACCESS_REASON_KEYS: Record<string, TranslationKey> = {
	sensitive: "app.fileLinkExternalReasonSensitive",
	"outside-allowed-dirs": "app.fileLinkExternalReasonOutsideAllowedDirs",
	"policy-unavailable": "app.fileLinkExternalReasonPolicyUnavailable",
	"deny-dir": "app.fileLinkExternalReasonDenyDir",
};

function accessReasonText(reason: string | undefined): string {
	return t(ACCESS_REASON_KEYS[reason ?? ""] ?? "app.fileLinkExternalReasonOutsideAllowedDirs");
}

/** 从 fetch 抛出的错误里取结构化 code/reason（不依赖 instanceof：错误可能来自另一个模块实例）。 */
function accessErrorInfo(error: unknown): { code: string; reason?: string } | null {
	if (typeof error !== "object" || error === null) return null;
	const code = (error as { code?: unknown }).code;
	if (typeof code !== "string") return null;
	const reason = (error as { reason?: unknown }).reason;
	return { code, reason: typeof reason === "string" ? reason : undefined };
}

/** 把链接里的原始路径裁成项目相对路径；绝对路径按盘符大小写不敏感前缀匹配。
 * 返回 null 表示「不在本项目根内」（项目外绝对路径 / `~/x`）——调用方交后端按安全等级求值，不再硬拒。 */
export function toProjectRelative(rawPath: string, projectRoot: string): string | null {
	if (!rawPath) return null;
	const normalized = rawPath.replace(/\\/g, "/");
	const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
	if (!root) return null;
	// `~/x` / `~\\x`：家目录不是项目目录，交给后端展开后求值
	if (normalized.startsWith("~/") || normalized.startsWith("~\\")) return null;
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
	const virtualize = lines.length > VIRTUALIZE_MIN_LINES;
	const viewportRef = useRef<HTMLDivElement | null>(null);
	const virtualizerRef = useRef<{ scrollToIndex: (index: number, options?: { align?: "start" | "center" | "end" | "auto" }) => void } | null>(null);
	// 虚拟化后目标行可能不在 DOM 里：先把它的索引滚进视口，下一帧才拿得到节点。
	useEffect(() => {
		if (line === undefined) return;
		if (virtualize) {
			virtualizerRef.current?.scrollToIndex(line - 1, { align: "center" });
			const frame = requestAnimationFrame(() => targetRef.current?.scrollIntoView({ block: "center" }));
			return () => cancelAnimationFrame(frame);
		}
		targetRef.current?.scrollIntoView({ block: "center" });
	}, [line, virtualize]);
	const renderRow = (text: string, index: number) => {
		const lineNumber = index + 1;
		const highlighted = line === lineNumber;
		return (
			// data-line 供定位与未来扩展（跳转/复制单行）；行内容原样展示不转义 HTML（React 默认安全）
			<div data-line={lineNumber} ref={highlighted ? targetRef : undefined} className={`flex gap-2 whitespace-pre-wrap px-1 text-micro leading-relaxed ${highlighted ? "rounded bg-primary/15 text-foreground" : "text-foreground/90"}`}>
				<span className="w-8 shrink-0 select-none text-right tabular-nums text-muted-foreground/70">{lineNumber}</span>
				<span className="min-w-0 flex-1 break-all">{text || " "}</span>
			</div>
		);
	};
	return (
		<div ref={viewportRef} className="min-h-0 flex-1 overflow-auto p-2">
			{virtualize ? <VirtualStack items={lines} getKey={(_, index) => String(index)} renderItem={renderRow} scrollRef={viewportRef} estimateHeight={18} minRows={VIRTUALIZE_MIN_LINES} virtualizerRef={virtualizerRef} /> : lines.map((text, index) => <Fragment key={index}>{renderRow(text, index)}</Fragment>)}
		</div>
	);
}

/** 一次 /api/file-content 的结果映射成的预览状态：四路分支只在这里落地（可直接纯函数测试）。 */
export type FilePreviewView = { phase: "loading" } | { phase: "confirm"; reason?: string } | { phase: "denied"; reason?: string } | { phase: "failed" } | { phase: "ready"; data: FileState };

/** 服务端应答 → 预览状态：ask（需确认）/ deny（策略禁止）从错误码识别，其余错误统一失败态。 */
export function classifyFileContentOutcome(outcome: { ok: true; data: FileState } | { ok: false; error: unknown }): FilePreviewView {
	if (outcome.ok) return { phase: "ready", data: outcome.data };
	const info = accessErrorInfo(outcome.error);
	if (info?.code === "webError.fileAccessNeedsConfirm") return { phase: "confirm", reason: info.reason };
	if (info?.code === "webError.fileAccessDenied") return { phase: "denied", reason: info.reason };
	return { phase: "failed" };
}

/** 文件模式：md → MarkdownStream（外链新标签页），其余 → 行号文本。
 * 项目外路径先按安全等级求值：允许直接读，需确认则内联「只读查看」卡片，拒绝则说明原因。 */
function FilePreviewBody({ projectId, path, line }: { projectId: string; path: string; line?: number }) {
	const [view, setView] = useState<FilePreviewView>({ phase: "loading" });
	// 已确认的目标键：随 path 变化自动失效，避免「确认了 A 就把 B 也一起放行」
	const [confirmedKey, setConfirmedKey] = useState<string | null>(null);
	// 每次确认都推进一帧：服务端若仍回 ask（策略刚被改严），用户还能再点一次而不是卡在空屏
	const [confirmTick, setConfirmTick] = useState(0);
	const targetKey = `${projectId}\u0000${path}`;
	const confirmed = confirmedKey === targetKey;

	useEffect(() => {
		let alive = true;
		setView({ phase: "loading" });
		fetchFileContent(projectId, path, { confirmed })
			.then((data) => alive && setView(classifyFileContentOutcome({ ok: true, data })))
			.catch((error) => alive && setView(classifyFileContentOutcome({ ok: false, error })));
		return () => {
			alive = false;
		};
	}, [projectId, path, confirmed, confirmTick]);
	if (view.phase === "confirm") {
		return (
			<div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
				<div className="text-caption font-medium text-foreground">{t("app.fileLinkExternalOpenTitle")}</div>
				<div className="text-micro leading-relaxed text-muted-foreground">{t("app.fileLinkExternalOpenMessage", { path, reason: accessReasonText(view.reason) })}</div>
				<button
					type="button"
					className="rounded-md bg-primary px-3 py-2 text-caption font-medium text-primary-foreground transition-opacity active:opacity-80"
					onClick={() => {
						setConfirmedKey(targetKey);
						setConfirmTick((tick) => tick + 1);
					}}
				>
					{t("app.fileLinkExternalConfirm")}
				</button>
			</div>
		);
	}
	if (view.phase === "denied") return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-muted-foreground">{t("app.fileLinkExternalBlocked", { path, reason: accessReasonText(view.reason) })}</div>;
	if (view.phase === "failed") return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-muted-foreground">{t("web.previewLoadFailed")}</div>;
	if (view.phase === "loading") {
		return (
			<div className="flex flex-1 items-center justify-center">
				<Loader2 className="size-5 animate-pideck-spin text-muted-foreground" aria-hidden="true" />
			</div>
		);
	}
	const { data } = view;
	if (data.tooLarge) return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-warning">{t("web.fileViewerTooLarge")}</div>;
	if (data.binary) return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-muted-foreground">{t("web.fileViewerBinary")}</div>;
	if (data.content == null) return <div className="flex flex-1 items-center justify-center px-6 text-center text-caption text-muted-foreground">{t("web.previewLoadFailed")}</div>;
	// 截断预览：能看前 512KB 比完全不给强；底部提示告知完整内容请回桌面端
	const truncatedNotice = data.truncated ? <div className="shrink-0 border-t border-border bg-warning/5 px-3 py-1.5 text-micro text-warning">{t("web.fileViewerTruncated")}</div> : null;
	if (path.toLowerCase().endsWith(".md")) {
		{
			/* scroll-ok: text —— markdown 预览整篇交给 MarkdownStream 渲染，虚拟化会把标题/代码块/列表的结构切成行，语义与复制都会坏。 */
		}
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				{/* scroll-ok: text —— 单一文本块（pre / markdown 正文），没有行列表可切，虚拟化无从下手。 */}
				<div className="markdown-body min-h-0 flex-1 overflow-y-auto px-3 py-2">
					<MarkdownStream text={data.content} onOpenExternal={(url: string) => window.open(url, "_blank", "noopener")} />
				</div>
				{truncatedNotice}
			</div>
		);
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<NumberedText content={data.content} line={line} />
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
	// 项目内 → 裁成相对路径；项目外 → 原样交后端按安全等级求值（绝对路径 / `~/x`）
	const relative = toProjectRelative(target.path, target.projectRoot);
	const targetPath = relative ?? target.path;
	const body =
		target.kind === "diff" && relative !== null ? (
			<DiffPreviewBody projectId={target.projectId} path={relative} />
		) : (
			// diff 只能来自本项目 git status：项目外路径回退成文件预览（文件自身仍要过安全策略）
			<div className="flex min-h-0 flex-1 flex-col">
				{target.kind === "diff" ? <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5 text-micro text-muted-foreground">{t("web.diffFallbackToFile")}</div> : null}
				<FilePreviewBody projectId={target.projectId} path={targetPath} line={target.kind === "file" ? target.line : undefined} />
			</div>
		);
	return (
		<div className="fixed inset-0 z-50 flex flex-col bg-bg-base">
			<PreviewHeader path={targetPath} onClose={props.onClose} />
			{body}
		</div>
	);
}
