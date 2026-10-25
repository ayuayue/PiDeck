import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { PiReleaseNotesPayload } from "../../../../../shared/types";
import { desktopApi } from "../../../desktopApi";
import { formatI18nDateTime, t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../ui-shadcn/dialog";
import { ScrollArea } from "../../ui-shadcn/scroll-area";
import { MarkdownStream } from "../../session/MarkdownStream";

type LoadState = { status: "loading" } | { status: "ready"; payload: PiReleaseNotesPayload & { markdown: string } } | { status: "unavailable"; pageUrl: string };

/**
 * pi CLI「更新详情」弹窗：展示 (current, latest] 区间的官方 CHANGELOG 条目。
 *
 * 渲染与降级策略与 PiDeck 自身更新日志（ChangelogDialog）对齐：
 * - 正文是外部数据（jsDelivr/unpkg/GitHub raw），一律经 MarkdownStream sanitize 管线，
 *   禁止 dangerouslySetInnerHTML；
 * - 主进程所有源都失败时 markdown=null，降级为「在浏览器查看」，不打断用户；
 * - 打开时才拉取（主进程按 latestVersion 内存缓存），关闭即复位。
 */
export function PiChangelogDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 当前安装版本（缺失时主进程取最新若干条兜底）。 */
	currentVersion?: string;
	/** 目标版本：钉版拉取该版本的 CHANGELOG。 */
	latestVersion: string;
}) {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	const load = useCallback(async () => {
		setState({ status: "loading" });
		try {
			const payload = await desktopApi.pi.releaseNotes({ latestVersion: props.latestVersion, currentVersion: props.currentVersion });
			if (payload.markdown) {
				setState({ status: "ready", payload: { ...payload, markdown: payload.markdown } });
				return;
			}
			setState({ status: "unavailable", pageUrl: payload.pageUrl });
		} catch {
			// IPC 本身异常（主进程已尽力）：同样降级而不是抛给用户。
			setState({ status: "unavailable", pageUrl: DEFAULT_PAGE_URL });
		}
	}, [props.currentVersion, props.latestVersion]);

	// 打开时才拉取，关闭即复位：保证下次打开是新鲜内容，也避免每次渲染都打网络。
	useEffect(() => {
		if (!props.open) return;
		void load();
	}, [props.open, load]);

	const openInBrowser = useCallback((url: string) => {
		void desktopApi.app.openExternal(url, true).catch(() => undefined);
	}, []);

	return (
		<Dialog open={props.open} onOpenChange={props.onOpenChange}>
			<DialogContent
				/* max-width 写法与 ChangelogDialog 同源：Tailwind v4 按类名字母序产出规则，
				   `min(...)`（m）排在基础类的 `lg`（l）之后才能生效；直接写 max-w-[760px] 会被压回 512px。 */
				className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-[min(760px,calc(100vw-48px))]"
			>
				<DialogHeader>
					<DialogTitle>{t("piChangelog.title")}</DialogTitle>
					<DialogDescription>{state.status === "ready" ? t("piChangelog.subtitleVersions", { current: props.currentVersion ?? "?", latest: props.latestVersion, count: state.payload.versionCount }) : t("piChangelog.subtitle", { current: props.currentVersion ?? "?", latest: props.latestVersion })}</DialogDescription>
				</DialogHeader>

				{state.status === "loading" && <p className="py-8 text-center text-caption text-muted-foreground">{t("changelog.loading")}</p>}

				{state.status === "unavailable" && (
					<div className="flex flex-col items-center gap-3 py-8">
						<p className="text-caption text-muted-foreground">{t("changelog.unavailable")}</p>
						<Button variant="secondary" size="sm" onClick={() => openInBrowser(state.pageUrl)}>
							<ExternalLink size={12} aria-hidden="true" />
							{t("changelog.openInBrowser")}
						</Button>
					</div>
				)}

				{state.status === "ready" && (
					<>
						{/* 固定高度 + 内部滚动；外层必须挂 markdown-body（长内容压缩与 sanitize 样式依赖它，
						    与 ChangelogDialog 同一约定）。light：静态只读场景关掉重插件。 */}
						<ScrollArea className="h-[52vh] rounded-md border border-border-subtle">
							<div className="markdown-body px-4 py-3 text-chat text-text-primary">
								<MarkdownStream text={state.payload.markdown} isStreaming={false} light onOpenExternal={(url) => openInBrowser(url)} />
							</div>
						</ScrollArea>
						<div className="flex items-center justify-between gap-2">
							<span className="text-caption text-muted-foreground/70">
								{t("changelog.sourceLabel", { source: state.payload.source ?? "—" })}
								{state.payload.fetchedAt ? ` · ${t("changelog.updatedAt", { time: formatI18nDateTime(state.payload.fetchedAt) })}` : ""}
							</span>
							<div className="flex items-center gap-2">
								{state.payload.truncated && <span className="text-caption text-muted-foreground">{t("piChangelog.truncated")}</span>}
								<Button variant="ghost" size="sm" onClick={() => void load()}>
									<RefreshCw size={12} aria-hidden="true" />
									{t("changelog.reload")}
								</Button>
								<Button variant="ghost" size="sm" onClick={() => openInBrowser(state.payload.pageUrl)}>
									<ExternalLink size={12} aria-hidden="true" />
									{t("changelog.openInBrowser")}
								</Button>
							</div>
						</div>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}

/** IPC 彻底失败时的兜底地址；与主进程 PiChangelogService 的 pageUrl 同源。 */
const DEFAULT_PAGE_URL = "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md";
