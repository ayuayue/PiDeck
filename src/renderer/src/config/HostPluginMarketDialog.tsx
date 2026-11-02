/**
 * 插件市场：双源搜索（官方收录 registry.json + GitHub `pideck-plugin` topic）→ 一键安装。
 *
 * 这个组件只做三件事：拿关键词换条目、把条目渲染成卡片、把条目的 `installUrl` 交给
 * `hostPlugins.installGitHub`。它不解析包、不落盘、不授权——安装与信任判定全在主进程，
 * 与「从 GitHub 链接安装」走的是同一条路径，所以市场本身不扩大任何能力面。
 *
 * 打开即拉一次全量（空关键词）：本地已装的插件（含随包分发的内置插件）同样在列表里，
 * 只是打「已安装」标记并禁用安装按钮——否则点下去只会撞 `plugin-in-use`。
 */
import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { ExternalLink, LoaderCircle, Search, Store } from "lucide-react";
import type { HostPluginMarketEntry, HostPluginMarketSearchResult } from "../../../shared/types/hostPlugin";
import { hostPluginCatalogAtom } from "../atoms/host-plugin-atoms";
import { desktopApi } from "../desktopApi";
import { t, type TranslationKey } from "../i18n";
import { showNotice } from "../utils/notice";
import { Alert, AlertDescription } from "../components/ui-shadcn/alert";
import { Badge } from "../components/ui-shadcn/badge";
import { Button } from "../components/ui-shadcn/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Input } from "../components/ui-shadcn/input";
import { hostPluginPanelIcon } from "../components/plugins/hostPluginPanelIcon";
import { HOST_PLUGIN_PERMISSION_CHIP_KEYS } from "./HostPluginPermissionDetails";

export type HostPluginMarketDialogProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 安装失败交给设置页统一提示（错误码文案与「从 GitHub 链接安装」共用一份）。 */
	onFail: (code: string) => void;
};

/**
 * 远程条目的 `permissions` 是不可信字符串：认识的权限给本地化标签，不认识的**原样显示**——
 * 隐藏未知权限会让人以为它不需要权限，比显示一个生名字危险得多。
 */
function permissionLabel(permission: string): string {
	const known = HOST_PLUGIN_PERMISSION_CHIP_KEYS as Record<string, TranslationKey | undefined>;
	const key = known[permission];
	return key ? t(key) : permission;
}

export function HostPluginMarketDialog({ open, onOpenChange, onFail }: HostPluginMarketDialogProps) {
	const catalog = useAtomValue(hostPluginCatalogAtom).catalog;
	const setCatalog = useSetAtom(hostPluginCatalogAtom);
	const [keyword, setKeyword] = useState("");
	const [searching, setSearching] = useState(false);
	// null = 还没拿到结果（首帧），空数组 = 搜过但没有结果。
	const [results, setResults] = useState<HostPluginMarketSearchResult | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	const [searchError, setSearchError] = useState<string | null>(null);
	// 本地已装的版本，按插件 id 索引：市场条目只带 id/version，用它判断「已安装 / 可更新」。
	const installed = new Map<string, string>((catalog?.plugins ?? []).map((plugin) => [plugin.manifest.id, plugin.manifest.version]));
	const search = async (value: string) => {
		setSearching(true);
		setSearchError(null);
		try {
			const result = await desktopApi.hostPlugins.searchMarket(value.trim());
			if (result.ok) setResults(result.value);
			else setSearchError(result.code);
		} catch {
			setSearchError("plugin-host-unavailable");
		} finally {
			setSearching(false);
		}
	};
	useEffect(() => {
		// 打开就拉一次全量：不这样的话弹窗里只有一个引导语，看起来像「市场是空的」。
		// 缓存由主进程管（社区 10 分钟 / 官方索引 6 小时），反复开关不会反复打网。
		if (open) void search("");
	}, [open]);
	/** 安装：市场只提供链接，下载/解包/预算校验/落位都在主进程，装完仍是禁用状态。 */
	const install = async (entry: HostPluginMarketEntry) => {
		setInstalling(entry.installUrl);
		try {
			const result = await desktopApi.hostPlugins.installGitHub(entry.installUrl);
			if (result.ok) {
				setCatalog({ catalog: result.value });
				showNotice(t("hostPlugins.marketInstalled", { name: entry.name }), 5000, "info");
			} else onFail(result.code);
		} catch {
			onFail("plugin-host-unavailable");
		} finally {
			setInstalling(null);
		}
	};
	const entries = results?.entries ?? [];
	const official = entries.filter((entry) => entry.source === "registry").length;
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				onOpenChange(next);
				if (!next) {
					// 关掉就丢弃结果：下次打开重新搜，避免拿着几小时前的列表去装已经不存在的仓库。
					setResults(null);
					setSearchError(null);
				}
			}}
		>
			{/* 尺寸走 DialogContent 的 `size="xl"`（1300×850，与设置/项目管理同档）：
			    基线里的 `sm:max-w-lg` 是带 variant 的，直接写 `max-w-[…]` 会被它在 ≥sm 时压回去（实测只有 510px 宽）。 */}
			<DialogContent size="xl" className="flex h-auto max-h-[min(850px,calc(100vh-48px))] flex-col gap-3">
				<DialogHeader>
					<DialogTitle>{t("hostPlugins.marketTitle")}</DialogTitle>
					<DialogDescription>{t("hostPlugins.marketDescription")}</DialogDescription>
				</DialogHeader>
				<form
					className="flex items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!searching) void search(keyword);
					}}
				>
					<Input id="host-plugin-market-keyword" autoFocus aria-label={t("hostPlugins.marketSearchPlaceholder")} spellCheck={false} placeholder={t("hostPlugins.marketSearchPlaceholder")} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
					<Button type="submit" size="sm" disabled={searching}>
						{searching ? <LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" /> : <Search className="size-4" aria-hidden="true" />}
						{t("hostPlugins.marketSearch")}
					</Button>
				</form>
				{searchError && (
					<Alert variant="destructive">
						<AlertDescription>{t("hostPlugins.marketFailed", { code: searchError })}</AlertDescription>
					</Alert>
				)}
				{results && results.warnings.length > 0 && (
					<Alert>
						<AlertDescription className="break-all font-mono text-xs">{t("hostPlugins.marketWarning", { warnings: results.warnings.join(" · ") })}</AlertDescription>
					</Alert>
				)}
				{results && entries.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-2 text-micro tabular-nums text-muted-foreground">
						<span>{t("hostPlugins.marketSummary", { count: entries.length, registry: official, github: entries.length - official })}</span>
					</div>
				)}
				{/* scroll-ok: bounded —— 市场结果双源合并后封顶 40 条（hostPluginMarket.ts MAX_SEARCH_RESULTS），卡片网格高度有界，无需虚拟化 */}
				<div className="min-h-0 flex-1 overflow-y-auto">
					{results === null ? (
						<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
							<LoaderCircle size={20} className="animate-pideck-spin text-muted-foreground" aria-hidden="true" />
							<span className="max-w-[34rem] text-xs leading-relaxed text-muted-foreground">{t("hostPlugins.marketIdle")}</span>
						</div>
					) : entries.length === 0 ? (
						<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
							<Store size={20} className="text-muted-foreground" aria-hidden="true" />
							<span className="max-w-[34rem] text-xs leading-relaxed text-muted-foreground">{t("hostPlugins.marketEmpty")}</span>
						</div>
					) : (
						<div className="grid content-start gap-2 lg:grid-cols-2">
							{entries.map((entry) => {
								const Icon = hostPluginPanelIcon(entry.icon);
								const busy = installing !== null;
								const localVersion = installed.get(entry.id);
								const isInstalled = localVersion !== undefined;
								// 只有版本能比较、且确实不同才算「可更新」；版本号缺失时按「已安装」处理，不去猜。
								const upgradable = isInstalled && !!entry.version && entry.version !== localVersion;
								return (
									<div key={`${entry.source}:${entry.installUrl}`} className="grid content-start gap-1.5 rounded-md border border-border-subtle bg-card p-2.5">
										<div className="flex min-w-0 flex-wrap items-center gap-2">
											<Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
											<span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
											{entry.version && <span className="font-mono text-micro tabular-nums text-muted-foreground">v{entry.version}</span>}
											<Badge variant="outline" className="text-micro font-normal text-muted-foreground">
												{entry.source === "registry" ? t("hostPlugins.marketSourceRegistry") : t("hostPlugins.marketSourceGithub")}
											</Badge>
											{isInstalled && !upgradable && (
												<Badge variant="secondary" className="text-micro font-normal">
													{t("hostPlugins.marketInstalledBadge")}
												</Badge>
											)}
											{upgradable && (
												<Badge variant="secondary" className="text-micro font-normal">
													{t("hostPlugins.marketUpdateBadge", { version: entry.version ?? "" })}
												</Badge>
											)}
											{entry.stars !== undefined && <span className="text-micro tabular-nums text-muted-foreground">{t("hostPlugins.marketStars", { count: entry.stars })}</span>}
											<Button variant="outline" size="sm" className="ml-auto shrink-0" disabled={busy || (isInstalled && !upgradable)} onClick={() => void install(entry)}>
												{busy && installing === entry.installUrl ? <LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" /> : null}
												{isInstalled && !upgradable ? t("hostPlugins.marketInstalledBadge") : busy && installing === entry.installUrl ? t("hostPlugins.marketInstalling") : t("hostPlugins.marketInstall")}
											</Button>
										</div>
										{entry.description && (
											<p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={entry.description}>
												{entry.description}
											</p>
										)}
										<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-micro text-muted-foreground">
											<span className="truncate font-mono">{entry.repo}</span>
											{entry.license && <span>{entry.license}</span>}
											<Button
												variant="link"
												size="sm"
												className="h-auto gap-1 px-0 text-micro font-normal"
												onClick={() => {
													void desktopApi.app.openExternal(entry.installUrl, true).catch(() => onFail("plugin-host-unavailable"));
												}}
											>
												<ExternalLink size={11} aria-hidden="true" />
												{t("hostPlugins.marketOpenRepo")}
											</Button>
										</div>
										{/* 权限是「装之前就要看到」的信息：市场卡片直接摊开，别等安装后才发现要整个工作区。 */}
										<div className="flex flex-wrap items-center gap-1">
											<span className="text-micro text-muted-foreground">{entry.permissions.length === 0 ? t("hostPlugins.marketNoPermissions") : t("hostPlugins.marketPermissions")}</span>
											{entry.permissions.map((permission) => (
												<Badge key={permission} variant="secondary" className="px-1.5 py-0 text-micro font-normal text-muted-foreground">
													{permissionLabel(permission)}
												</Badge>
											))}
										</div>
									</div>
								);
							})}
							{entries.some((entry) => entry.source === "github") && <p className="px-1 text-micro leading-relaxed text-muted-foreground lg:col-span-2">{t("hostPlugins.marketCommunityHint")}</p>}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
