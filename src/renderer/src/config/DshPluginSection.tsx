import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { ChevronDown, ChevronRight, Play, Plus, RefreshCw, Search, Square, Trash2, X } from "lucide-react";
import type { DshPluginView, DshStaticPluginView } from "../../../shared/types";
import { sessionRecordsAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { t, type TranslationKey } from "../i18n";
import { showNotice } from "../utils/notice";
import { Badge } from "../components/ui-shadcn/badge";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Pagination } from "../components/ui-shadcn/pagination";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../components/ui-shadcn/select";
import { Textarea } from "../components/ui-shadcn/textarea";

/** 静态 Loader 清单每页行数（合并后一模块一行；分页避免只读长列表刷屏）。 */
const STATIC_PAGE_SIZE = 20;

/** 来源筛选值（all = 不过滤）。 */
type OriginFilter = "all" | "user" | "builtin";

/**
 * 动态 Cordis 插件管理区（G13 深化）。
 *
 * 语义（与 dsh-tool-cordis 一致，见 src/main/dsh/pideckPluginBridge.ts）：
 * - 动态插件是进程内临时扩展：define 不落盘、重启即失、按会话归属；
 * - 运行/停止/卸载都是面板手势（requestId=null，无需审批）；
 * - Host 源码在 DSH host 进程内执行——运行器明示不是安全边界，仅安装自己编写的代码。
 * 静态 Loader 只读清单已拆到「插件列表」子 tab（PluginInventoryView）。
 */
export function DshPluginSection() {
	const records = useAtomValue(sessionRecordsAtom);
	const dshSessions = useMemo(
		() => Object.values(records).filter((record) => record.backend === "dsh" && record.dshSessionId),
		[records],
	);
	const [dynamicPlugins, setDynamicPlugins] = useState<DshPluginView[]>([]);
	const [showInstall, setShowInstall] = useState(false);
	/** 两步确认卸载：第一次点击进入确认态，第二次执行。 */
	const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const loadPlugins = useCallback(async () => {
		try {
			const dynamic = await desktopApi.sessions.listDshDynamicPlugins();
			setDynamicPlugins(dynamic);
		} catch {
			// host 未装配/未启动：保持空
		}
	}, []);

	useEffect(() => {
		void loadPlugins();
	}, [loadPlugins]);

	const sessionTitle = (agentId: string): string => {
		const record = dshSessions.find((candidate) => candidate.dshSessionId === agentId);
		return record?.title ?? agentId;
	};

	const runPlugin = async (plugin: DshPluginView) => {
		const packageId = plugin.currentPackageId ?? plugin.packages[plugin.packages.length - 1]?.packageId;
		if (!packageId) {
			showNotice(t("config.dsh.pluginNoPackage"), 3000);
			return;
		}
		setBusy(true);
		try {
			await desktopApi.sessions.runDshPlugin({
				sessionId: plugin.agentId,
				pluginId: plugin.pluginId,
				packageId,
				mode: plugin.currentPackageId === packageId ? "run" : "update",
			});
			showNotice(t("config.dsh.pluginRunStarted"), 3000);
			await loadPlugins();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const stopPlugin = async (plugin: DshPluginView) => {
		setBusy(true);
		try {
			await desktopApi.sessions.stopDshPlugin({ sessionId: plugin.agentId, pluginId: plugin.pluginId });
			showNotice(t("config.dsh.pluginStoppedToast"), 3000);
			await loadPlugins();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	const uninstallPlugin = async (plugin: DshPluginView) => {
		if (confirmUninstallId !== plugin.pluginId) {
			setConfirmUninstallId(plugin.pluginId);
			return;
		}
		setConfirmUninstallId(null);
		setBusy(true);
		try {
			await desktopApi.sessions.uninstallDshPlugin({ sessionId: plugin.agentId, pluginId: plugin.pluginId });
			showNotice(t("config.dsh.pluginUninstalled"), 3000);
			await loadPlugins();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setBusy(false);
		}
	};

	return (
		<section className="grid gap-2">
			<h3 className="text-caption font-semibold text-muted-foreground">{t("config.dsh.dynamicPlugins")}</h3>
			<p className="text-micro text-muted-foreground">{t("config.dsh.dynamicPluginsHint")}</p>
			<div className="flex items-center gap-2">
				<Button type="button" variant="secondary" size="sm" className="h-7" onClick={() => setShowInstall((prev) => !prev)}>
					{showInstall ? <X className="size-3.5" aria-hidden="true" /> : <Plus className="size-3.5" aria-hidden="true" />}
					{t("config.dsh.installPlugin")}
				</Button>
				<Button type="button" variant="ghost" size="sm" className="h-7 text-muted-foreground" onClick={() => void loadPlugins()}>
					<RefreshCw className="size-3.5" aria-hidden="true" />
					{t("common.refresh")}
				</Button>
			</div>
			{showInstall && (
				<InstallPluginForm
					sessions={dshSessions.map((record) => ({ sessionId: record.dshSessionId as string, title: record.title }))}
					onInstalled={() => {
						setShowInstall(false);
						void loadPlugins();
					}}
				/>
			)}
			{dynamicPlugins.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.dynamicPluginsEmpty")}</p>
			) : (
				<div className="grid gap-1.5">
					{dynamicPlugins.map((plugin) => (
						<div
							key={plugin.pluginId}
							className="rounded-md border border-border-subtle bg-bg-panel px-2.5 py-2"
						>
							<div className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate text-control font-medium text-foreground">
									{plugin.packages[0]?.name || plugin.pluginId}
								</span>
								<span className={`shrink-0 rounded-full border px-2 py-0.5 text-micro ${plugin.activeRun
									? "border-emerald-300/70 bg-emerald-500/10 text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300"
									: "border-border-subtle text-muted-foreground"}`}
								>
									{plugin.activeRun ? t("config.dsh.pluginRunning") : t("config.dsh.pluginStopped")}
								</span>
							</div>
							<div className="mt-0.5 flex items-center gap-2 text-caption text-text-secondary">
								<span className="min-w-0 truncate">{plugin.pluginId}</span>
								<span className="shrink-0">·</span>
								<span className="min-w-0 truncate">{t("config.dsh.pluginSession")}: {sessionTitle(plugin.agentId)}</span>
								{plugin.status && (
									<>
										<span className="shrink-0">·</span>
										<span className="shrink-0">{plugin.status}</span>
									</>
								)}
							</div>
							{plugin.error && (
								<p className="mt-1 truncate text-micro text-danger" title={plugin.error}>{plugin.error}</p>
							)}
							<div className="mt-1.5 flex items-center gap-1.5">
								<Button type="button" variant="secondary" size="sm" className="h-6" disabled={busy || Boolean(plugin.activeRun)} onClick={() => void runPlugin(plugin)}>
									<Play className="size-3" aria-hidden="true" />
									{t("config.dsh.pluginRun")}
								</Button>
								<Button type="button" variant="secondary" size="sm" className="h-6" disabled={busy || !plugin.activeRun} onClick={() => void stopPlugin(plugin)}>
									<Square className="size-3" aria-hidden="true" />
									{t("config.dsh.pluginStop")}
								</Button>
								<Button
									type="button"
									variant={confirmUninstallId === plugin.pluginId ? "destructive" : "ghost"}
									size="sm"
									// 确认态走 destructive 白字；ghost 态才用弱化的 muted 前景
									className={confirmUninstallId === plugin.pluginId ? "h-6" : "h-6 text-muted-foreground"}
									disabled={busy}
									onClick={() => void uninstallPlugin(plugin)}
								>
									<Trash2 className="size-3" aria-hidden="true" />
									{t(confirmUninstallId === plugin.pluginId ? "config.dsh.pluginConfirmUninstall" : "config.dsh.pluginUninstall")}
								</Button>
							</div>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

/** 模块短名：去掉 @scope/、cordis:、cordis-plugin-、dsh-host-/dsh-client- 前缀（对齐 dsh-web moduleShortName）。 */
function moduleShortName(moduleName: string): string {
	return (moduleName.startsWith("@") ? moduleName.slice(moduleName.indexOf("/") + 1) : moduleName)
		.replace(/^cordis:/, "")
		.replace(/^cordis-plugin-/, "")
		.replace(/^dsh-(?:host-|client-)?/, "");
}

/** fiberPhase → 本地化文案 key（对齐 dsh-web PHASE_KEYS；null 视为未挂载）。 */
const PHASE_KEYS: Record<string, TranslationKey> = {
	pending: "config.dsh.pluginPhasePending",
	loading: "config.dsh.pluginPhaseLoading",
	active: "config.dsh.pluginPhaseActive",
	failed: "config.dsh.pluginPhaseFailed",
	unloading: "config.dsh.pluginPhaseUnloading",
};

/** 状态点颜色：启用且已挂载为绿、失败为红、过渡中为黄、其余为灰。 */
function phaseDotClass(fiberPhase: string | null, enabled: boolean): string {
	if (!enabled) return "bg-border";
	switch (fiberPhase) {
		case "active": return "bg-emerald-500";
		case "failed": return "bg-danger";
		case "pending":
		case "loading":
		case "unloading": return "bg-amber-500";
		default: return "bg-border";
	}
}

/** fiberPhase 本地化文案（null = 未挂载）。 */
function phaseLabel(fiberPhase: string | null): string {
	if (fiberPhase === null) return t("config.dsh.pluginPhaseUnobserved");
	return t(PHASE_KEYS[fiberPhase] ?? "config.dsh.pluginPhaseUnobserved");
}

/** 条目是否匹配搜索（对齐 dsh-web：按 moduleName / entryId 不区分大小写包含匹配）。 */
function matchesEntry(entry: DshStaticPluginView, normalizedQuery: string): boolean {
	if (normalizedQuery.length === 0) return true;
	return [entry.moduleName, entry.entryId].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}

/** 来源徽标：user = 用户安装（强调色），builtin = 自带（中性色）。 */
function OriginBadge(props: { origin: "builtin" | "user" | undefined }) {
	if (props.origin === "user") {
		return (
			<Badge variant="outline" className="shrink-0 border-sky-300/70 bg-sky-500/10 font-medium text-sky-700 dark:border-sky-700/70 dark:text-sky-300">
				{t("config.dsh.pluginOriginUser")}
			</Badge>
		);
	}
	return (
		<Badge variant="outline" className="shrink-0 border-border-subtle text-muted-foreground">
			{t("config.dsh.pluginOriginBuiltin")}
		</Badge>
	);
}

/**
 * 插件列表视图（对齐 dsh-web 的 plugin-inventory tab）：静态 Loader 清单以 2 列卡片网格展示
 * （模块短名 + 来源徽标 + 启用标签 + fiberPhase 状态点），顶部搜索框按 moduleName/entryId 过滤、
 * 来源筛选（全部/用户安装/自带）；用户安装的条目可就地卸载（从 $DSH_HOME/cordis.patch.yml
 * 移除行 + 可选回收插件目录，host 重启后生效）。保留分页避免长列表刷屏。
 */
export function PluginInventoryView() {
	const [entries, setEntries] = useState<DshStaticPluginView[]>([]);
	const [query, setQuery] = useState("");
	const [expandedId, setExpandedId] = useState<string | null>(null);
	/** 静态 Loader 清单当前页（1 基；数据/搜索变化导致页数收缩时展示层负责收敛）。 */
	const [page, setPage] = useState(1);
	/** 首次加载态（仅控制列表文案；刷新按钮可随时重拉）。 */
	const [loading, setLoading] = useState(true);
	/** 来源筛选（all = 不过滤）。 */
	const [originFilter, setOriginFilter] = useState<OriginFilter>("all");
	/** 两步确认卸载：第一次点击进入确认态，第二次执行。 */
	const [confirmUninstallId, setConfirmUninstallId] = useState<string | null>(null);
	const [uninstalling, setUninstalling] = useState(false);

	/** 拉取静态 Loader 清单：挂载与手动刷新共用；失败保持现值不清空。 */
	const load = useCallback(async () => {
		try {
			const list = await desktopApi.sessions.listDshStaticPlugins();
			setEntries(list);
		} catch {
			// host 未装配/未启动：保持空
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const normalizedQuery = query.trim().toLocaleLowerCase();
	const filtered = useMemo(
		() =>
			entries.filter(
				(entry) =>
					matchesEntry(entry, normalizedQuery) &&
					(originFilter === "all" || (entry.origin ?? "builtin") === originFilter),
			),
		[entries, normalizedQuery, originFilter],
	);

	// 展开项被搜索过滤掉时自动收起（对齐 dsh-web）；两步确认态一并复位
	useEffect(() => {
		if (expandedId !== null && !filtered.some((entry) => entry.entryId === expandedId)) {
			setExpandedId(null);
			setConfirmUninstallId(null);
		}
	}, [expandedId, filtered]);

	/**
	 * 卸载用户自装插件（两步确认后的第二步）：
	 * 主进程从 $DSH_HOME/cordis.patch.yml 移除对应行（先备份），PiDeck 管理目录内的
	 * 插件文件一并移入回收站；成功后重启 DSH host 让移除立即生效。
	 */
	const uninstallUserPlugin = async (entry: DshStaticPluginView) => {
		if (confirmUninstallId !== entry.entryId) {
			setConfirmUninstallId(entry.entryId);
			return;
		}
		setConfirmUninstallId(null);
		setUninstalling(true);
		try {
			const result = await desktopApi.sessions.uninstallDshUserPlugin({
				entryId: entry.entryId,
				moduleName: entry.moduleName,
				deleteFiles: true,
			});
			if (!result.rowRemoved) {
				showNotice(result.reason ?? t("config.dsh.pluginUserUninstallFailed"), 5000);
				return;
			}
			if (result.fileError) {
				showNotice(`${t("config.dsh.pluginUserUninstalled")}（${result.fileError}）`, 6000);
			} else if (result.removedPluginDir) {
				showNotice(t("config.dsh.pluginUserUninstalled"), 5000);
			} else {
				// 文件保留（管理目录之外）：提示语带上插件实际位置，手动删除可直达
				showNotice(
					result.keptPluginDir
						? `${t("config.dsh.pluginFilesKeepHint")}：${result.keptPluginDir}`
						: t("config.dsh.pluginFilesKeepHint"),
					8000,
				);
			}
			try {
				await desktopApi.sessions.restartDshHost();
			} catch {
				showNotice(t("config.dsh.pluginHostRestartFailed"), 5000);
			}
			await load();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 5000);
		} finally {
			setUninstalling(false);
		}
	};

	const totalPages = Math.max(1, Math.ceil(filtered.length / STATIC_PAGE_SIZE));
	const pageClamped = Math.min(page, totalPages);
	const pageRows = filtered.slice((pageClamped - 1) * STATIC_PAGE_SIZE, pageClamped * STATIC_PAGE_SIZE);

	return (
		<div className="grid gap-2.5">
			<label className="relative block">
				<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
				<Input
					type="search"
					value={query}
					onChange={(event) => {
						setQuery(event.currentTarget.value);
						setPage(1);
					}}
					placeholder={t("config.dsh.pluginSearchPlaceholder")}
					className="h-9 pl-8"
				/>
			</label>
			<div className="flex items-center gap-2">
				<Select value={originFilter} onValueChange={(value) => { setOriginFilter(value as OriginFilter); setPage(1); }}>
					<SelectTrigger className="h-8 w-40">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="all">{t("config.dsh.pluginFilterAll")}</SelectItem>
						<SelectItem value="user">{t("config.dsh.pluginFilterUser")}</SelectItem>
						<SelectItem value="builtin">{t("config.dsh.pluginFilterBuiltin")}</SelectItem>
					</SelectContent>
				</Select>
				<div className="flex items-baseline gap-2">
					<h3 className="text-caption font-semibold text-foreground">{t("config.dsh.tab.pluginList")}</h3>
					<span className="text-micro tabular-nums text-muted-foreground">{filtered.length}</span>
				</div>
				{/* 手动刷新：dsh-web 等外部安装/启停插件后（host 重启生效）无需重开配置页即可重拉清单 */}
				<Button
					type="button"
					variant="ghost"
					size="sm"
					className="ml-auto h-6 gap-1 px-2 text-muted-foreground"
					onClick={() => void load()}
				>
					<RefreshCw className="size-3" aria-hidden="true" />
					{t("common.refresh")}
				</Button>
			</div>
			{loading ? (
				<p className="text-micro text-muted-foreground">{t("common.loading")}</p>
			) : entries.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.staticPluginsEmpty")}</p>
			) : filtered.length === 0 ? (
				<p className="text-micro text-muted-foreground">{t("config.dsh.pluginNoMatch")}</p>
			) : (
				<ul className="grid grid-cols-2 items-start gap-2.5 max-[900px]:grid-cols-1">
					{pageRows.map((entry) => {
						const title = moduleShortName(entry.moduleName);
						const open = expandedId === entry.entryId;
						const detailId = `dsh-plugin-inventory-${entry.entryId}`;
						return (
							<li key={entry.entryId} className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
								<button
									type="button"
									className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
									aria-expanded={open}
									aria-controls={detailId}
									onClick={() => setExpandedId(open ? null : entry.entryId)}
								>
								<span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground" title={entry.moduleName}>
									{title}
								</span>
								<OriginBadge origin={entry.origin} />
								{entry.enabled ? (
										<Badge variant="outline" className="shrink-0 border-emerald-300/70 bg-emerald-500/10 font-medium text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
											{t("config.dsh.pluginEnabled")}
										</Badge>
									) : (
										<Badge variant="outline" className="shrink-0 border-border-subtle text-muted-foreground">
											{t("config.dsh.pluginDisabled")}
										</Badge>
									)}
									<span
										className={`size-1.5 shrink-0 rounded-full ${phaseDotClass(entry.fiberPhase, entry.enabled)}`}
										role="img"
										aria-label={phaseLabel(entry.fiberPhase)}
										title={phaseLabel(entry.fiberPhase)}
									/>
									{open ? (
										<ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
									) : (
										<ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
									)}
								</button>
								{open && (
									<div id={detailId} className="border-t border-border/40 px-3 py-2.5">
										<code className="block truncate font-mono text-micro text-text-secondary" title={entry.entryId}>
											{entry.entryId}
										</code>
										<dl className="mt-2 grid gap-1 text-micro">
											<div className="flex gap-2">
												<dt className="shrink-0 text-muted-foreground">{t("config.dsh.pluginOriginLabel")}</dt>
												<dd>{entry.origin === "user" ? t("config.dsh.pluginOriginUser") : t("config.dsh.pluginOriginBuiltin")}</dd>
											</div>
											<div className="flex gap-2">
												<dt className="shrink-0 text-muted-foreground">{t("config.dsh.pluginConfigStatus")}</dt>
												<dd>{entry.enabled ? t("config.dsh.pluginEnabled") : t("config.dsh.pluginDisabled")}</dd>
											</div>
											{entry.enabled && (
												<div className="flex gap-2">
													<dt className="shrink-0 text-muted-foreground">{t("config.dsh.pluginCordisStatus")}</dt>
													<dd>{phaseLabel(entry.fiberPhase)}</dd>
												</div>
											)}
										</dl>
										{entry.origin === "user" && (
											<div className="mt-2 flex items-center justify-end gap-1.5">
										<Button
												type="button"
												variant={confirmUninstallId === entry.entryId ? "destructive" : "ghost"}
												size="sm"
												// 确认态走 destructive 白字；ghost 态才用弱化的 muted 前景
												className={confirmUninstallId === entry.entryId ? "h-6" : "h-6 text-muted-foreground"}
												disabled={uninstalling}
												onClick={() => void uninstallUserPlugin(entry)}
											>
													<Trash2 className="size-3" aria-hidden="true" />
													{t(confirmUninstallId === entry.entryId ? "config.dsh.pluginUserConfirmUninstall" : "config.dsh.pluginUserUninstall")}
												</Button>
											</div>
										)}
									</div>
								)}
							</li>
						);
					})}
				</ul>
			)}
			{totalPages > 1 && (
				<Pagination page={pageClamped} totalPages={totalPages} onPageChange={setPage} className="py-1" />
			)}
		</div>
	);
}

/** 安装表单：选择归属会话 + 语义前缀 + 名称/用途 + Host 源码（define，不运行）。 */
function InstallPluginForm(props: {	sessions: Array<{ sessionId: string; title: string }>;
	onInstalled: () => void;
}) {
	const [sessionId, setSessionId] = useState(props.sessions[0]?.sessionId ?? "");
	const [idPrefix, setIdPrefix] = useState("");
	const [name, setName] = useState("");
	const [purpose, setPurpose] = useState("");
	const [hostCode, setHostCode] = useState("");
	const [installing, setInstalling] = useState(false);

	if (props.sessions.length === 0) {
		return <p className="text-micro text-muted-foreground">{t("config.dsh.pluginNoSession")}</p>;
	}

	const install = async () => {
		// 与 host 侧校验一致（idPrefix 3-6 个小写字母；至少一侧源码）
		if (!/^[a-z]{3,6}$/.test(idPrefix)) {
			showNotice(t("config.dsh.pluginIdPrefixHint"), 3000);
			return;
		}
		if (!name.trim() || !purpose.trim() || !hostCode.trim()) {
			showNotice(t("config.dsh.pluginFormIncomplete"), 3000);
			return;
		}
		setInstalling(true);
		try {
			await desktopApi.sessions.installDshPlugin({
				sessionId,
				idPrefix,
				name: name.trim(),
				purpose: purpose.trim(),
				hostCode,
			});
			showNotice(t("config.dsh.pluginInstalled"), 3000);
			props.onInstalled();
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000);
		} finally {
			setInstalling(false);
		}
	};

	return (
		<div className="grid gap-2 rounded-md border border-border-subtle bg-bg-panel p-2.5">
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginSession")}</label>
				<Select value={sessionId} onValueChange={setSessionId}>
					<SelectTrigger className="h-8">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{props.sessions.map((session) => (
							<SelectItem key={session.sessionId} value={session.sessionId}>{session.title}</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginIdPrefix")}</label>
				<Input className="h-8" value={idPrefix} onChange={(event) => setIdPrefix(event.target.value)} />
			</div>
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginName")}</label>
				<Input className="h-8" value={name} onChange={(event) => setName(event.target.value)} />
			</div>
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginPurpose")}</label>
				<Input className="h-8" value={purpose} onChange={(event) => setPurpose(event.target.value)} />
			</div>
			<div className="grid gap-1.5">
				<label className="text-micro text-muted-foreground">{t("config.dsh.pluginHostCode")}</label>
				<Textarea
					className="min-h-24 font-mono text-caption"
					value={hostCode}
					onChange={(event) => setHostCode(event.target.value)}
					placeholder="export default { apply(ctx) { ... } }"
				/>
				<p className="text-micro text-text-tertiary">{t("config.dsh.pluginClientCodeHint")}</p>
			</div>
			<div className="flex justify-end">
				<Button type="button" variant="secondary" size="sm" className="h-7" disabled={installing} onClick={() => void install()}>
					{t("config.dsh.installPlugin")}
				</Button>
			</div>
		</div>
	);
}
