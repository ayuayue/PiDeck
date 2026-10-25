import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Globe, RefreshCw, Search, Trash2 } from "lucide-react";
import type { DshPluginMarketEntry, DshUserPluginListEntry } from "../../../shared/types";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Badge } from "../components/ui-shadcn/badge";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";

/**
 * 插件市场区（搜索 + 安装 + 已安装列表）。
 *
 * 双源语义：官方 dsh 插件目录 + npm search（单源失败降级 warnings，不阻断）。
 * 安装走主进程 npm pack → 受管目录 → 用户补丁层行；行写入后 host 进程重启才会
 * 重读补丁层，所以安装成功只提示「重启会话生效」，不自动重启（用户可能连续装多个）。
 * 卸载复用既有 uninstallDshUserPlugin 链路（移除行 + 仅受管目录回收），随后重启 host。
 */
export function DshPluginMarketSection() {
	const [keyword, setKeyword] = useState("");
	const [searching, setSearching] = useState(false);
	/** null = 尚未搜索（与「搜索了但为空」区分：后者展示空态 + 精确安装入口）。 */
	const [results, setResults] = useState<DshPluginMarketEntry[] | null>(null);
	const [warnings, setWarnings] = useState<string[]>([]);
	/** 正在安装的条目名（按钮禁用与文案用）。 */
	const [installingName, setInstallingName] = useState<string | null>(null);
	/** 两步确认：uiOnly 插件第一次点安装进入警示态，第二次「仍要安装」才执行。 */
	const [confirmUiOnlyName, setConfirmUiOnlyName] = useState<string | null>(null);

	const [installed, setInstalled] = useState<DshUserPluginListEntry[]>([]);
	const [installedLoading, setInstalledLoading] = useState(true);
	const [confirmUninstallRowId, setConfirmUninstallRowId] = useState<string | null>(null);
	const [uninstalling, setUninstalling] = useState(false);

	const loadInstalled = useCallback(async () => {
		try {
			setInstalled(await desktopApi.sessions.listDshUserPlugins());
		} catch {
			// 服务未装配：保持空列表
		} finally {
			setInstalledLoading(false);
		}
	}, []);

	useEffect(() => {
		void loadInstalled();
	}, [loadInstalled]);

	const search = async () => {
		const value = keyword.trim();
		if (!value || searching) return;
		setSearching(true);
		setConfirmUiOnlyName(null);
		try {
			const result = await desktopApi.sessions.searchDshPluginMarket(value);
			setResults(result.entries);
			setWarnings(result.warnings);
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 5000);
		} finally {
			setSearching(false);
		}
	};

	/** 安装执行（uiOnly 两步确认的终点 / 普通条目直达）。 */
	const install = async (spec: string, uiOnly: boolean) => {
		if (installingName) return;
		if (uiOnly && confirmUiOnlyName !== spec) {
			setConfirmUiOnlyName(spec);
			return;
		}
		setConfirmUiOnlyName(null);
		setInstallingName(spec);
		try {
			const result = await desktopApi.sessions.installDshUserPlugin(spec);
			// 安装的插件在 host 进程下次启动时才被 Loader 读取（补丁层是启动期快照），
			// 只提示不自动重启：用户连续安装多个时反复重启没有意义。
			showNotice(t(uiOnly || result.uiOnly ? "config.dsh.pluginMarketInstalledUiOnlyHint" : "config.dsh.pluginMarketInstalledRestartHint"), 6000);
			await loadInstalled();
		} catch (error) {
			showNotice(`${t("config.dsh.pluginMarketInstallFailed")}：${error instanceof Error ? error.message : String(error)}`, 7000);
		} finally {
			setInstallingName(null);
		}
	};

	/** 卸载（两步确认；复用既有 uninstallDshUserPlugin 链路，完成后重启 host）。 */
	const uninstall = async (entry: DshUserPluginListEntry) => {
		if (confirmUninstallRowId !== entry.rowId) {
			setConfirmUninstallRowId(entry.rowId);
			return;
		}
		setConfirmUninstallRowId(null);
		setUninstalling(true);
		try {
			const result = await desktopApi.sessions.uninstallDshUserPlugin({ entryId: entry.rowId, moduleName: entry.moduleName, deleteFiles: true });
			if (!result.rowRemoved) {
				showNotice(result.reason ?? t("config.dsh.pluginUserUninstallFailed"), 5000);
				return;
			}
			showNotice(result.keptPluginDir ? `${t("config.dsh.pluginFilesKeepHint")}：${result.keptPluginDir}` : t("config.dsh.pluginUserUninstalled"), 6000);
			try {
				await desktopApi.sessions.restartDshHost();
			} catch {
				showNotice(t("config.dsh.pluginHostRestartFailed"), 5000);
			}
			await loadInstalled();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 5000);
		} finally {
			setUninstalling(false);
		}
	};

	/** 搜索无结果时：关键词本身像可安装的 npm spec（name / name@1.2.3）才给精确安装入口。 */
	const keywordLooksLikeSpec = useMemo(() => /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?)?$/i.test(keyword.trim()), [keyword]);

	return (
		<div className="grid gap-3">
			<div className="flex items-baseline gap-2">
				<h3 className="text-caption font-semibold text-foreground">{t("config.dsh.pluginMarket")}</h3>
			</div>
			<p className="text-micro text-muted-foreground">{t("config.dsh.pluginMarketHint")}</p>
			<form
				className="flex gap-2"
				onSubmit={(event) => {
					event.preventDefault();
					void search();
				}}
			>
				<label className="relative flex-1">
					<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
					<Input type="search" value={keyword} onChange={(event) => setKeyword(event.currentTarget.value)} placeholder={t("config.dsh.pluginMarketSearchPlaceholder")} className="h-9 pl-8" />
				</label>
				<Button type="submit" variant="secondary" size="sm" className="h-9" disabled={!keyword.trim() || searching}>
					{searching ? t("config.dsh.pluginMarketSearching") : t("config.dsh.pluginMarketSearch")}
				</Button>
			</form>
			{warnings.length > 0 && <p className="text-micro text-muted-foreground">{warnings.join("；")}</p>}
			{results !== null && results.length === 0 && (
				<div className="grid gap-2 rounded-md border border-border-subtle bg-bg-panel p-3">
					<p className="text-micro text-muted-foreground">{t("config.dsh.pluginMarketEmpty")}</p>
					{keywordLooksLikeSpec && (
						<div className="flex items-center gap-2">
							<Button type="button" variant="secondary" size="sm" className="h-7 gap-1" disabled={installingName !== null} onClick={() => void install(keyword.trim(), false)}>
								<Download className="size-3" aria-hidden="true" />
								{t("config.dsh.pluginMarketInstallExact")}：{keyword.trim()}
							</Button>
						</div>
					)}
				</div>
			)}
			{results !== null && results.length > 0 && (
				<div className="grid gap-2">
					{results.map((entry) => {
						const key = entry.version ? `${entry.name}@${entry.version}` : entry.name;
						const uiOnlyConfirming = confirmUiOnlyName === entry.name;
						return (
							<div key={key} className="grid gap-1.5 rounded-md border border-border-subtle bg-bg-panel p-2.5">
								<div className="flex flex-wrap items-center gap-2">
									<span className="text-caption font-medium text-foreground">{entry.name}</span>
									{entry.version && <span className="text-micro tabular-nums text-muted-foreground">{entry.version}</span>}
									<SourceBadge source={entry.source} />
									{entry.uiOnly && <UiOnlyBadge />}
									<Button type="button" variant={entry.uiOnly && uiOnlyConfirming ? "destructive" : "secondary"} size="sm" className="ml-auto h-7" disabled={installingName !== null} onClick={() => void install(entry.version ? `${entry.name}@${entry.version}` : entry.name, entry.uiOnly)}>
										{installingName === entry.name ? t("config.dsh.pluginMarketInstalling") : entry.uiOnly && uiOnlyConfirming ? t("config.dsh.pluginMarketUiOnlyConfirm") : t("config.dsh.pluginMarketInstall")}
									</Button>
								</div>
								{entry.description && <p className="text-micro text-muted-foreground">{entry.description}</p>}
								{entry.uiOnly && uiOnlyConfirming && <p className="text-micro text-amber-600 dark:text-amber-400">{t("config.dsh.pluginMarketUiOnlyWarning")}</p>}
							</div>
						);
					})}
				</div>
			)}
			<div className="mt-2 grid gap-2">
				<div className="flex items-center gap-2">
					<h4 className="text-caption font-semibold text-foreground">{t("config.dsh.pluginMarketInstalledTitle")}</h4>
					<span className="text-micro tabular-nums text-muted-foreground">{installed.length}</span>
					<Button type="button" variant="ghost" size="sm" className="ml-auto h-6 gap-1 px-2 text-muted-foreground" onClick={() => void loadInstalled()}>
						<RefreshCw className="size-3" aria-hidden="true" />
						{t("common.refresh")}
					</Button>
				</div>
				{installedLoading ? (
					<p className="text-micro text-muted-foreground">…</p>
				) : installed.length === 0 ? (
					<p className="text-micro text-muted-foreground">{t("config.dsh.pluginMarketInstalledEmpty")}</p>
				) : (
					<div className="grid gap-1.5">
						{installed.map((entry) => (
							<div key={entry.rowId} className="flex flex-wrap items-center gap-2 rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2">
								<span className="text-caption font-medium text-foreground">{entry.packageName ?? entry.rowId}</span>
								{entry.version && <span className="text-micro tabular-nums text-muted-foreground">{entry.version}</span>}
								{entry.uiOnly && <UiOnlyBadge />}
								<Button type="button" variant={confirmUninstallRowId === entry.rowId ? "destructive" : "ghost"} size="sm" className="ml-auto h-6 text-muted-foreground" disabled={uninstalling} onClick={() => void uninstall(entry)}>
									<Trash2 className="size-3" aria-hidden="true" />
									{t(confirmUninstallRowId === entry.rowId ? "config.dsh.pluginUserConfirmUninstall" : "config.dsh.pluginUserUninstall")}
								</Button>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

/** 来源徽标：官方市场（策展目录）与 npm（registry 搜索）双通道。 */
function SourceBadge(props: { source: "market" | "npm" }) {
	if (props.source === "market") {
		return (
			<Badge variant="outline" className="shrink-0 border-sky-300/70 bg-sky-500/10 font-medium text-sky-700 dark:border-sky-700/70 dark:text-sky-300">
				<Globe className="mr-1 size-2.5" aria-hidden="true" />
				{t("config.dsh.pluginMarketSourceMarket")}
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="shrink-0 border-border-subtle text-muted-foreground">
			{t("config.dsh.pluginMarketSourceNpm")}
		</Badge>
	);
}

/** UI-only 徽标：主要提供 DSH Web 界面功能（headless 无可见效果）。 */
function UiOnlyBadge() {
	return (
		<Badge variant="outline" className="shrink-0 border-amber-300/70 bg-amber-500/10 font-medium text-amber-700 dark:border-amber-700/70 dark:text-amber-300">
			{t("config.dsh.pluginMarketUiOnlyBadge")}
		</Badge>
	);
}
