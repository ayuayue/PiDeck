/**
 * 插件市场：双源搜索（官方收录 registry.json + GitHub `pideck-plugin` topic）→ 一键安装。
 *
 * 这个组件只做三件事：拿关键词换条目、把条目渲染成卡片、把条目的 `installUrl` 交给
 * `hostPlugins.installGitHub`。它不解析包、不落盘、不授权——安装与信任判定全在主进程，
 * 与「从 GitHub 链接安装」走的是同一条路径，所以市场本身不扩大任何能力面。
 */
import { useState } from "react";
import { useSetAtom } from "jotai";
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
	const setCatalog = useSetAtom(hostPluginCatalogAtom);
	const [keyword, setKeyword] = useState("");
	const [searching, setSearching] = useState(false);
	// null = 还没搜过（显示引导语），空数组 = 搜过但没有结果。
	const [results, setResults] = useState<HostPluginMarketSearchResult | null>(null);
	const [installing, setInstalling] = useState<string | null>(null);
	const [searchError, setSearchError] = useState<string | null>(null);
	const search = async () => {
		setSearching(true);
		setSearchError(null);
		try {
			const result = await desktopApi.hostPlugins.searchMarket(keyword.trim());
			if (result.ok) setResults(result.value);
			else setSearchError(result.code);
		} catch {
			setSearchError("plugin-host-unavailable");
		} finally {
			setSearching(false);
		}
	};
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
			<DialogContent className="flex max-h-[calc(100vh-64px)] max-w-[min(720px,calc(100vw-48px))] flex-col gap-4">
				<DialogHeader>
					<DialogTitle>{t("hostPlugins.marketTitle")}</DialogTitle>
					<DialogDescription>{t("hostPlugins.marketDescription")}</DialogDescription>
				</DialogHeader>
				<form
					className="flex items-center gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!searching) void search();
					}}
				>
					<Input id="host-plugin-market-keyword" aria-label={t("hostPlugins.marketSearchPlaceholder")} spellCheck={false} placeholder={t("hostPlugins.marketSearchPlaceholder")} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
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
				<div className="min-h-0 flex-1 overflow-y-auto">
					{results === null ? (
						<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
							<Store size={20} className="text-muted-foreground" aria-hidden="true" />
							<span className="max-w-[34rem] text-xs leading-relaxed text-muted-foreground">{t("hostPlugins.marketIdle")}</span>
						</div>
					) : results.entries.length === 0 ? (
						<div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border px-4 py-10 text-center">
							<Store size={20} className="text-muted-foreground" aria-hidden="true" />
							<span className="max-w-[34rem] text-xs leading-relaxed text-muted-foreground">{t("hostPlugins.marketEmpty")}</span>
						</div>
					) : (
						<div className="grid gap-1.5">
							{results.entries.map((entry) => {
								const Icon = hostPluginPanelIcon(entry.icon);
								const busy = installing !== null;
								return (
									<div key={`${entry.source}:${entry.installUrl}`} className="grid gap-1.5 rounded-md border border-border-subtle bg-card p-2.5">
										<div className="flex min-w-0 flex-wrap items-center gap-2">
											<Icon size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
											<span className="truncate text-sm font-medium text-foreground">{entry.name}</span>
											{entry.version && <span className="font-mono text-micro tabular-nums text-muted-foreground">v{entry.version}</span>}
											<Badge variant="outline" className="text-micro font-normal text-muted-foreground">
												{entry.source === "registry" ? t("hostPlugins.marketSourceRegistry") : t("hostPlugins.marketSourceGithub")}
											</Badge>
											{entry.stars !== undefined && <span className="text-micro tabular-nums text-muted-foreground">{t("hostPlugins.marketStars", { count: entry.stars })}</span>}
											<Button variant="outline" size="sm" className="ml-auto" disabled={busy} onClick={() => void install(entry)}>
												{busy && installing === entry.installUrl ? <LoaderCircle className="size-4 animate-pideck-spin" aria-hidden="true" /> : null}
												{busy && installing === entry.installUrl ? t("hostPlugins.marketInstalling") : t("hostPlugins.marketInstall")}
											</Button>
										</div>
										{entry.description && (
											<p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground" title={entry.description}>
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
							{results.entries.some((entry) => entry.source === "github") && <p className="px-1 pt-1 text-micro leading-relaxed text-muted-foreground">{t("hostPlugins.marketCommunityHint")}</p>}
						</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}
