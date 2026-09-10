import { useCallback, useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { ChangelogPayload } from "../../../../../shared/types";
import { desktopApi } from "../../../desktopApi";
import { formatI18nDateTime, t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "../../ui-shadcn/dialog";
import { ScrollArea } from "../../ui-shadcn/scroll-area";
import { MarkdownStream } from "../../session/MarkdownStream";

type LoadState =
	| { status: "loading" }
	| { status: "ready"; payload: ChangelogPayload & { markdown: string } }
	| { status: "unavailable"; pageUrl: string };

/**
 * 更新日志弹窗。
 *
 * 「关于」弹框与设置页更新卡片两处共用同一个组件与同一条 IPC —— 不做两份实现，
 * 否则两处的降级行为/渲染管线迟早分叉。
 *
 * ## 渲染安全边界
 *
 * CHANGELOG 是**外部数据**（来自 atomgit/GitHub raw，且主进程已确认不是 HTML 壳）。
 * 正文一律经 MarkdownStream 渲染，与会话消息、公告详情同一套 streamdown sanitize
 * 管线；禁止绕过它直接塞 dangerouslySetInnerHTML。
 *
 * ## 降级策略
 *
 * 主进程拉取失败（所有源都挂 / 内容校验不通过）时返回 markdown=null。此时不报错、
 * 不阻塞，直接展示「打开浏览器查看」入口——拿不到更新日志不该打断用户。
 *
 * ## 与外层 MorphPopover 的关系（「关于」入口）
 *
 * 「关于」弹框的外点判定（popover-morph 的 window pointerdown）按 root/contentRef
 * 判内外，而本弹窗 portal 到 body，两者是兄弟节点。为了不让「点开更新日志」被
 * 误判成「点了关于弹框外部」，「关于」那处给本组件传 dismissExemptOnOutside，
 * 由 DialogContent 把豁免标记挂到 portal 根上，popover-morph 侧据此跳过这次外点判定。
 */
export function ChangelogDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * 打开时豁免外层浮层（如 MorphPopover）的外部点击关闭。
	 * 仅在入口本身位于另一个自带外点关闭的浮层内部时需要开启，见文件头注释。
	 */
	dismissExemptOnOutside?: boolean;
}) {
	const [state, setState] = useState<LoadState>({ status: "loading" });

	// forceRefresh=false：主进程 TTL 内直接回本地缓存（零网络秒开）；
	// true：「刷新」按钮语义，跳过缓存强制拉最新，成功覆盖本地缓存。
	const load = useCallback(async (forceRefresh = false) => {
		setState({ status: "loading" });
		try {
			const payload = await desktopApi.app.getChangelog(undefined, forceRefresh);
			if (payload.markdown) {
				setState({
					status: "ready",
					payload: { ...payload, markdown: payload.markdown },
				});
				return;
			}
			setState({ status: "unavailable", pageUrl: payload.pageUrl });
		} catch {
			// IPC 本身异常（主进程已尽力，走到这里属意外）：同样降级而不是抛给用户。
			setState({
				status: "unavailable",
				pageUrl: DEFAULT_PAGE_URL,
			});
		}
	}, []);

	// 打开时才拉取，关闭即复位：避免每次渲染都打网络，也保证下次打开是新鲜内容。
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
				/* DialogContent 基础类自带 `sm:max-w-lg`。Tailwind v4 按**类名字母序**产出
				   规则，`[760px]`（`[`）排在 `lg`（`l`）之前 → 基础类的 max-width 反而胜出，
				   弹窗在 ≥640px 视口下被压回 512px。所以这里必须写成字母序在 `lg` 之后的
				   形式（`min(...)`，`m` > `l`），与 SettingsModal / ConfigModal 的既有做法同源：
				   只写 `sm:max-w-[760px]` 是无效的（实测产物中该规则排在 lg 之前）。
				   上限同时兜住窄视口，不会把弹窗顶出屏幕。 */
				className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-[min(760px,calc(100vw-48px))]"
				dismissExemptOnOutside={props.dismissExemptOnOutside}
			>
				<DialogHeader>
					<DialogTitle>{t("changelog.title")}</DialogTitle>
					<DialogDescription>
						{state.status === "ready"
							? t("changelog.subtitleVersions", { count: state.payload.versionCount })
							: t("changelog.subtitle")}
					</DialogDescription>
				</DialogHeader>

				{state.status === "loading" && (
					<p className="py-8 text-center text-caption text-muted-foreground">
						{t("changelog.loading")}
					</p>
				)}

				{state.status === "unavailable" && (
					<div className="flex flex-col items-center gap-3 py-8">
						<p className="text-caption text-muted-foreground">
							{t("changelog.unavailable")}
						</p>
						<Button
							variant="secondary"
							size="sm"
							onClick={() => openInBrowser(state.pageUrl)}
						>
							<ExternalLink size={12} aria-hidden="true" />
							{t("changelog.openInBrowser")}
						</Button>
					</div>
				)}

				{state.status === "ready" && (
					<>
						{/* 固定高度 + 内部滚动：正文可达数十个版本，弹窗不能无限长。
						    MarkdownStream 传 light：更新日志是静态只读场景，关掉代码高亮/
						    mermaid/数学等重插件（组件内注释亦为此场景预留了该开关）。

						    外层必须显式挂 `markdown-body`：MarkdownStream 自身不挂这个类
						    （会话里由 AssistantText 挂），而正文的「压缩宽内容」全靠
						    .markdown-body 的 overflow-x: clip + 子元素 min-width:0
						    （见 styles/timeline.css）。不挂的话长段落会被判成不可断行的
						    单行文本，横向撑破弹窗——既不出换行也不出滚动条。 */}
						<ScrollArea className="h-[52vh] rounded-md border border-border-subtle">
							<div className="markdown-body px-4 py-3 text-chat text-text-primary">
								<MarkdownStream
									text={state.payload.markdown}
									isStreaming={false}
									light
									onOpenExternal={(url) => openInBrowser(url)}
								/>
							</div>
						</ScrollArea>
						<div className="flex items-center justify-between gap-2">
							{/* 诊断信息：内容来源 + 抓取时间（TTL 内秒开的本地缓存也能看出来源与新旧）；
							    stale（网络失败退回旧缓存）时额外提示可刷新取最新。 */}
							<span className="text-caption text-muted-foreground/70">
								{t("changelog.sourceLabel", {
									source:
										state.payload.source === "github"
											? "GitHub"
											: state.payload.source === "atomgit"
												? "AtomGit"
												: "—",
								})}
								{state.payload.fetchedAt
									? ` · ${t("changelog.updatedAt", {
											time: formatI18nDateTime(state.payload.fetchedAt),
										})}`
									: ""}
							</span>
							<div className="flex gap-2">
								{state.payload.stale && (
									<span className="self-center text-caption text-muted-foreground">
										{t("changelog.staleNotice")}
									</span>
								)}
								<Button
									variant="ghost"
									size="sm"
									onClick={() => void load(true)}
								>
									<RefreshCw size={12} aria-hidden="true" />
									{t("changelog.reload")}
								</Button>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => openInBrowser(state.payload.pageUrl)}
								>
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

/**
 * IPC 彻底失败时的兜底地址。
 * 与主进程 ChangelogService.changelogPageUrl 同源（同样指向 AtomGit blob 页）；
 * 主进程返回的 pageUrl 始终可用，此常量只用于 IPC 本身抛错的极端场景。
 */
const DEFAULT_PAGE_URL =
	"https://atomgit.com/ayuayue/PiDeck/blob/main/CHANGELOG.zh-CN.md";
