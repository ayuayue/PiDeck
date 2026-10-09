import { Button } from "../components/ui-shadcn/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../components/ui-shadcn/table";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Loader2, ShoppingBag, ToggleLeft, ToggleRight, Hammer } from "lucide-react";
import type { PiCliUpdateResult, PiExtensionListResult, PiExtensionSummary, ProjectResourceOverrides } from "../../../shared/types";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { writeClipboard } from "../utils/clipboard";
import { ExtensionStoreTab } from "./ExtensionStoreTab";
import { PluginDevSection } from "./PluginDevSection";
import { ContentTabs } from "./ContentTabs";
import { isProjectDiscoverySource, projectInstalledExtensionSources, type ResourceScope } from "./resourceScopeModel";
import { buildProjectOverrideKeyIndex, matchesProjectOverride, type ProjectOverrideKeyIndex } from "./projectOverrideKeys";
import { useResourceTogglePending } from "../hooks/useResourceTogglePending";
import { DiscoveredExtensionRow, ExtensionTableRow } from "./extensionsTableRows";
import { RecommendedPackagesPanel } from "./extensionsRecommendedPackages";
import { BuiltInExtensionsUpdatePanel } from "./BuiltInExtensionsUpdatePanel";
import { PiBuiltinExtensionsPanel } from "./PiBuiltinExtensionsPanel";

type ExtensionsApi = {
	list: () => Promise<PiExtensionListResult>;
	uninstall: (source: string, scope?: "user" | "project" | "unknown") => Promise<void>;
	install: (source: string, projectId?: string) => Promise<string>;
	toggle: (source: string, enabled: boolean, scope?: "user" | "project" | "unknown", path?: string, projectId?: string) => Promise<void>;
	removeBuiltIn: (source: string) => Promise<void>;
	update: () => Promise<PiCliUpdateResult>;
	updateOne: (source: string) => Promise<PiCliUpdateResult>;
};

function getExtensionsApi(): ExtensionsApi {
	const api = (window as unknown as { piDesktop?: { extensions?: ExtensionsApi } }).piDesktop?.extensions;
	if (!api) throw new Error("PiDeck extensions API is not available");
	return api;
}

/** 把 IPC/主进程异常转成可读文本，避免内置扩展操作退回原生 alert。 */
function formatExtensionError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 从扩展来源提取简短描述名 */
function shortName(source: string): string {
	return source
		.replace(/^(?:npm|file|github|git|https?):/i, "")
		.replace(/\.ts$/, "")
		.replace(/@[^/]+\//, "");
}

/** 开关乐观覆盖的行身份：scope + source（同名扩展可在 user/project 两级各自独立开关）。 */
function extensionToggleKey(extension: Pick<PiExtensionSummary, "scope" | "source">): string {
	return `${extension.scope}:${extension.source}`;
}

/** 行上显示的启用状态：项目视图里继承来的全局扩展再叠加项目级禁用。 */
function resolveExtensionEnabled(extension: PiExtensionSummary, inherited: boolean, disabledGlobalSources: ProjectOverrideKeyIndex): boolean {
	return extension.enabled !== false && !(inherited && matchesProjectOverride(disabledGlobalSources, extension.path ?? extension.source));
}

export function ExtensionsTab(props: {
	scope: ResourceScope;
	/** Project id used by the extension store; global scope passes undefined. */
	projectId?: string;
	scopeSelector?: ReactNode;
	projectOverrides: ProjectResourceOverrides;
	/** 运行时发现（package/settings 声明）的扩展只读描述。 */
	discoveryExtensions: Array<{
		source: string;
		path: string;
		sourceId: string;
		sourceLabel: string;
		physicalScope: "user" | "project";
		enabled: boolean;
		managed: boolean;
	}>;
	data: PiExtensionListResult;
	loading: boolean;
	uninstallingSource: string | null;
	onRefresh: () => void | Promise<void>;
	/** 开关后的刷新：走轻量路径（不清主进程缓存，仅重算 enabled），避免开关行长时间 pending。缺省回退 onRefresh。 */
	onRefreshAfterToggle?: () => void | Promise<void>;
	onToggle?: (extension: PiExtensionSummary, enabled: boolean) => void | Promise<void>;
	onUninstall: (extension: PiExtensionSummary) => void;
	onShowInFolder: (extension: PiExtensionSummary) => void;
}) {
	// 一级 tab：已安装 / 扩展商店（与 SkillsTab 的「本地/商店」结构对齐）
	const [extTab, setExtTab] = useState<"local" | "store" | "dev">("local");
	const [removingBuiltIn, setRemovingBuiltIn] = useState<string | null>(null);
	// 开关的乐观覆盖：点击立刻翻转显示，写盘 + 刷新结束后清掉（时间线不再等全量刷新）。
	const { begin, end, settle, shown, isPending } = useResourceTogglePending();
	// 首次加载或列表刷新时展示扩展冲突通知
	useEffect(() => {
		if (!props.data.conflicts || props.data.conflicts.length === 0) return;
		for (const c of props.data.conflicts) {
			showNotice(
				t("config.extensionConflict", {
					builtIn: shortName(c.builtIn),
					thirdParty: shortName(c.thirdParty),
				}),
				8000,
				"warning",
			);
		}
	}, [props.data.conflicts]);

	const handleRemoveBuiltIn = async (extension: PiExtensionSummary) => {
		if (removingBuiltIn) return;
		setRemovingBuiltIn(extension.source);
		try {
			await getExtensionsApi().removeBuiltIn(extension.source);
			props.onRefresh();
		} catch (e) {
			showNotice(t("config.extensionOperationFailed", { error: formatExtensionError(e) }), 4500, "error");
		} finally {
			setRemovingBuiltIn(null);
		}
	};

	/** 禁用/启用扩展：项目视图的全局继承行走项目覆盖，其余写 PiDeck settings 禁用列表。 */
	const handleToggle = async (extension: PiExtensionSummary, nextEnabled?: boolean) => {
		const key = extensionToggleKey(extension);
		const enabled = nextEnabled ?? extension.enabled === false;
		// 点击即翻转（乐观覆盖），写盘与刷新结束后由 finally 清掉；进行中的行不再接受第二次点击。
		if (!begin(key, enabled)) return;
		try {
			if (props.onToggle) {
				await props.onToggle(extension, enabled);
			} else {
				// 回退路径也要带 path + projectId：本地文件扩展的原生规则要精确路径，项目作用域要 projectId，
				// 缺一个就会写出 pi 匹配不上的规则（或直接报「Project scope requires a project id.」）。
				await getExtensionsApi().toggle(extension.source, enabled, extension.scope, extension.path, props.projectId);
			}
			// 必须等刷新落地再往下走：清除覆盖只发生在真值已经跟上之后，否则开关会先弹回旧值。
			// 用轻量刷新（forceRefresh=false）：开关不改结构，重扫描（pi list + npm view）只是白等。
			await (props.onRefreshAfterToggle ?? props.onRefresh)();
			showNotice(t(enabled ? "config.extensionEnabledToast" : "config.extensionDisabledToast", { name: shortName(extension.source) }), 3500);
		} catch (e) {
			showNotice(t("config.extensionOperationFailed", { error: formatExtensionError(e) }), 4500, "error");
		} finally {
			end(key);
		}
	};
	const [updating, setUpdating] = useState<string | null>(null);
	const [updateResult, setUpdateResult] = useState<PiCliUpdateResult | null>(null);
	const [showUpdateDialog, setShowUpdateDialog] = useState(false);
	// 单扩展更新进行中的 source（与批量更新互斥，同一时间只跑一个 pi update）
	const [updatingOne, setUpdatingOne] = useState<string | null>(null);

	const handleUpdateExtensions = async () => {
		setUpdating("all");
		setUpdateResult(null);
		setShowUpdateDialog(true);
		try {
			const result = await getExtensionsApi().update();
			setUpdateResult(result);
		} catch (e) {
			showNotice(t("config.extensionOperationFailed", { error: formatExtensionError(e) }), 4500, "error");
		} finally {
			setUpdating(null);
		}
	};

	/** 更新单个扩展（`pi update <source>`），完成后强制刷新列表拿新版本。 */
	const handleUpdateOne = async (extension: PiExtensionSummary) => {
		if (updatingOne) return;
		setUpdatingOne(extension.source);
		try {
			await getExtensionsApi().updateOne(extension.source);
			props.onRefresh();
			showNotice(t("config.extensionUpdatedToast", { name: shortName(extension.source) }), 3000);
		} catch (e) {
			showNotice(t("config.extensionOperationFailed", { error: formatExtensionError(e) }), 4500, "error");
		} finally {
			setUpdatingOne(null);
		}
	};

	/** 复制单扩展更新指令到剪贴板，用户可在终端手动执行。 */
	const handleCopyUpdateCommand = (extension: PiExtensionSummary) => {
		const command = `pi update ${extension.source}`;
		void writeClipboard(command);
		showNotice(t("config.extensionUpdateCommandCopied", { command }), 2500);
	};

	const projectExtensions = props.data.extensions.filter((extension) => extension.scope === "project");
	const globalExtensions = props.data.extensions.filter((extension) => extension.scope !== "project");
	const visibleExtensions = props.scope === "project" ? [...projectExtensions, ...globalExtensions] : globalExtensions;
	const disabledGlobalSources = buildProjectOverrideKeyIndex(props.projectOverrides.disabledGlobalExtensions);
	// discovery 行去重：与已安装列表同 source 的条目只保留普通行（带操作），列表只显示一次
	const installedSources = new Set(props.data.extensions.map((extension) => extension.source));
	const uniqueDiscoveryExtensions = props.discoveryExtensions.filter((item) => !installedSources.has(item.source));
	// 商店卡片的已安装判据：项目里安装的包只在 discovery（package-project）里，不进 data.extensions，
	// 不并入就会让装完的卡片仍显示「安装」并再次触发 pi install -l（见 projectInstalledExtensionSources）。
	const storeInstalledSources = useMemo(() => (props.scope === "project" ? projectInstalledExtensionSources(props.data.extensions, props.discoveryExtensions) : new Set(props.data.extensions.map((extension) => extension.source))), [props.scope, props.data.extensions, props.discoveryExtensions]);
	// 数据回落后结算乐观覆盖：真值等于目标值才清除（写盘与刷新是两条链路，不能一写完就清）。
	useEffect(() => {
		const derived: Record<string, boolean | undefined> = {};
		for (const extension of props.data.extensions) {
			derived[extensionToggleKey(extension)] = resolveExtensionEnabled(extension, props.scope === "project" && extension.scope !== "project", disabledGlobalSources);
		}
		settle(derived);
	}, [props.data, props.scope, props.projectOverrides, settle, disabledGlobalSources]);
	const renderExtensionRows = (extensions: PiExtensionSummary[], inherited: boolean) =>
		extensions.map((extension) => {
			return (
				<ExtensionTableRow
					key={`${extension.scope}:${extension.id}`}
					extension={extension}
					effectiveEnabled={shown(extensionToggleKey(extension), resolveExtensionEnabled(extension, inherited, disabledGlobalSources))}
					inherited={inherited}
					uninstalling={props.uninstallingSource === extension.source}
					onUninstall={props.onUninstall}
					onRemoveBuiltIn={handleRemoveBuiltIn}
					removingBuiltIn={removingBuiltIn === extension.source}
					toggling={isPending(extensionToggleKey(extension))}
					onToggle={handleToggle}
					updatingOne={updatingOne === extension.source}
					onUpdateOne={handleUpdateOne}
					onCopyUpdateCommand={handleCopyUpdateCommand}
					onShowInFolder={props.onShowInFolder}
				/>
			);
		});

	return (
		<div className="extensions-tab">
			{/* pi 原生内置扩展开关：写 settings.json 的 builtin: 条目，全局/项目各自生效 */}
			<PiBuiltinExtensionsPanel scope={props.scope} projectId={props.projectId} onChanged={props.onRefresh} />
			{/* 一级 tab：已安装 / 扩展商店（shadcn Tabs，与 SkillsTab 的「本地/商店」结构对齐） */}
			<div className="mb-3 flex items-center justify-between gap-3">
				<ContentTabs
					value={extTab}
					onValueChange={(v) => {
						if (v !== "local" && v !== "store" && v !== "dev") return;
						setExtTab(v);
						// 切回本地时刷新列表（原 TabsTrigger onClick 行为迁到 onValueChange 统一处理）
						if (v === "local") props.onRefresh();
					}}
					items={[{ value: "local", label: t("config.nav.extensions") }, { value: "store", label: t("config.extensionStoreTab"), icon: <ShoppingBag size={14} strokeWidth={1.8} /> }, ...(props.scope === "global" ? [{ value: "dev", label: t("config.pluginDevTab"), icon: <Hammer size={14} strokeWidth={1.8} /> }] : [])]}
				/>
				{/* 全局下拉：商店 tab 右侧、Tabs 行内（不进 Table） */}
				<div className="shrink-0">{props.scopeSelector}</div>
			</div>
			{extTab === "dev" ? (
				<PluginDevSection />
			) : extTab === "store" ? (
				<ExtensionStoreTab installedSources={storeInstalledSources} projectId={props.scope === "project" ? props.projectId : undefined} onInstalled={() => props.onRefresh()} />
			) : (
				<>
					{showUpdateDialog && (
						<div className="config-update-dialog-backdrop" role="dialog" aria-modal="true">
							<div className="config-update-dialog">
								<div className="config-update-dialog-header">
									<strong>{t("settings.updateExtensionsAll")}</strong>
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-7"
										onClick={() => {
											setShowUpdateDialog(false);
											props.onRefresh();
										}}
										disabled={Boolean(updating)}
									>
										×
									</Button>
								</div>
								<p className="config-im-form-hint">{updating ? t("settings.extensionsUpdatingDesc") : t("settings.extensionsUpdateResultHint")}</p>
								<pre className="setting-update-output">{updateResult ? `${updateResult.command}\n${updateResult.output}` : t("settings.extensionsUpdating")}</pre>
								<div className="config-update-dialog-actions">
									<Button
										variant="default"
										size="sm"
										onClick={() => {
											setShowUpdateDialog(false);
											props.onRefresh();
										}}
										disabled={Boolean(updating)}
									>
										{t("common.close")}
									</Button>
								</div>
							</div>
						</div>
					)}
					{false && <RecommendedPackagesPanel data={props.data} onRefresh={props.onRefresh} />}

					{/* 已安装扩展列表 */}
					<div className="config-section">
						<h3 className="extensions-installed-title mb-2 text-sm font-semibold tracking-tight text-foreground">{t("config.installedExtensions")}</h3>
						<div className="mb-3 mt-2 flex items-center justify-between gap-3">
							<div className="min-w-0">
								<span className="font-mono text-xs tabular-nums text-muted-foreground">{t("config.count.extensions", { count: visibleExtensions.length })}</span>
								<small className="skills-restart-hint block text-caption text-muted-foreground">{t("config.extensionRestartHint")}</small>
							</div>
							{/* 窄窗口下按钮换行而不是被裁掉：shrink-0 保证按钮不被压缩，
				    flex-wrap + justify-end 让溢出部分落到第二行右对齐 */}
							<div className="skills-toolbar-actions flex shrink-0 flex-wrap items-center justify-end gap-1.5">
								{props.scope === "global" ? (
									<>
										{/* 工具栏统一 size=sm，与设置页/会话顶栏控件高度对齐 */}
										<Button variant="outline" size="sm" onClick={handleUpdateExtensions} disabled={props.loading || Boolean(updating)}>
											{updating ? t("settings.updating") : t("settings.updateExtensionsAll")}
										</Button>
									</>
								) : null}
								<Button variant="outline" size="sm" onClick={props.onRefresh} disabled={props.loading}>
									{t("common.refresh")}
								</Button>
							</div>
						</div>
						{/* 内置扩展版本 + 热更新：包级版本号（不跟应用版本走），检测走 AtomGit 清单。
				    只放全局作用域——内置扩展是全局资源，项目视图里给「更新」入口会误导。 */}
						{props.scope === "global" && <BuiltInExtensionsUpdatePanel onApplied={props.onRefresh} />}
						{/* 刷新（停用/启用、卸载、手动刷新）期间必须保持表格挂载：loading 占位会把内容高度骤缩，
						    浏览器随即把 .config-content 的 scrollTop 夹到 0，用户每次操作都要从头滚回原区间，
						    聚焦的开关按钮也会随行卸载而失焦（与 ModelsTab 的 silent 回读同一类问题）。
						    仅当还没有任何数据可显示时才让位给加载占位；刷新中沿用旧表格，行高不变、视口与焦点都留在原处。 */}
						<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
							{props.loading && visibleExtensions.length === 0 ? (
								<div className="flex items-center justify-center gap-2 py-12 text-control text-muted-foreground">
									<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
									{t("config.loadingExtensions")}
								</div>
							) : visibleExtensions.length === 0 ? (
								<div className="py-12 text-center text-control text-muted-foreground">{t("config.emptyExtensions")}</div>
							) : (
								<Table>
									<TableHeader>
										<TableRow>
											<TableHead>{t("config.extension")}</TableHead>
											<TableHead>{t("config.extensionVersion")}</TableHead>
											<TableHead className="w-28 text-right">{t("config.actions")}</TableHead>
										</TableRow>
									</TableHeader>
									<TableBody>
										{props.scope === "project" && projectExtensions.length > 0 ? (
											<TableRow>
												<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
													{t("config.resourceGroup.project")}
												</TableCell>
											</TableRow>
										) : null}
										{props.scope === "project" ? renderExtensionRows(projectExtensions, false) : null}
										{props.scope === "project" && uniqueDiscoveryExtensions.filter((item) => isProjectDiscoverySource(item.sourceId)).map((item) => <DiscoveredExtensionRow key={`discovered:${item.path}`} item={item} />)}
										{props.scope === "project" && globalExtensions.length > 0 ? (
											<TableRow>
												<TableCell colSpan={3} className="bg-bg-hover px-3 py-1.5 text-caption font-semibold text-foreground">
													{t("config.resourceGroup.global")}
												</TableCell>
											</TableRow>
										) : null}
										{renderExtensionRows(globalExtensions, props.scope === "project")}
										{props.scope === "project" && uniqueDiscoveryExtensions.filter((item) => !isProjectDiscoverySource(item.sourceId)).map((item) => <DiscoveredExtensionRow key={`discovered:${item.path}`} item={item} />)}
									</TableBody>
								</Table>
							)}
						</div>
					</div>
				</>
			)}
		</div>
	);
}
