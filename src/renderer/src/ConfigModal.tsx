import { Button } from "./components/ui-shadcn/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui-shadcn/tabs";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "./components/ui-shadcn/dialog";
import { X, Cpu, FileCode2, FileText, KeyRound, Loader2, LogIn, Puzzle, Settings2, Shield, ShieldCheck, Sparkles, PlugZap, FolderOpen } from "lucide-react";
import { cn } from "./lib/utils";
import { WORKBENCH_DIALOG_SIZE_CLASS } from "./components/common/workbenchDialogSize";
import { deepClone } from "./utils/deepEqual";
import { showNotice } from "./utils/notice";
import { formatIpcError } from "./utils/ipcError";
import { applyAdaptiveTemplateReset, collectModelSpecPatches, deriveProviderCompat, mergeAdaptiveModelTemplate } from "./utils/modelSpecAutoFill";
import type { FetchedModel, ConfigProxyMode } from "../../shared/types/fetchedModel";
import { Component, forwardRef, useRef, useState, useEffect, useCallback, useImperativeHandle, useMemo, type ReactNode, type Ref } from "react";
import type { PiDesktopApi } from "../../preload";
import { OAuthTab } from "./config/OAuthTab";
import { ConfigBackendSwitch, ConfigEnvironmentStatus } from "./config/ConfigEnvironmentSwitch";
import { configTabsForTarget, configTargetKey, firstConfigTabForTarget, isConfigTabSupported, resourcePagesSupported, securityPageSupported } from "./config/configEnvironmentModel";
import { hasUnsavedConfigDrafts, preferredConfigTargetForProject, samePiConfigTarget, toSshTargetHosts, toWslTargetHosts, type PiConfigTargetHost } from "./config/piConfigTargetModel";
import { RemoteConfigPanel } from "./config/RemoteConfigPanel";
import { ConfigDiagnosticCard } from "./config/ConfigDiagnosticCard";
import { WslConfigSourceHint } from "./config/WslConfigSourceHint";
import { usePiConfigDir } from "./config/usePiConfigDir";
import { usePiConfigTargetView } from "./config/usePiConfigTargetView";
import { useConfigTransfer } from "./config/useConfigTransfer";
import { resourceTargetErrorMessage } from "./config/resourceTargetErrorCopy";
import { useResourceTarget } from "./config/useResourceTarget";
import type { PiConfigTarget } from "../../shared/piConfig";
import { buildProviderOrderScope } from "./utils/providerOrder";
import { ModelsTab } from "./config/ModelsTab";
import { TokenDancePanel, type TokendanceInstallOutcome } from "./config/TokenDancePanel";
import { UsageProbeConfigDialog } from "./config/UsageProbeConfigDialog";
import { removeSelectedModelIndexes } from "./config/modelBatchSelection";
import { openDocsInSystemBrowser } from "./config/ConfigShared";
import { RawTab } from "./config/RawTab";
import { McpTab, type McpTabHandle } from "./config/McpTab";
import { PromptsTab } from "./config/PromptsTab";
import { SkillsTab } from "./config/SkillsTab";
import { ExtensionsTab } from "./config/ExtensionsTab";
import type { DiscoveredExtensionItem } from "./config/extensionsTableRows";
// 桥贡献的「独立配置页」落点：每个 gui:config.page:* 贡献在「Agent 能力」组里占一个导航页。
// 会话取值 / 落点 id 映射 / 「页消失就回退」都收在 hook 里（PR 评审 §3）。
import { SecuritySection, type SecuritySectionHandle } from "./components/config/SecuritySection";
import { ConfigAuthTab, useConfigAuthEditing } from "./config/configModal/ConfigAuthTab";
import { ConfigSettingsTab, useConfigSettingsEditing } from "./config/configModal/ConfigSettingsTab";
import { ConfigTrustTab, useConfigTrustEditing } from "./config/configModal/ConfigTrustTab";
import { ConfigRawTab, useConfigRawEditing } from "./config/configModal/ConfigRawTab";
import { useConfigEnvSwitch, type PendingEnvSwitch } from "./config/configModal/ConfigEnvSwitch";
import { ConfigModalDialogs, type ConfigDeleteConfirm } from "./config/configModal/ConfigModalDialogs";
import { loadLastConfigBackendPane, loadLastConfigTab, loadLastConfigTarget, normalizeModelsFile, parseJsonObject, parseSectionTabValue, rememberConfigBackendPane, rememberConfigTab, rememberConfigTarget, sameConfigTargetHosts, sectionTabValue, type ConfigSection } from "./config/configModal/configModalStorage";
import { ConfigNavSidebar, type ConfigNavItem } from "./config/configModal/ConfigNavSidebar";
import { useConfigLoader } from "./config/configModal/useConfigLoader";
import { ConfigSkillsTab } from "./config/configModal/ConfigSkillsTab";
import { ConfigModalShell } from "./config/configModal/ConfigModalShell";
import { ConfigMcpTab } from "./config/configModal/ConfigMcpTab";
import { useConfigPromptsEditing } from "./config/configModal/useConfigPromptsEditing";
import { useConfigSkillsEditing } from "./config/configModal/useConfigSkillsEditing";
import { useConfigExtensionsEditing } from "./config/configModal/useConfigExtensionsEditing";
import { useConfigModelsProviderEditing } from "./config/configModal/useConfigModelsProviderEditing";
import { useConfigModelRowsEditing } from "./config/configModal/useConfigModelRowsEditing";
import { modelIdIndex } from "./config/configModal/modelIdIndex";
import { secretHint } from "./components/app/settings/SecretValueInput";
import { DshConfigTab, type DshConfigTabHandle } from "./config/DshConfigTab";
import { t } from "./i18n";
import { CodeMirrorEditor } from "./components/app/CodeMirrorEditor";
import type { AuthFile, ConfigTab, ModelItem, ModelsFile, SettingsFile } from "./config/configTypes";
import type { ConfigFileDiagnostic, PiExtensionListResult, PiExtensionSummary, PiSkillListResult, PiSkillLocation, PiSkillSummary, Project, ProjectResourceDiscoveryResult, ProjectResourceListResult } from "../../shared/types";
import { isGlobalSkillSourceId } from "../../shared/resourceIdentity";
import { emptyDiscoveryData, emptyProjectResourceData, GLOBAL_SKILL_SOURCES, isGlobalSkill, isProjectExtension, isProjectSkill, PROJECT_SKILL_SOURCES, type ResourceScope } from "./config/resourceScopeModel";
import { getModelUserAgentOverride, getProviderHeaders, KNOWN_PROVIDER_ENDPOINTS, pruneModelOverrides, readModelOverrides, setModelUserAgentOverride } from "./config/providerHeaders";
import { TOKENDANCE_PROVIDER } from "../../shared/tokendance";
import { ALL_CONFIG_DIRTY_KEYS, dirtyKeysClearedByReload, dirtyKeysPreservedOnReload, orderDirtyKeysForSave, reconcileConfigDirty } from "./config/configDirtyMarks";
import { modelThinkingLevelOf, replaceModelThinkingLevels, withModelThinkingLevelDefault, withModelThinkingLevelEnabled } from "../../shared/modelThinkingLevels";
import type { ModelThinkingLevel } from "../../shared/modelThinkingLevels";
import { pruneHiddenModelOrphans, replaceProviderHiddenIds, sameHiddenModelEntries, toggleHiddenModelKey } from "./config/hiddenModels";
import type { ProviderModelIdIndex } from "../../shared/types/modelSpecs";
import { formatConfigUnsavedMessage, summarizeConfigUnsavedChanges, type ConfigUnsavedItem } from "./config/configUnsavedChangesSummary";
import { DirtyMarker } from "./components/app/settings/SettingRows";
import { isValidProviderName } from "../../shared/providerName";
import { mergeProviderDraft, type AddProviderDraft } from "./config/addProviderDraft";
import { useAtomValue } from "jotai";
import { dshModuleHiddenAtom, dshRuntimeStatusAtom, projectByIdAtomFamily } from "./atoms";
import { dshUiVisibilityFor } from "../../shared/types/dshRuntime";

const api: PiDesktopApi = (window as unknown as { piDesktop: PiDesktopApi }).piDesktop;

type ConfigModalProps = {
	open: boolean;
	onClose: () => void;
	onSaved: () => void;
	/** 当前项目身份：项目资源 IPC 只接受由主进程登记的 projectId。 */
	projectId?: string;
	/** PiDeck 当前加载的全部项目（作用域下拉展示；Chat 项目除外）。 */
	projects?: Array<{ id: string; name: string; kind?: Project["kind"] }>;
	/** Chat workspace has no project resource scope. */
	projectKind?: Project["kind"];
	/** 当前项目名称：仅用于作用域选择器显示。 */
	projectName?: string;
	/** 深链：打开时落在的配置分页（如圆球「去配置用量」直达 models）。 */
	focusConfigTab?: ConfigTab;
	/** 深链：models 页要定位展开的供应商名。 */
	focusProvider?: string;
	/** 深链：打开时落在的后端分页（DSH 配置 / Pi 管理）；缺省保持上次位置。 */
	focusBackendPane?: "dsh" | "pi";
};

/**
 * 嵌入设置窗口的配置管理分区句柄：外壳（SettingsModal）标题栏的「保存/导出/导入」按钮经 ref 调用。
 * 与独立 ConfigModal 顶部按钮共用同一套 handler（saveByKey/export/import/close），保证两个入口逻辑一致。
 */
export type ConfigPaneHandle = {
	/** 保存当前 tab（内部与 ConfigModal 顶部保存按钮同源）。 */
	saveCurrent: () => Promise<void>;
	/** 导出三个配置文件为 JSON 下载。 */
	exportConfig: () => void;
	/** 从 JSON 文件导入配置。 */
	importConfig: () => void;
	/** 保存全部脏来源（外壳统一关闭确认的「保存并关闭」委托；任一失败返回 false 留在窗口）。 */
	saveAllDirty: () => Promise<boolean>;
};

/** 外壳标题栏所需的状态快照：保存禁用 / 黄点 / 关闭确认清单。 */
export type ConfigPaneState = {
	saving: boolean;
	hasDirty: boolean;
	/** 非本机目标（WSL/ssh）禁用配置导出/导入：外壳按钮据此置灰（handler 侧同样拒绝）。 */
	exportImportAllowed: boolean;
	/** 未保存清单（tabKey/itemKey 为 i18n key，关闭确认整体展示）。 */
	unsaved: { totalCount: number; items: ConfigUnsavedItem[] };
};

export type ConfigPaneProps = {
	onClose: () => void;
	onSaved?: () => void;
	/**
	 * 宿主分区当前是否可见（设置窗口内嵌分区：切到「连接」等其它分区时为 false）。
	 * 主机清单（SSH/WSL）只在可见时重读：新增/移除/重命名发生在别的分区，隐藏期间的重读没有意义。
	 */
	active?: boolean;
	/** 当前项目身份：项目资源 IPC 只接受由主进程登记的 projectId。 */
	projectId?: string;
	/** PiDeck 当前加载的全部项目（作用域下拉展示；Chat 项目除外）。 */
	projects?: Array<{ id: string; name: string; kind?: Project["kind"] }>;
	/** Chat workspace has no project resource scope. */
	projectKind?: Project["kind"];
	/** 当前项目名称：仅用于作用域选择器显示。 */
	projectName?: string;
	/** 资源管理器专用模式：只显示资源页，并将作用域固定为当前项目。 */
	resourceOnly?: boolean;
	/** 深链：打开时落在的配置分页（设置窗口内嵌分区消费 openSettingsAtom 的 configTab）。 */
	focusConfigTab?: ConfigTab;
	/** 深链：models 页要定位展开的供应商名。 */
	focusProvider?: string;
	/** 深链：打开时落在的后端分页（DSH 配置 / Pi 管理）；缺省保持上次位置。 */
	focusBackendPane?: "dsh" | "pi";
	/**
	 * 头部按钮状态上报（saving 禁用保存 / hasDirty 黄点 / unsaved 关闭确认清单）。
	 * 外壳把这些 UI 细节呈现在自己的标题栏，因此 ConfigPane 需要把内部状态同步给外壳。
	 */
	onStateChange?: (state: ConfigPaneState) => void;
	/**
	 * 宿主（设置窗口）的统一关闭入口（含未保存确认）：嵌套弹层需要整窗关闭时走这里，
	 * 不直接调 onClose（那是外壳的裸关闭，会跳过未保存确认）。
	 */
	onRequestClose?: () => void;
};

/**
 * 配置管理嵌入分区：供设置窗口内嵌渲染（共享同一窗口/标题栏，不再各自弹 Dialog）。
 * 不包错误边界——宿主 SettingsModal 的 ErrorBoundary 已兜底整个窗口。
 */
export const ConfigPane = forwardRef<ConfigPaneHandle, ConfigPaneProps>(function ConfigPane({ onClose, onSaved, projectId, projectKind, projectName, projects, resourceOnly, focusConfigTab, focusProvider, focusBackendPane, active, onStateChange, onRequestClose }, ref) {
	return (
		<ConfigModalContent
			open
			onClose={onClose}
			onSaved={onSaved ?? (() => {})}
			projectId={projectId}
			projectKind={projectKind}
			projectName={projectName}
			projects={projects}
			resourceOnly={resourceOnly}
			focusConfigTab={focusConfigTab}
			focusProvider={focusProvider}
			focusBackendPane={focusBackendPane}
			active={active}
			embedded
			paneRef={ref}
			onPaneStateChange={onStateChange}
			onRequestHostClose={onRequestClose}
		/>
	);
});

// 小窗口保留外边距，避免 Pi 管理页完全压住工作区；821px 以上恢复桌面弹框尺寸。
// DialogContent 默认带 sm:max-w-lg，必须显式覆盖它，否则小窗口会变成窄高条。
const configModalSizeClass = WORKBENCH_DIALOG_SIZE_CLASS;

class ConfigModalErrorBoundary extends Component<{ open: boolean; onClose: () => void; children: ReactNode }, { error: Error | null }> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidUpdate(prevProps: { open: boolean }) {
		if (prevProps.open !== this.props.open && this.state.error) {
			this.setState({ error: null });
		}
	}

	override render() {
		if (!this.state.error) return this.props.children;
		if (!this.props.open) return null;
		// #115：错误兜底直接走 shadcn Dialog（components/ui/Modal 薄包装已退役）
		return (
			<Dialog open={this.props.open} onOpenChange={(next) => !next && this.props.onClose()}>
				<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", configModalSizeClass, "config-modal")}>
					<DialogHeader className="flex-row items-center justify-between px-4 py-3">
						<DialogTitle>{t("config.loadFailed")}</DialogTitle>
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</DialogHeader>
					<div className="config-content">
						<div className="config-diagnostic-card">
							<div>
								<strong>{t("config.renderCrashed")}</strong>
								<span>{this.state.error.message}</span>
								<small>
									{t("config.renderCrashedHelpPrefix")}
									<a href="https://pi.dev/docs/latest/models" onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/models")}>
										{t("config.docsModels")}
									</a>
									{" / "}
									<a href="https://pi.dev/docs/latest/settings" onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/settings")}>
										{t("config.docsSettings")}
									</a>
									{t("config.renderCrashedHelpSuffix")}
								</small>
							</div>
							<pre>{this.state.error.stack ?? this.state.error.message}</pre>
						</div>
					</div>
				</DialogContent>
			</Dialog>
		);
	}
}

/** 配置管理弹窗：支持 models/auth/settings 三个 tab 的可视化编辑和源文件编辑 */
export function ConfigModal(props: ConfigModalProps) {
	return (
		<ConfigModalErrorBoundary open={props.open} onClose={props.onClose}>
			<ConfigModalContent {...props} />
		</ConfigModalErrorBoundary>
	);
}

type ConfigModalContentProps = ConfigModalProps & {
	/** 资源管理器专用模式：只渲染技能/扩展/提示词，并固定到传入项目。 */
	resourceOnly?: boolean;
	/** 嵌入模式：不渲染 Dialog 外壳与标题栏按钮（宿主提供窗口），自身仍维护全部状态/保存/关闭确认逻辑 */
	embedded?: boolean;
	/** embedded 时宿主分区是否可见；缺省视为可见（独立弹窗 / 资源管理器）。 */
	active?: boolean;
	/** embedded 时暴露给宿主标题栏按钮的句柄 */
	paneRef?: Ref<ConfigPaneHandle> | undefined;
	/** embedded 时上报标题栏按钮所需状态（保存 disabled / 未保存黄点 / 关闭确认清单） */
	onPaneStateChange?: (state: ConfigPaneState) => void;
	/**
	 * embedded 时宿主（设置窗口）的统一关闭入口（含未保存确认）；
	 * 「让 AI 帮我查」写入输入框后经它整窗关闭，未提供时退回自身 handleClose。
	 */
	onRequestHostClose?: () => void;
};

function ConfigModalContent(props: ConfigModalContentProps) {
	const { open, onClose, onSaved, projectId, projectKind, projectName, projects = [], resourceOnly = false, embedded, focusConfigTab, focusProvider, focusBackendPane, active } = props;
	/** 分区可见性：独立弹窗与资源管理器恒为可见；嵌入时由宿主（设置窗口）逐次告知。 */
	const paneVisible = active !== false;
	/**
	 * 资源作用域是派生值而非可切换 state：
	 * - 主配置页固定 global（全局安装 + 用户 ~/.pi 自装 + PiDeck 内置）；项目级技能/扩展/提示词
	 *   的管理入口在项目右键的「资源管理」弹窗，这里不再提供全局/项目下拉（双入口反而混乱）。
	 * - 资源管理器模式（resourceOnly，项目右键进入）固定为入口项目。
	 * MCP 页同样固定全局：只显示/操作 ~/.pi/agent/mcp.json 与全局只读层，不提供项目作用域。
	 */
	const resourceScope: ResourceScope = resourceOnly ? "project" : "global";
	/** scope=project 时实际使用的项目 id；资源管理器模式直接使用入口项目（Chat 项目无项目资源目录）。 */
	const effectiveProjectId = resourceOnly && projectKind !== "chat" ? projectId : undefined;
	const hasProject = Boolean(effectiveProjectId);
	// UI 计时器（Saved 徽章复位、退场动画）：Radix Dialog 关闭即卸载内容，
	// 未清理的计时器会在卸载后 setState。统一登记，卸载时批量满 timeout。
	const uiTimerIdsRef = useRef<number[]>([]);
	useEffect(
		() => () => {
			for (const id of uiTimerIdsRef.current) window.clearTimeout(id);
		},
		[],
	);
	const scheduleUiTimer = useCallback((fn: () => void, ms: number) => {
		uiTimerIdsRef.current.push(window.setTimeout(fn, ms));
	}, []);
	// 弹窗每次打开都会重新挂载（Radix Dialog 关闭即卸载内容），
	// 用 lazy initializer 在挂载时读一次 localStorage，恢复到上次所在 tab。
	const [lastTab] = useState(loadLastConfigTab);
	// 深链优先于「上次记住的区域」：models/auth/settings/trust/mcp/raw 这些分页只属于
	// config 区域，若上次停在 skills/prompts/extensions，只按 lastTab 恢复区域会出现
	// 「分页跳对了、区域没切」——用户看到的是上一次停留的地方（首次挂载就错，必须在这里兜）。
	const [section, setSection] = useState<ConfigSection>(resourceOnly ? "skills" : focusConfigTab || focusProvider ? "config" : (lastTab?.section ?? "config"));
	// 深链（如圆球面板「去配置用量」）优先于上次记住的配置分页。
	const [tab, setTab] = useState<ConfigTab>(focusConfigTab ?? lastTab?.tab ?? "models");
	// 深链 provider：models 页展开该供应商卡片并滚动高亮（ModelsTab 消费）。
	const [focusedProvider, setFocusedProvider] = useState<string | undefined>(focusProvider);
	// 用量探针配置弹窗：由模型/认证/DSH 卡片触发（provider + backend 决定配置落盘位置）。
	const [usageProbeDialog, setUsageProbeDialog] = useState<{
		provider: string;
		backend: "pi" | "dsh";
	} | null>(null);
	// 打开弹窗的公共入口：pi 侧（模型/认证）provider 与 DSH route 分开（DSH 走 $DSH_HOME 链路）。
	const openUsageProbeDialogFor = useCallback((provider: string, backend: "pi" | "dsh") => {
		setUsageProbeDialog({ provider, backend });
	}, []);
	useEffect(() => {
		if (!open) return;
		// 顶层区域必须一并切回 config：这些分页（models/auth/...）只属于 config 区域，
		// 只 setTab 的话，上次停在 skills/prompts/extensions 时会「切了分页却看不见」。
		if (!resourceOnly && focusConfigTab) {
			setSection("config");
			setTab(focusConfigTab);
		}
		if (!resourceOnly && focusProvider) {
			setSection("config");
			setFocusedProvider(focusProvider);
			setTab("models");
			setExpandedProvider(focusProvider);
		}
		// focusProvider/focusConfigTab 变化即应用：设置窗口已开时点圆球跳转也要生效。
	}, [open, focusConfigTab, focusProvider, resourceOnly]);
	/** 配置管理顶层后端分页：以 Pi 为主（默认 Pi，且 Pi 标签在左），dsh 页在右。
	 *  新建会话默认后端跟随设置项 defaultAgentBackend（默认 pi），与此处配置管理入口相互独立。
	 *  弹窗每次打开都会重建 state，这里从 localStorage 恢复上次选定的后端分页。 */
	const [backendPane, setBackendPane] = useState<"dsh" | "pi">(resourceOnly ? "pi" : (focusBackendPane ?? loadLastConfigBackendPane));
	/**
	 * 用户隐藏了 DSH 模块（设置 → 外观 → 功能模块）：不渲染 Pi/DSH 分页头，弹窗固定在 Pi 页。
	 * 深链点名 DSH 页（runtime 提示「去安装」等）时例外：用户是主动要去，此时保留分页头供切回 Pi。
	 */
	const dshModuleHidden = useAtomValue(dshModuleHiddenAtom);
	const dshPaneHidden = dshModuleHidden && focusBackendPane !== "dsh";
	useEffect(() => {
		// 上次停在 DSH 页、或弹窗开着时在设置里隐藏了 DSH：回到 Pi 页，避免停在一个没有入口的页面。
		// 只改本次弹窗的 state，不覆写 localStorage 记忆——恢复显示后仍回到用户上次的选择。
		if (dshPaneHidden) setBackendPane("pi");
	}, [dshPaneHidden]);
	/** 切换后端分页并持久化：退出配置管理再进入时停留在上次选定的后端。 */
	const selectBackendPane = useCallback((value: string) => {
		const next = value === "pi" ? "pi" : "dsh";
		setBackendPane(next);
		// 用量查询弹窗是 per-provider 的：切换 Pi/DSH 页时关闭，
		// 避免「从认证页点开、切到模型页后弹窗还挂着」的越界出现（用户反馈的闪现 bug）。
		setUsageProbeDialog(null);
		rememberConfigBackendPane(next);
	}, []);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 各 tab 未保存修改集合：key 用 sectionTabValue 编码（如 "config:models"/"skills"），顶部保存按钮与关闭确认依赖它 */
	const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
	/** 资源页工具栏右侧的作用域标识：resourceOnly 展示固定项目名；主配置页无下拉（undefined 不渲染）。 */
	const resourceScopeSelector = resourceOnly ? (
		<div className="flex h-8 max-w-[16rem] items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-control text-muted-foreground" title={projectName ?? t("config.resourceScope.projectFallback")} aria-label={t("config.resourceScope.label")}>
			<FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="truncate">{projectName?.trim() || t("config.resourceScope.projectFallback")}</span>
		</div>
	) : undefined;
	/** loadConfig 不能依赖 dirtyTabs（否则切 tab 会重建回调并误触发重载）；用 ref 读最新脏集合。 */
	const dirtyTabsRef = useRef(dirtyTabs);
	dirtyTabsRef.current = dirtyTabs;
	/** MCP 页句柄：自管加载/保存，顶部统一保存按钮经 saveByKey 转发。 */
	const mcpTabRef = useRef<McpTabHandle>(null);
	/** 项目资源管理器里的 MCP 页句柄（项目作用域；主配置页没有这个 section）。 */
	const resourceMcpTabRef = useRef<McpTabHandle>(null);
	/** 关闭弹框时存在未保存修改 → 弹出保存确认（借鉴设置页关闭逻辑） */
	const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
	/**
	 * Pi 环境（本次重构的唯一作用域开关）：本机 / 一台 SSH 主机 / 一个 WSL 发行版。
	 * 整页按它加载：配置组、资源组、保存路由、导航可见性都从这里派生，页内不再各自放选择器。
	 */
	// 项目资源管理器只管理入口项目的本地资源：不继承「上次的 Pi 环境」，否则资源会被写到某个发行版里。
	const [configTarget, setConfigTarget] = useState<PiConfigTarget>(() => (resourceOnly ? { kind: "local" } : loadLastConfigTarget()));
	const [remoteConfigHosts, setRemoteConfigHosts] = useState<PiConfigTargetHost[]>([]);
	/** 主机清单是否已回来（用来区分「没加载」与「确实一个都没有」）。 */
	const [remoteConfigHostsLoaded, setRemoteConfigHostsLoaded] = useState(false);
	/** SSH 页签的未应用 patch：按文件聚合（多个远端面板可能同时挂载，例如 mcp 的 forceMount 页）。 */
	const [remoteDirtyFiles, setRemoteDirtyFiles] = useState<Set<string>>(new Set());
	const remoteConfigDirty = remoteDirtyFiles.size > 0;
	const markRemoteDirty = useCallback((file: string, dirty: boolean) => {
		setRemoteDirtyFiles((prev) => {
			if (prev.has(file) === dirty) return prev;
			const next = new Set(prev);
			if (dirty) next.add(file);
			else next.delete(file);
			return next;
		});
	}, []);
	const resetRemoteDirty = useCallback(() => setRemoteDirtyFiles(new Set()), []);
	/** 带草稿切换环境时的确认（保存并切换 / 放弃并切换 / 取消）。 */
	const [pendingEnvSwitch, setPendingEnvSwitch] = useState<PendingEnvSwitch | null>(null);
	const [remoteDiscardConfirmOpen, setRemoteDiscardConfirmOpen] = useState(false);
	const remoteTargetHostId = configTarget.kind === "ssh" ? configTarget.hostId : null;
	const remoteHostLabel = remoteTargetHostId ? remoteConfigHosts.find((host) => host.kind === "ssh" && host.id === remoteTargetHostId)?.label : undefined;
	// 目标视图派生：WSL 档案（来源提示/未接入页说明）、本地编辑器 target 选项、provider 探针门禁。
	const { wslHost: wslTargetHost, option: configTargetOption, guardProviderOp } = usePiConfigTargetView(remoteConfigHosts, configTarget);
	/** WSL 环境的 mcp.json 文本（该环境的 MCP 页按文件编辑；探测/登录仍只在本机执行）。 */
	const [wslMcpRaw, setWslMcpRaw] = useState("");
	const baselineWslMcpRef = useRef("");
	// 资源三页（技能/提示词/扩展）的目标视图：本机/WSL 档案选择、IPC options、本轮只读门禁（W1）。
	// 资源三页跟随同一个环境（不再有第二个选择器）：本机 → 本机；WSL → 该发行版；ssh 不提供资源页。
	const { resourceTarget, options: resourceOptions, blockMutation: blockResourceMutation } = useResourceTarget(resourceScope, configTarget);
	const hasDirty = dirtyTabs.size > 0;
	// DSH/Pi 顶层分页与 DSH 左侧导航的黄点来源：dsh:<nav> 归 DSH，其余归 Pi
	const dshDirtyNavIds = useMemo(() => {
		const ids = new Set<string>();
		for (const key of dirtyTabs) if (key.startsWith("dsh:")) ids.add(key);
		return ids;
	}, [dirtyTabs]);
	const hasDshDirty = dshDirtyNavIds.size > 0;
	const hasPiDirty = dirtyTabs.size > 0 && !hasDshDirty;
	/** 关闭确认摘要：列出全部脏 tab（不再只点第一条），供 AlertDialog 逐条展示。 */
	const configUnsavedSummary = useMemo(() => summarizeConfigUnsavedChanges(dirtyTabs), [dirtyTabs]);
	const configUnsavedMessage = useMemo(() => formatConfigUnsavedMessage(configUnsavedSummary, t), [configUnsavedSummary]);

	/** 标记某 tab 存在未保存修改（幂等；只用 setDirtyTabs 函数式更新，引用稳定） */
	const markDirty = useCallback((tabKey: string) => {
		setDirtyTabs((prev) => {
			if (prev.has(tabKey)) return prev;
			const next = new Set(prev).add(tabKey);
			dirtyTabsRef.current = next;
			return next;
		});
	}, []);

	/** 清除某 tab 的未保存修改标记（保存成功或主动放弃编辑时调用） */
	const clearDirty = useCallback((tabKey: string) => {
		setDirtyTabs((prev) => {
			if (!prev.has(tabKey)) return prev;
			const next = new Set([...prev].filter((k) => k !== tabKey));
			dirtyTabsRef.current = next;
			return next;
		});
	}, []);

	/** DSH 页脏状态：保留聚合 "dsh" 给保存按钮，同时记下 dsh:<nav> 供侧栏黄点/关闭文案。 */
	const handleDshDirtyChange = useCallback((dirty: boolean, keys: string[] = []) => {
		setDirtyTabs((prev) => {
			const next = new Set([...prev].filter((key) => key !== "dsh" && !key.startsWith("dsh:")));
			if (dirty) {
				next.add("dsh");
				for (const key of keys) {
					if (key.startsWith("dsh:")) next.add(key);
				}
			}
			dirtyTabsRef.current = next;
			return next;
		});
	}, []);
	const [configDiagnostic, setConfigDiagnostic] = useState<ConfigFileDiagnostic | null>(null);
	/* toast 已改用 sonner 实现 */

	// 各 tab 的数据
	const [modelsData, setModelsData] = useState<ModelsFile>({ providers: {} });
	const [authData, setAuthData] = useState<AuthFile>({});
	/**
	 * 供应商页的 API Key 空框不等于没配：`models.json` 的 `apiKey` 只是覆盖层，pi 会从
	 * `auth.json` 解析凭据（#537）。这里把已在 `auth.json` 的 api_key 做成掩码摘要交给模型页，
	 * 只传长度与末几位，明文不因此多一条渲染层通道。
	 */
	const authKeyHints = useMemo(() => {
		const hints: Record<string, { length: number; tail: string }> = {};
		for (const [provider, entry] of Object.entries(authData)) {
			const hint = secretHint(typeof entry?.key === "string" ? entry.key : "");
			if (hint) hints[provider] = { length: hint.length, tail: hint.tail };
		}
		return hints;
	}, [authData]);
	const [settingsData, setSettingsData] = useState<SettingsFile>({});
	/**
	 * settings.json 是否已真实读入内存。模型页也要读写 settings（每模型默认思考档位），
	 * 但在它读成功前不能渲染该编辑入口——否则会把空对象当磁盘内容保存，覆盖 settings.json。
	 */
	const [settingsLoaded, setSettingsLoaded] = useState(false);
	/** 自动发现的模型：auth-only 供应商通过已知端点获取的模型列表 */
	const [discoveredModels, setDiscoveredModels] = useState<Record<string, Array<{ id: string; name?: string }>>>({});
	const [trustData, setTrustData] = useState<Record<string, boolean>>({});
	const [projectResourcesData, setProjectResourcesData] = useState<ProjectResourceListResult>(emptyProjectResourceData);
	/** 运行时发现的资源（packages/settings 显式路径/祖先 .agents/skills）只读描述。 */
	const [discoveryData, setDiscoveryData] = useState<ProjectResourceDiscoveryResult>(emptyDiscoveryData);
	/** 资源刷新代数：scope/project 变化或 mutation 后递增，旧响应不得覆盖新结果。 */
	const resourceGenerationRef = useRef(0);
	const bumpResourceGeneration = useCallback(() => {
		resourceGenerationRef.current += 1;
	}, []);
	/** 统一 toast 出口：资源页动作成功提示（提到 hook 之前，供其作为依赖注入）。 */
	const showToast = (msg: string) => showNotice(msg, 2500);

	// 扩展页的列表状态与开关/卸载动作（搬迁到 config/configModal/useConfigExtensionsEditing，行为不变）。
	const {
		extensionsData,
		extensionsLoading,
		uninstallingExtensionSource,
		uninstallExtensionConfirm,
		setUninstallExtensionConfirm,
		uninstallProjectPackageConfirm,
		setUninstallProjectPackageConfirm,
		refreshExtensions,
		handleToggleExtension,
		handleRequestExtensionUninstall,
		handleRequestProjectPackageUninstall,
		handleOpenExtensionLocation,
		handleOpenDiscoveredLocation,
		confirmUninstallExtension,
		confirmUninstallProjectPackage,
	} = useConfigExtensionsEditing({
		api,
		resourceScope,
		effectiveProjectId,
		hasProject,
		resourceOptions,
		blockResourceMutation,
		resourceGenerationRef,
		setDiscoveryData,
		setProjectResourcesData,
		setError,
		notify: showToast,
		scheduleUiTimer,
	});

	// 技能页的草稿状态与增删改动作（搬迁到 config/configModal/useConfigSkillsEditing，行为不变）。
	const {
		skillsData,
		creatingSkill,
		newSkillName,
		setNewSkillName,
		newSkillDescription,
		setNewSkillDescription,
		newSkillLocationId,
		setNewSkillLocationId,
		deleteSkillConfirm,
		setDeleteSkillConfirm,
		editingGlobalSkill,
		setEditingGlobalSkill,
		editGlobalContent,
		setEditGlobalContent,
		editGlobalLoading,
		editGlobalSaving,
		editGlobalSaved,
		refreshSkills,
		handleCreateSkill,
		handleToggleSkill,
		confirmDeleteSkill,
		handleRenameGlobalSkill,
		handleEditGlobalSkill,
		saveGlobalSkillEditor,
	} = useConfigSkillsEditing({
		api,
		resourceScope,
		projectId,
		effectiveProjectId,
		hasProject,
		resourceOptions,
		blockResourceMutation,
		resourceGenerationRef,
		bumpResourceGeneration,
		setDiscoveryData,
		setProjectResourcesData,
		clearDirty,
		setError,
		notify: showToast,
		scheduleUiTimer,
	});

	// 提示词模板页的草稿状态与增删改动作（搬迁到 config/configModal/useConfigPromptsEditing，行为不变）。
	const {
		promptsData,
		creatingPrompt,
		newPromptName,
		setNewPromptName,
		newPromptDescription,
		setNewPromptDescription,
		editingPrompt,
		setEditingPrompt,
		editPromptContent,
		setEditPromptContent,
		editPromptLoading,
		editPromptSaving,
		deletePromptConfirm,
		setDeletePromptConfirm,
		refreshPrompts,
		handleCreatePrompt,
		confirmDeletePrompt,
		handleEditPrompt,
		handleCancelEditPrompt,
		handleSaveEditPrompt,
		handleRenamePrompt,
		handleTogglePrompt,
		handleQuickSavePrompt,
	} = useConfigPromptsEditing({
		api,
		resourceScope,
		projectId,
		effectiveProjectId,
		hasProject,
		resourceOptions,
		blockResourceMutation,
		resourceGenerationRef,
		bumpResourceGeneration,
		setDiscoveryData,
		setProjectResourcesData,
		clearDirty,
		setError,
		notify: showToast,
	});
	const [rawContent, setRawContent] = useState("");
	const [rawFileName, setRawFileName] = useState("models.json");
	/** 待切换的源文件名：当前文件有未保存草稿时先弹确认，确认丢弃后才真正切换。 */
	const [pendingRawFile, setPendingRawFile] = useState<string | null>(null);
	// pi 全局配置目录（源文件页标注实际编辑位置）；加载失败时静默降级不显示路径。

	// ── Pi 配置数据基准快照：脏检测改为「当前数据 vs 基准」真实差异，改回原值自动摘掉脏标记 ──
	// 仅在 loadConfig 真正覆盖内存数据时同步更新；被 preserve（脏草稿保留）时不动基准，脏标记保持。
	const baselineModelsRef = useRef<ModelsFile>({ providers: {} });
	const baselineAuthRef = useRef<AuthFile>({});
	const baselineSettingsRef = useRef<SettingsFile>({});
	const baselineTrustRef = useRef<Record<string, boolean>>({});
	const baselineRawRef = useRef<{ fileName: string; content: string }>({
		fileName: "models.json",
		content: "",
	});

	/**
	 * Pi 配置脏状态由数据与基准的真实差异推导（models/auth/settings/trust/raw 这 5 个
	 * 由本组件 state 承载的文件）。MCP/DSH/security/skills/prompts 仍由各自注册表维护，
	 * 这里只增删对应的 config:* key，不动其它来源的脏标记。
	 */
	useEffect(() => {
		// 以 ref 为源（markDirty/clearDirty/handleDshDirtyChange 都同步维护它），
		// 只增删这 5 个 config:* key，其它来源的脏标记原样保留。
		const before = new Set(dirtyTabsRef.current);
		const next = new Set(dirtyTabsRef.current);
		reconcileConfigDirty(next, "config:models", modelsData, baselineModelsRef.current);
		reconcileConfigDirty(next, "config:auth", authData, baselineAuthRef.current);
		reconcileConfigDirty(next, "config:settings", settingsData, baselineSettingsRef.current);
		reconcileConfigDirty(next, "config:trust", trustData, baselineTrustRef.current);
		reconcileConfigDirty(next, "config:raw", { fileName: rawFileName, content: rawContent }, baselineRawRef.current);
		// WSL 环境的 MCP 页是文本编辑：草稿按文本比较（本机 MCP 页由 McpTab 自己维护同一个 key）。
		if (configTarget.kind === "wsl") reconcileConfigDirty(next, "config:mcp", wslMcpRaw, baselineWslMcpRef.current);
		dirtyTabsRef.current = next;
		// 只有真正增删了 key 才提交 state，避免每次键入都重建相同 Set 触发无关重渲染
		const changed = next.size !== before.size || [...next].some((key) => !before.has(key));
		if (changed) setDirtyTabs(next);
	}, [modelsData, authData, settingsData, trustData, rawContent, rawFileName, wslMcpRaw, configTarget.kind]);

	// 展开的 provider / auth 项
	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	const [expandedAuth, setExpandedAuth] = useState<string | null>(null);
	// 新增 provider（弹窗开关）
	const [addingProvider, setAddingProvider] = useState(false);
	/** 正在编辑的 provider key（编辑弹窗目标）；null = 无编辑弹窗。 */
	const [editingProvider, setEditingProvider] = useState<string | null>(null);
	/** 新增/编辑供应商页的当前草稿保存入口，由设置窗口标题栏按钮调用。 */
	const providerPageSaveRef = useRef<(() => void) | undefined>(undefined);
	/** 标题栏保存触发页内提交后，等待下一轮 state 更新再执行 models.json 落盘。 */
	const providerPageSavePendingRef = useRef(false);
	/** 用户隐藏的供应商 key 列表（模型页眼睛开关持久化到 AppSettings.hiddenProviders）。 */
	const [hiddenProviders, setHiddenProviders] = useState<string[]>([]);
	/** 用户隐藏的模型列表（格式："provider/modelId"，持久化到 AppSettings.hiddenModels）。 */
	const [hiddenModels, setHiddenModels] = useState<string[]>([]);
	/** 用户隐藏的认证供应商列表（持久化到 AppSettings.hiddenAuthProviders）。 */
	const [hiddenAuthProviders, setHiddenAuthProviders] = useState<string[]>([]);
	/**
	 * 供应商卡片自定义顺序（Pi 页与 DSH 页各存一份，持久化到 AppSettings）。
	 * 与 hiddenProviders 同类：属于 UI 展示偏好，不写进 models.json / DSH 配置，
	 * 因此无需担心被外部改写 pi 配置的工具覆盖。
	 */
	const [providerOrder, setProviderOrder] = useState<string[]>([]);
	const [dshProviderOrder, setDshProviderOrder] = useState<string[]>([]);
	/** 切换供应商隐藏状态：本地立即生效 + 持久化到 AppSettings（不影响 models.json 配置本身）。 */
	const handleToggleHiddenProvider = useCallback((name: string) => {
		setHiddenProviders((prev) => {
			const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name];
			void api.settings.update({ hiddenProviders: next }).catch(() => undefined);
			return next;
		});
	}, []);
	/** 切换模型隐藏状态：本地立即生效 + 持久化到 AppSettings。 */
	const handleToggleHiddenModel = (provider: string, modelId: string) => {
		setHiddenModels((prev) => {
			// 写盘前顺手清孤儿（模型已不在列表里的旧 ID），与保存时同一套规则
			const next = pruneHiddenModelOrphans(toggleHiddenModelKey(prev, provider, modelId), modelIdIndex(modelsData.providers));
			void api.settings.update({ hiddenModels: next }).catch(() => undefined);
			return next;
		});
	};
	/** 切换认证供应商隐藏状态：本地立即生效 + 持久化到 AppSettings（auth.json 保留不变供运行时读取）。 */
	const handleToggleHiddenAuthProvider = useCallback((name: string) => {
		setHiddenAuthProviders((prev) => {
			const next = prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name];
			void api.settings.update({ hiddenAuthProviders: next }).catch(() => undefined);
			return next;
		});
	}, []);
	/**
	 * 供应商卡片重排：本地立即生效 + 持久化。
	 * 顺序未变（例如拖回原位）也照常写一次——主进程 SettingsStore 会把无变化的键从 patch 里剔除，
	 * 这里不再重复一份比较逻辑。
	 */
	const handleReorderProviders = useCallback((next: string[]) => {
		setProviderOrder(next);
		void api.settings.update({ providerOrder: next }).catch(() => undefined);
	}, []);
	/** DSH 模型页的供应商卡片重排（与 Pi 页分开存，两页的供应商集合不同）。 */
	const handleReorderDshProviders = useCallback((next: string[]) => {
		setDshProviderOrder(next);
		void api.settings.update({ dshProviderOrder: next }).catch(() => undefined);
	}, []);
	/** 恢复默认顺序：清空自定义顺序（空数组）——两页与模型选择器立即回到配置本身的顺序。 */
	const handleResetProviderOrder = useCallback(() => {
		setProviderOrder([]);
		void api.settings.update({ providerOrder: [] }).catch(() => undefined);
	}, []);
	/** DSH 页的「恢复默认顺序」（与 Pi 页分开清，避免改一页把另一页也重置）。 */
	const handleResetDshProviderOrder = useCallback(() => {
		setDshProviderOrder([]);
		void api.settings.update({ dshProviderOrder: [] }).catch(() => undefined);
	}, []);
	/**
	 * 「模型」与「认证」页共享的排序作用域：两页的供应商集合可能不同（models.json 与 auth.json
	 * 各自独立增删），把并集交给排序 hook 当「完整顺序」，在任一页拖动都只会改变该项在并集里的位置，
	 * 另一页独有的供应商保持原位。仅收录仍然存在的供应商，已删除的名字会在下次拖动时被顺带清掉。
	 */
	const providerOrderScope = useMemo(() => buildProviderOrderScope([Object.keys(modelsData.providers), Object.keys(authData)], providerOrder), [modelsData.providers, authData, providerOrder]);
	// 打开配置页时读取 AppSettings.hiddenProviders、hiddenModels 与 hiddenAuthProviders
	useEffect(() => {
		let cancelled = false;
		void api.settings
			.get()
			.then((settings) => {
				if (!cancelled) {
					setHiddenProviders(settings.hiddenProviders ?? []);
					setHiddenModels(settings.hiddenModels ?? []);
					setHiddenAuthProviders(settings.hiddenAuthProviders ?? []);
					setProviderOrder(settings.providerOrder ?? []);
					setDshProviderOrder(settings.dshProviderOrder ?? []);
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, []);
	// 新增 auth
	const [addingAuth, setAddingAuth] = useState(false);
	const [newAuthName, setNewAuthName] = useState("");
	// 远程拉取模型列表
	const [fetchingProvider, setFetchingProvider] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<Record<string, FetchedModel[]>>({});
	// 正在重置为自适应的模型行 key（`${providerName}\u0000${index}`），null 表示无。
	const [resettingModelKey, setResettingModelKey] = useState<string | null>(null);

	// 每个 provider 独立的模型拉取错误状态，避免全局 setError 相互覆盖
	const [fetchModelsErrorByProvider, setFetchModelsErrorByProvider] = useState<Record<string, string | undefined>>({});
	// 快速测试连接
	const [testingProvider, setTestingProvider] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<{
		providerName: string;
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
	} | null>(null);
	const [testModelIdByProvider, setTestModelIdByProvider] = useState<Record<string, string>>({});
	// 每个 provider 的测试/拉取模型代理模式：follow 跟随全局，pi/desktop 强制走对应代理，off 强制直连。
	// 独立于全局代理开关：有些供应商（如海外网关）只在代理下才通，而全局开关会影响所有会话。
	const [testProxyModeByProvider, setTestProxyModeByProvider] = useState<Record<string, ConfigProxyMode>>({});
	// 删除确认对话框
	const [deleteConfirm, setDeleteConfirm] = useState<ConfigDeleteConfirm | null>(null);

	/**
	 * 检测成功且实际走通 /v1（或 /v1beta）时，把表单里的 baseUrl 自动改成带版本路径。
	 * 原因：检测侧会兼容补路径，但 pi 会话会原样读 models.json；不改写则「测试正常、会话 404」。
	 * 仅改内存表单，需用户点保存后才写入磁盘。
	 * 后端仅在确实需要改写时返回 suggestedBaseUrl，前端直接应用即可。
	 * 声明在 loadConfig 之前：后台自动发现分支要在闭包里引用它（TDZ）。
	 */
	const applySuggestedBaseUrl = useCallback(
		(providerName: string, suggestedBaseUrl?: string) => {
			if (!suggestedBaseUrl) return false;
			const next = suggestedBaseUrl.replace(/\/+$/, "");
			if (!next) return false;
			// 函数式更新，避免 async 返回时闭包拿到旧 modelsData。
			setModelsData((prev) => {
				const provider = prev.providers[providerName];
				if (!provider) return prev;
				const current = (provider.baseUrl ?? "").replace(/\/+$/, "");
				if (current === next) return prev;
				return {
					...prev,
					providers: {
						...prev.providers,
						[providerName]: { ...provider, baseUrl: next },
					},
				};
			});
			// 检测/测试自动改写 baseUrl 同样属于表单修改，标记未保存
			markDirty("config:models");
			return true;
		},
		[markDirty],
	);

	// 读盘链路（搬迁到 config/configModal/useConfigLoader，行为不变）。
	const { loadConfig } = useConfigLoader({
		api,
		tab,
		targetKind: configTarget.kind,
		configTargetOption,
		dirtyTabsRef,
		mcpTabRef,
		applySuggestedBaseUrl,
		clearDirty,
		setLoading,
		setError,
		setConfigDiagnostic,
		setModelsData,
		setAuthData,
		setSettingsData,
		setSettingsLoaded,
		setTrustData,
		setRawContent,
		setRawFileName,
		setWslMcpRaw,
		setDiscoveredModels,
		baselineModelsRef,
		baselineAuthRef,
		baselineSettingsRef,
		baselineTrustRef,
		baselineRawRef,
		baselineWslMcpRef,
	});

	useEffect(() => {
		if (!open) return;
		const onMigrated = () => {
			void loadConfig("models");
		};
		window.addEventListener("pideck:provider-migrated", onMigrated);
		return () => window.removeEventListener("pideck:provider-migrated", onMigrated);
	}, [open, loadConfig]);

	const piConfigDir = usePiConfigDir(open);

	// 配置目标选择器（Batch B + WS2）：ssh 只列已验证且未禁用的主机；WSL 项来自开发设置里的那一个环境；
	// 两边都失败也保留「本机」。
	// 主机清单会从别处变（设置 → 连接里的新建/编辑/移除）：分区重新可见时重读一次。
	// 从挂载到关闭只读一次的写法会让下拉漏掉刚添加的主机，只能关掉整个设置重开才能看到（2026-11 实机反馈）。
	useEffect(() => {
		if (!open || !paneVisible) return;
		let cancelled = false;
		void Promise.all([api.remoteHosts.list(), api.settings.get()])
			.then(([sshResult, settings]) => {
				if (cancelled) return;
				// WSL 身份只认开发设置：开关打开且 distro/user 都有才出现这一项（主进程同样会 fail closed）。
				const distro = (settings.wslDistro ?? "").trim();
				const user = (settings.wslUser ?? "").trim();
				const wslIdentity = settings.wslEnabled === true && distro.length > 0 && user.length > 0 ? { distro, user } : undefined;
				setRemoteConfigHosts((previous) => {
					const next = [...toSshTargetHosts(sshResult.ok ? sshResult.hosts.filter((host) => host.verified && !host.disabled) : []), ...toWslTargetHosts(wslIdentity)];
					// 重读没带来变化时保留旧数组：状态条按 hosts 身份变化自动确保连接，不能因一次无变化的刷新
					// 重新弹密码框/重发连接。真正新增/删除/改名的主机仍会换上新的清单。
					return sameConfigTargetHosts(previous, next) ? previous : next;
				});
				setRemoteConfigHostsLoaded(true);
			})
			.catch(() => {
				if (cancelled) return;
				setRemoteConfigHosts([]);
				setRemoteConfigHostsLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [open, paneVisible]);

	/** 环境的稳定身份：切换时用它驱动一次整页重读（local↔ssh 的 target 选项都是 undefined，必须单独判）。 */
	const configTargetIdentity = configTargetKey(configTarget);
	// 资源页在进入/scope/project 变化时刷新；generation 变化让在途旧响应失效。
	useEffect(() => {
		if (!open) return;
		bumpResourceGeneration();
		if (section === "skills") {
			void refreshSkills().catch((e) => setError(resourceTargetErrorMessage(e)));
			return;
		}
		if (section === "prompts") {
			void refreshPrompts().catch((e) => setError(resourceTargetErrorMessage(e)));
			return;
		}
		if (section === "extensions") {
			// 扩展页需要显示当前/最新版本与可更新状态，首次进入强制查一次版本；
			// 主进程 listCacheHasVersionInfo 会让后续进入直接吃带版本的缓存，不重复打 npm view。
			void refreshExtensions(true);
			return;
		}
		void loadConfig(tab);
		// 环境切换必须触发一次重读：local↔ssh 时 configTargetOption 都是 undefined，只靠 loadConfig 的
		// 身份变化不会重新取数（例如在 ssh 上停过信任页，切回本机后 trustData 还是未加载的空对象）。
	}, [open, section, tab, loadConfig, resourceScope, effectiveProjectId, bumpResourceGeneration, resourceTarget, configTargetIdentity]);

	/** 统一保存流程：写盘 → 校验 → toast；成功时清除对应 tab 的未保存标记，返回是否成功。 */
	const saveAndReload = async (saveFn: () => Promise<{ valid: boolean; error?: string }>, successMessage?: string, dirtyKey?: string): Promise<boolean> => {
		setSaving(true);
		setError(null);
		try {
			const result = await saveFn();
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return false;
			}
			onSaved();
			showToast(successMessage ?? t("config.saved"));
			if (dirtyKey) clearDirty(dirtyKey);
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	};

	// ── Models 操作 ──────────────────────────────────────

	/** TokenDance 一键安装成功：刷新 Pi 模型数据 + DSH 配置页（主进程已直写两侧配置文件）。 */
	const handleTokendanceInstalled = useCallback(
		(outcome: TokendanceInstallOutcome) => {
			// 主进程已直接落盘 models.json：以磁盘为准整页重载（force 清空草稿保留集——
			// 安装是明确的落盘动作，与保存/导入同语义）；DSH 侧若写入成功同步刷新配置页。
			void loadConfig("models", { force: true }).catch(() => undefined);
			if (outcome.dshSaved) {
				void dshConfigRef.current?.reload().catch(() => undefined);
			}
		},
		[loadConfig],
	);

	// 模型页的供应商级动作（搬迁到 config/configModal/useConfigModelsProviderEditing，行为不变）。
	const { handleAddProvider, handleEditProvider, handleDeleteProvider, handleDuplicateProvider, handleApplyModelsTransfer, handleDeleteProviders, handleFetchModels, handleTestProvider } = useConfigModelsProviderEditing({
		api,
		configTargetOption,
		modelsData,
		setModelsData,
		authData,
		setAuthData,
		settingsData,
		setSettingsData,
		hiddenModels,
		setHiddenModels,
		expandedProvider,
		setExpandedProvider,
		setAddingProvider,
		setEditingProvider,
		setDeleteConfirm,
		markDirty,
		notify: showToast,
		setError,
		applySuggestedBaseUrl,
		setFetchingProvider,
		setFetchedModels,
		setFetchModelsErrorByProvider,
		setTestingProvider,
		setTestResult,
		testModelIdByProvider,
		testProxyModeByProvider,
	});

	// 模型页的模型行级动作（搬迁到 config/configModal/useConfigModelRowsEditing，行为不变）。
	const { handleAddModel, handleUpdateModel, handleResetModelToAdaptive, handleUpdateModelUserAgent, handleUpdateModelThinkingLevel, handleUpdateModelThinkingLevelDefault, handleDeleteModel, handleDeleteModels, handleSaveModels } = useConfigModelRowsEditing({
		api,
		configTargetOption,
		modelsData,
		setModelsData,
		setSettingsData,
		hiddenModels,
		setHiddenModels,
		markDirty,
		clearDirty,
		onSaved,
		notify: showToast,
		setError,
		setSaving,
		reloadConfig: loadConfig,
		setDeleteConfirm,
		setResettingModelKey,
		testProxyModeByProvider,
	});

	// 认证页的增删改动作（搬迁到 config/configModal/ConfigAuthTab.tsx，行为不变）。
	const { handleUpdateAuth, handleAddAuth, handleDeleteAuth, handleDuplicateAuth, handleDeleteAuths, handleSaveAuth } = useConfigAuthEditing({
		api,
		configTargetOption,
		authData,
		setAuthData,
		newAuthName,
		setNewAuthName,
		expandedAuth,
		setExpandedAuth,
		setAddingAuth,
		markDirty,
		setDeleteConfirm,
		saveAndReload,
		reloadConfig: loadConfig,
	});

	// 设置页的保存动作（搬迁到 config/configModal/ConfigSettingsTab.tsx，行为不变）。
	const { handleSaveSettings, saveSettingsDraftOnly } = useConfigSettingsEditing({
		api,
		configTargetOption,
		settingsData,
		setSettingsData,
		modelsData,
		baselineSettingsRef,
		saveAndReload,
		reloadConfig: loadConfig,
	});

	// 信任页的保存动作（搬迁到 config/configModal/ConfigTrustTab.tsx，行为不变）。
	const { handleSaveTrust } = useConfigTrustEditing({ api, configTargetOption, trustData, saveAndReload, reloadConfig: loadConfig });

	/** WSL 环境的 MCP 页：整份 mcp.json 文本保存（探测/登录仍只在本机执行）。 */
	const handleSaveWslMcp = async (): Promise<boolean> => {
		const ok = await saveAndReload(() => api.config.saveRaw("mcp.json", wslMcpRaw, configTargetOption), undefined, "config:mcp");
		if (ok) baselineWslMcpRef.current = wslMcpRaw;
		await loadConfig("mcp", { force: true });
		return ok;
	};

	// 源文件页的保存与换文件动作（搬迁到 config/configModal/ConfigRawTab.tsx，行为不变）。
	const { handleSaveRaw, handleRawFileChange, applyRawFileChange } = useConfigRawEditing({
		api,
		configTargetOption,
		rawContent,
		setRawContent,
		rawFileName,
		setRawFileName,
		baselineRawRef,
		hasRawDraft: dirtyTabs.has("config:raw"),
		setPendingRawFile,
		setLoading,
		setError,
		setConfigDiagnostic,
		saveAndReload,
		reloadConfig: loadConfig,
	});

	// ── 导出 / 导入 ─────────────────────────────────────

	// 导出/导入（非本机目标显式拒绝；文件动作在 config/useConfigTransfer 内，ConfigModal 保持瘦身）。
	const { handleExport, handleImport } = useConfigTransfer({
		target: configTarget,
		exportConfig: () => api.config.export(),
		importConfig: (text) => api.config.import(text),
		notify: showToast,
		onError: setError,
		onImported: onSaved,
		clearConfigDirty: () => {
			for (const key of ALL_CONFIG_DIRTY_KEYS) clearDirty(key);
		},
		reloadAfterImport: () => loadConfig(tab, { force: true }),
	});

	/** 安全管理面板句柄（顶部统一保存按钮经 saveByKey 调用其 save） */
	const securitySectionRef = useRef<SecuritySectionHandle>(null);
	/** DSH 配置页句柄（顶部统一保存按钮经 saveByKey 调用其 save）。 */
	const dshConfigRef = useRef<DshConfigTabHandle>(null);

	// DSH runtime 安装态门控：runtime 不可用时整 Tab 换成安装引导（含下载与手动导入），
	// 不渲染任何 dsh 配置表单（表单此时项项都会失败）。
	const dshRuntimeStatus = useAtomValue(dshRuntimeStatusAtom);
	const dshUi = dshUiVisibilityFor(dshRuntimeStatus.state);

	/** 安全管理草稿脏状态上报：有修改 markDirty("security")，保存成功/卸载清标记。 */
	const handleSecurityDirtyChange = useCallback(
		(dirty: boolean) => {
			if (dirty) markDirty("security");
			else clearDirty("security");
		},
		[markDirty, clearDirty],
	);

	const handleMcpDirtyChange = useCallback(
		(dirty: boolean) => {
			if (dirty) markDirty("config:mcp");
			else clearDirty("config:mcp");
		},
		[markDirty, clearDirty],
	);

	/** 资源管理器（项目作用域）MCP 页脏状态。必须 memo：McpTab 的 load 依赖这个回调，
	 *  传内联箭头会让每次父组件渲染都重跑 load，用磁盘内容冲掉正在输入的表单（见 McpTab 的 ref 兼底）。 */
	const handleResourceMcpDirtyChange = useCallback(
		(dirty: boolean) => {
			if (dirty) markDirty("mcp");
			else clearDirty("mcp");
		},
		[markDirty, clearDirty],
	);

	/** 按 tab 编码分发到对应保存 handler；返回是否保存成功（false = 保存失败，由错误提示区展示原因）。 */
	const saveByKey = async (tabKey: string): Promise<boolean> => {
		switch (tabKey) {
			case "dsh": {
				// runtime 不可用时整页是安装引导，没有任何可保存草稿：直接视为保存通过，
				// 否则统一保存按钮会因为拿不到 DshConfigTab 句柄而一直报「保存失败」。
				if (!dshUi.showDshConfigForms) return true;
				// DSH 页保存成功后显式清未保存标记：子分区草稿已清空并上报 false，
				// 但卸载/收起的分区可能残留脏来源，这里兜底保证黄点消失。
				const ok = (await dshConfigRef.current?.save()) ?? false;
				if (ok) clearDirty("dsh");
				return ok;
			}
			case "config:models":
				// 新增/编辑页把字段保存在页内 state，先提交完整草稿；
				// 提交回调会回写 modelsData 并回到列表，不能在同一次调用里读取尚未刷新的父级 state。
				if (addingProvider || editingProvider) {
					providerPageSavePendingRef.current = true;
					providerPageSaveRef.current?.();
					return true;
				}
				{
					const ok = await handleSaveModels();
					// 模型页的「每模型默认思考档位」写的是 settings.json：同一次保存顺带落盘该草稿，
					// 否则用户在本页点保存后 settings 黄点仍在、也不知道还要去设置页再存一次。
					// 只走「只写不重载」路径，避免冲掉 auth/raw 等其它页的未保存草稿。
					if (ok && dirtyTabsRef.current.has("config:settings")) return saveSettingsDraftOnly();
					return ok;
				}
			case "config:auth":
				return handleSaveAuth();
			case "config:settings":
				return handleSaveSettings();
			case "config:trust":
				return handleSaveTrust();
			case "config:mcp": {
				if (configTargetOption) return handleSaveWslMcp();
				const ok = (await mcpTabRef.current?.save()) ?? false;
				if (ok) {
					clearDirty("config:mcp");
					onSaved();
					showToast(t("config.saved"));
				}
				return ok;
			}
			case "mcp": {
				const ok = (await resourceMcpTabRef.current?.save()) ?? false;
				if (ok) {
					clearDirty("mcp");
					onSaved();
					showToast(t("config.saved"));
				}
				return ok;
			}
			case "config:raw":
				return handleSaveRaw();
			case "skills":
				return saveGlobalSkillEditor();
			case "prompts":
				return handleSaveEditPrompt();
			case "security":
				return securitySectionRef.current?.save() ?? false;
			default:
				// extensions 即时生效页无保存语义，无 dirty 时按钮不可点
				return false;
		}
	};

	/** 当前后端分页下的 tab 编码（DSH 页固定 "dsh"，Pi 页按 section:tab）。 */
	const currentTabKey = backendPane === "dsh" ? "dsh" : sectionTabValue(section, tab);

	/**
	 * 顶部统一保存按钮：模型页的新增/编辑供应商是一个页内子页面，
	 * 但它仍然属于 models 草稿；当前 tab 保持 models 时始终保存整个 models 草稿。
	 * 这样用户在供应商表单页点击窗口顶部保存时，不会因为子页面没有独立 tab 而漏掉变更。
	 */
	const handleSaveCurrent = async () => {
		if (saving) return;
		// 远端目标下统一保存按钮被禁用（远端面板自带「应用 patch」按钮），这里再兜底一次，
		// 保证任何键盘/外壳触发都不会把本机 models/settings 写入磁盘。
		if (configTarget.kind === "ssh") return;
		// 新增/编辑页的第一次点击只把页内草稿提交到 modelsData；
		// React state 更新后下一轮 effect 会自动继续落盘，用户无需再点一次保存。
		if (backendPane === "pi" && section === "config" && tab === "models" && (addingProvider || editingProvider)) {
			providerPageSavePendingRef.current = true;
			providerPageSaveRef.current?.();
			return;
		}
		// 无修改也放开再次保存；skills/prompts/extensions 等无保存语义的页
		// 由各自 save 方法（如 saveGlobalSkillEditor 的 !editingGlobalSkill 守卫）返回 false，不产生副作用。
		await saveByKey(currentTabKey);
	};

	/** 切换配置目标：同目标忽略；远端有未应用 patch 时先显式确认（丢弃草稿不能静默发生）。 */
	/**
	 * 兜底：当前配置页不属于当前环境（深链直接点到「认证」而环境是 SSH 等）时立刻落到该环境第一页。
	 * 渲染层绝不能出现「内容渲染了、导航里却没有这一页」的半截状态。
	 */
	useEffect(() => {
		if (section !== "config") return;
		if (isConfigTabSupported(configTarget, tab)) return;
		setTab(firstConfigTabForTarget(configTarget));
	}, [section, tab, configTarget]);

	// Pi 环境切换动作（搬迁到 config/configModal/ConfigEnvSwitch.ts，行为不变）。
	const { commitTargetSwitch, handleConfigTargetChange, discardDraftsAndSwitch, saveDraftsAndSwitch } = useConfigEnvSwitch({
		pendingEnvSwitch,
		setPendingEnvSwitch,
		remoteConfigDirty,
		remoteDirtyFiles,
		resetRemoteDirty,
		configTarget,
		setConfigTarget,
		dirtyTabsRef,
		clearDirty,
		setTab,
		setSection,
		baselineModelsRef,
		baselineAuthRef,
		baselineSettingsRef,
		baselineTrustRef,
		baselineRawRef,
		baselineWslMcpRef,
		setModelsData,
		setAuthData,
		setSettingsData,
		setTrustData,
		setRawContent,
		setRawFileName,
		setWslMcpRaw,
		setAddingProvider,
		setEditingProvider,
		setAddingAuth,
		setEditingGlobalSkill,
		setEditGlobalContent,
		setEditingPrompt,
		setEditPromptContent,
		rememberTarget: rememberConfigTarget,
		saveByKey,
	});
	/**
	 * 打开配置管理时默认落在当前远端项目所在主机：「模型配置 / Pi 设置」展示的是当前环境的 pi 配置，
	 * 远端项目里默认展示本机配置等于把用户引到错误的机器上写盘。
	 *
	 * 只在本次打开的第一个决定生效（ref 闩）：用户随后主动切回本机的情况不能被打开动作改写。
	 * 主机清单未到齐时不决定（否则会先渲染本机再自己跳一次）；有未保存草稿时不打断用户。
	 */
	const activeProjectForTarget = useAtomValue(projectByIdAtomFamily(props.projectId ?? ""));
	const configSurfaceOpen = open || embedded === true;
	const autoConfigTargetAppliedRef = useRef(false);
	useEffect(() => {
		if (!configSurfaceOpen) {
			autoConfigTargetAppliedRef.current = false;
			return;
		}
		// 项目资源管理器（resourceOnly）只渲染技能/提示词/扩展，与配置目标无关：不改写那边的状态。
		if (resourceOnly) return;
		if (autoConfigTargetAppliedRef.current) return;
		if (!remoteConfigHostsLoaded) return;
		autoConfigTargetAppliedRef.current = true;
		const next = preferredConfigTargetForProject(activeProjectForTarget, remoteConfigHosts, configTarget);
		if (samePiConfigTarget(next, configTarget)) return;
		if (hasUnsavedConfigDrafts(dirtyTabsRef.current) || remoteConfigDirty) return;
		commitTargetSwitch(next);
	}, [configSurfaceOpen, resourceOnly, activeProjectForTarget, remoteConfigHosts, remoteConfigHostsLoaded, configTarget, remoteConfigDirty, commitTargetSwitch]);
	/**
	 * 记住的环境若已不存在（主机被删/被禁用、档案被删），静默回本机：
	 * 停在一个读不到的机器上，用户看到的是一屏连接错误，而回本机是唯一有意义的安全落点。
	 */
	const rememberedTargetCheckedRef = useRef(false);
	useEffect(() => {
		if (!configSurfaceOpen) {
			rememberedTargetCheckedRef.current = false;
			return;
		}
		if (resourceOnly) {
			rememberedTargetCheckedRef.current = true;
			return;
		}
		if (rememberedTargetCheckedRef.current || !remoteConfigHostsLoaded) return;
		rememberedTargetCheckedRef.current = true;
		if (configTarget.kind === "local") return;
		const exists = remoteConfigHosts.some((host) => (configTarget.kind === "ssh" ? host.kind === "ssh" && host.id === configTarget.hostId : host.kind === "wsl"));
		if (!exists) commitTargetSwitch({ kind: "local" });
	}, [configSurfaceOpen, resourceOnly, remoteConfigHostsLoaded, remoteConfigHosts, configTarget, commitTargetSwitch]);

	/** 关闭弹框：有未保存修改时先弹保存确认（借鉴设置页），无修改直接关闭。 */
	const handleClose = () => {
		if (dirtyTabs.size > 0) {
			setCloseConfirmOpen(true);
		} else if (remoteConfigDirty) {
			// 远端 patch 不会随本机保存动作落盘；必须显式确认丢弃后才能关闭。
			setRemoteDiscardConfirmOpen(true);
		} else {
			props.onClose();
		}
	};

	// ── 嵌入模式句柄与状态上报（ConfigPane） ──
	// 外壳标题栏的保存/导出/导入/关闭按钮直接委托给这里的同一个 handler；
	// saving/hasDirty 同步到外壳，驱动保存按钮禁用与黄点，避免两处按钮行为分叉。
	useImperativeHandle(
		props.paneRef,
		() => ({
			saveCurrent: () => handleSaveCurrent(),
			exportConfig: handleExport,
			importConfig: handleImport,
			// 外壳统一关闭确认时调用：把配置分区全部脏来源逐个保存（dsh:<nav> 归并 dsh），
			// 与独立 ConfigModal「保存并关闭」走同一套 saveByKey 分发，任一失败返回 false 留在窗口。
			saveAllDirty: async () => {
				// 只有远端 patch 时本机保存链路无事可做；返回 false 让外壳保留窗口，用户可显式丢弃/关闭。
				if (dirtyTabs.size === 0 && remoteConfigDirty) return false;
				const roots = new Set<string>();
				for (const key of dirtyTabs) {
					roots.add(key.startsWith("dsh:") ? "dsh" : key);
				}
				for (const key of orderDirtyKeysForSave(roots)) {
					const ok = await saveByKey(key);
					if (!ok) return false;
				}
				return true;
			},
		}),
		[handleSaveCurrent, handleExport, handleImport, saveByKey, dirtyTabs],
	);
	// 标题栏保存触发页内提交后，下一轮 state 更新会重新进入 models 保存路径；
	// 这样用户一次点击即可完成「页内草稿 → models.json」两步提交。
	useEffect(() => {
		if (!providerPageSavePendingRef.current) return;
		if (addingProvider || editingProvider) return;
		if (!dirtyTabs.has("config:models")) {
			// 表单校验未通过时没有 models 草稿可保存，避免 pending 标记污染下一次进入页面。
			providerPageSavePendingRef.current = false;
			return;
		}
		providerPageSavePendingRef.current = false;
		void handleSaveModels();
	}, [addingProvider, editingProvider, dirtyTabs, handleSaveModels]);

	useEffect(() => {
		props.onPaneStateChange?.({
			saving,
			hasDirty: hasDirty || remoteConfigDirty,
			exportImportAllowed: configTarget.kind === "local",
			unsaved: configUnsavedSummary ? { totalCount: configUnsavedSummary.totalCount, items: configUnsavedSummary.items } : { totalCount: 0, items: [] },
		});
	}, [saving, hasDirty, configUnsavedSummary, configTarget, props.onPaneStateChange]);

	/**
	 * 关闭确认框选择保存并关闭：汇总**全部**脏来源逐个保存（不是只存当前 tab），
	 * dsh:<nav> 归并到 dsh 一个保存入口；任一保存失败则留下重试（错误已展示在内容区）。
	 * 顺序由 orderDirtyKeysForSave 保证 settings 最后（它的重载会连带刷新 models/auth/raw）。
	 */
	const handleSaveAndClose = async () => {
		const roots = new Set<string>();
		for (const key of dirtyTabs) {
			roots.add(key.startsWith("dsh:") ? "dsh" : key);
		}
		for (const key of orderDirtyKeysForSave(roots)) {
			const ok = await saveByKey(key);
			if (!ok) return;
		}
		setCloseConfirmOpen(false);
		if (remoteConfigDirty) {
			// 本机脏项已逐个保存，但远端 patch 不在本机保存链路内：转成显式丢弃确认。
			setRemoteDiscardConfirmOpen(true);
			return;
		}
		props.onClose();
	};

	/** 关闭确认框选择放弃更改：丢弃所有未保存修改直接关闭。 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		props.onClose();
	};

	// 导航 = 该环境的能力表（configTabsForTarget）：不在表里的页不出现在导航里，
	// 也就不会出现「点进去显示不支持」的死页。能力边界由状态条一句话说明。
	const supportedConfigTabs = configTabsForTarget(configTarget);
	const allConfigNavItems: ConfigNavItem[] = [
		{ id: "models", label: t("config.nav.models"), icon: <Cpu size={14} aria-hidden="true" /> },
		{ id: "auth", label: t("config.nav.auth"), icon: <KeyRound size={14} aria-hidden="true" /> },
		{ id: "oauth", label: t("config.nav.oauth"), icon: <LogIn size={14} aria-hidden="true" /> },
		{ id: "settings", label: t("config.nav.settings"), icon: <Settings2 size={14} aria-hidden="true" /> },
		{ id: "trust", label: t("config.nav.trust"), icon: <ShieldCheck size={14} aria-hidden="true" /> },
		{ id: "mcp", label: t("config.nav.mcp"), icon: <PlugZap size={14} aria-hidden="true" /> },
		{ id: "raw", label: t("config.nav.raw"), icon: <FileCode2 size={14} aria-hidden="true" /> },
	];
	const configNavItems = allConfigNavItems.filter((item) => supportedConfigTabs.includes(item.id));
	const showSecurityPage = securityPageSupported(configTarget);
	const showResourcePages = resourcePagesSupported(configTarget);

	// 加载态/错误提示：每个 TabsContent 顶部共用（Tabs 会卸载非激活内容，不能只挂一处）。
	// 同一 JSX element 可在多处渲染，不会造成重复副作用。
	const statusBlock = (
		<>
			{loading && (
				<div className="flex items-center justify-center gap-2 py-12 text-control text-muted-foreground">
					<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
					{t("common.loading")}
				</div>
			)}
			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
		</>
	);

	// 配置诊断卡：config 组 5 个子页顶部共用（任意子页打开时都显示）。
	const configDiagnosticBlock = configDiagnostic ? <ConfigDiagnosticCard diagnostic={configDiagnostic} onOpenDocs={() => api.app.openExternal(configDiagnostic.docsUrl, true)} onOpenRaw={() => setTab("raw")} /> : null;

	if (!open && !embedded) return null;

	// 对话框主体（后端分页 + 各种确认弹窗）：独立 ConfigModal 与嵌入分区共用同一份，
	// 唯一的差别是外壳（Dialog/标题栏按钮）由谁提供——embedded 时宿主 SettingsModal 承担。
	const modalBody = (
		<>
			{/* 顶层分页：Pi 配置管理（带环境下拉，默认在左）/ DSH 配置管理（在右）。
			    环境下拉挂在 Pi 分页上：整个 Pi 面板按所选环境加载，页内不再有第二个选择器。 */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{!resourceOnly && !dshPaneHidden && <ConfigBackendSwitch pane={backendPane} showDsh embedded={embedded} piDirty={hasPiDirty} dshDirty={hasDshDirty} target={configTarget} hosts={remoteConfigHosts} disabled={saving} onSelectPane={(next) => selectBackendPane(next)} onSelectTarget={handleConfigTargetChange} />}
				{/* 两个后端页都保持挂载（hidden 切换），切换后端不会丢草稿。 */}
				<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", backendPane === "dsh" ? "" : "hidden")}>
					{/* runtime 安装态不再整页替换：概览页内嵌 DshRuntimeSection 状态自适应区块，
					    未装→安装引导，已装→版本/目录/卸载/导入，一个页面操作完。 */}
					{dshRuntimeStatus.state !== "checking" ? (
						<DshConfigTab ref={dshConfigRef} onDirtyChange={handleDshDirtyChange} dirtyNavIds={dshDirtyNavIds} onOpenUsageProbeDialog={(provider) => openUsageProbeDialogFor(provider, "dsh")} providerOrder={dshProviderOrder} onReorderProviders={handleReorderDshProviders} onResetProviders={handleResetDshProviderOrder} />
					) : null}
				</div>
				<div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", backendPane === "pi" ? "" : "hidden")}>
					{/* 环境状态条：当前环境 + 连接状态/重试/密码补录 + 该环境的能力边界（唯一的环境说明位置）。 */}
					{!resourceOnly ? <ConfigEnvironmentStatus target={configTarget} hosts={remoteConfigHosts} disabled={saving} /> : null}
					{/* 默认浅色主题整页同底（bg-background），避免顶栏白 / 下方多层灰的割裂感。
			  左侧导航 = shadcn Vertical Tabs：TabsList 竖排（orientation=vertical），
			  组标题是非 trigger 的普通 div；窄屏（<820px）回退为横向导航。 */}
					<Tabs
						orientation="vertical"
						value={sectionTabValue(section, tab)}
						onValueChange={(value) => {
							const parsed = parseSectionTabValue(value);
							setSection(parsed.section);
							if (parsed.tab) setTab(parsed.tab);
							// 用量查询弹窗随配置 tab 联动：切走（如 认证 → 模型）即关闭，
							// 防止弹窗跨 tab 悬挂被误认为「自动弹出」。
							setUsageProbeDialog(null);
							// 记住位置：下次打开 Pi 管理页时回到同一 tab
							rememberConfigTab(value);
						}}
						className="config-layout grid min-h-0 flex-1 gap-0 bg-transparent"
					>
						<ConfigNavSidebar resourceOnly={resourceOnly} items={configNavItems} dirtyTabs={dirtyTabs} showSecurityPage={showSecurityPage} showResourcePages={showResourcePages} />
						<TabsContent value="config:models" className="config-main min-w-0">
							<div className="config-content">
								{wslTargetHost ? <WslConfigSourceHint host={wslTargetHost} file="models" /> : null}
								{remoteTargetHostId ? (
									<RemoteConfigPanel key={"remote-models-" + remoteTargetHostId} file="models" hostId={remoteTargetHostId} hostLabel={remoteHostLabel} onDirtyChange={(dirty) => markRemoteDirty("models", dirty)} />
								) : (
									<>
										{statusBlock}
										{configDiagnosticBlock}
										{!loading && (
											<>
												{/* TokenDance：安装写的是本机 models.json + DSH 目录，非本机环境不提供该入口 */}
												{configTarget.kind === "local" ? <TokenDancePanel configured={!!modelsData.providers[TOKENDANCE_PROVIDER]} onInstalled={handleTokendanceInstalled} /> : null}
												<ModelsTab
													data={modelsData}
													expandedProvider={expandedProvider}
													focusProvider={focusedProvider}
													onOpenUsageProbeDialog={(provider) => guardProviderOp(() => openUsageProbeDialogFor(provider, "pi"))}
													addingProvider={addingProvider}
													providerPageSaveRef={providerPageSaveRef}
													hiddenProviders={hiddenProviders}
													onToggleHiddenProvider={handleToggleHiddenProvider}
													providerOrder={providerOrder}
													providerOrderScope={providerOrderScope}
													onReorderProviders={handleReorderProviders}
													onResetProviders={handleResetProviderOrder}
													hiddenModels={hiddenModels}
													onToggleHiddenModel={handleToggleHiddenModel}
													fetchingProvider={fetchingProvider}
													fetchedModels={fetchedModels}
													fetchModelsErrorByProvider={fetchModelsErrorByProvider}
													testingProvider={testingProvider}
													testResult={testResult}
													testModelIdByProvider={testModelIdByProvider}
													testProxyModeByProvider={testProxyModeByProvider}
													authKeyHints={authKeyHints}
													saving={saving}
													onToggleProvider={(name) => setExpandedProvider(expandedProvider === name ? null : name)}
													onStartAddProvider={() => {
														setAddingProvider(true);
													}}
													onCancelAddProvider={() => setAddingProvider(false)}
													onConfirmAddProvider={handleAddProvider}
													editingProvider={editingProvider}
													onStartEditProvider={(name) => setEditingProvider(name)}
													onCancelEditProvider={() => setEditingProvider(null)}
													onConfirmEditProvider={handleEditProvider}
													onDeleteProvider={handleDeleteProvider}
													onDuplicateProvider={handleDuplicateProvider}
													onDeleteProviders={handleDeleteProviders}
													onApplyModelsTransfer={handleApplyModelsTransfer}
													onAddModel={handleAddModel}
													onUpdateModel={handleUpdateModel}
													onUpdateModelThinkingLevel={handleUpdateModelThinkingLevel}
													onUpdateModelUserAgent={handleUpdateModelUserAgent}
													getModelUserAgentOverride={(providerName, modelId) => getModelUserAgentOverride(modelsData.providers[providerName]?.modelOverrides, modelId)}
													onUpdateModelThinkingLevelDefault={settingsLoaded ? handleUpdateModelThinkingLevelDefault : undefined}
													getModelThinkingLevelDefault={settingsLoaded ? (providerName, modelId) => modelThinkingLevelOf(settingsData, providerName, modelId) ?? "" : undefined}
													onDeleteModel={handleDeleteModel}
													onDeleteModels={handleDeleteModels}
													onResetModel={handleResetModelToAdaptive}
													resettingModelKey={resettingModelKey}
													onFetchModels={(name) => guardProviderOp(() => handleFetchModels(name))}
													onTestProvider={(name) => guardProviderOp(() => handleTestProvider(name))}
													onChangeTestModelId={(providerName, modelId) =>
														setTestModelIdByProvider((current) => ({
															...current,
															[providerName]: modelId,
														}))
													}
													onChangeTestProxyMode={(providerName, mode) =>
														setTestProxyModeByProvider((current) => ({
															...current,
															[providerName]: mode,
														}))
													}
													onClearTestResult={() => setTestResult(null)}
													onSave={handleSaveModels}
													onChangeProvider={(name, field, value) => {
														const provider = modelsData.providers[name];
														if (!provider) return;
														setModelsData({
															...modelsData,
															providers: {
																...modelsData.providers,
																[name]: { ...provider, [field]: value },
															},
														});
														markDirty("config:models");
													}}
												/>
											</>
										)}
									</>
								)}
							</div>
						</TabsContent>
						<TabsContent value="config:auth" className="config-main min-w-0">
							<ConfigAuthTab
								wslTargetHost={wslTargetHost}
								remoteTargetHostId={remoteTargetHostId}
								remoteHostLabel={remoteHostLabel}
								statusBlock={statusBlock}
								configDiagnosticBlock={configDiagnosticBlock}
								loading={loading}
								data={authData}
								expandedAuth={expandedAuth}
								addingAuth={addingAuth}
								newAuthName={newAuthName}
								saving={saving}
								modelsData={modelsData}
								hiddenAuthProviders={hiddenAuthProviders}
								providerOrder={providerOrder}
								providerOrderScope={providerOrderScope}
								onReorderProviders={handleReorderProviders}
								onResetProviders={handleResetProviderOrder}
								onToggleHiddenAuthProvider={handleToggleHiddenAuthProvider}
								onToggleAuth={(name) => setExpandedAuth(expandedAuth === name ? null : name)}
								onStartAddAuth={() => {
									setAddingAuth(true);
									setNewAuthName("");
								}}
								onCancelAddAuth={() => setAddingAuth(false)}
								onChangeNewAuthName={setNewAuthName}
								onConfirmAddAuth={(name, key) => handleAddAuth(name, key)}
								onDuplicateAuth={handleDuplicateAuth}
								onDeleteAuths={handleDeleteAuths}
								onDeleteAuth={handleDeleteAuth}
								onUpdate={handleUpdateAuth}
								onSave={handleSaveAuth}
								onOpenUsageProbeDialog={(provider) => guardProviderOp(() => openUsageProbeDialogFor(provider, "pi"))}
							/>
						</TabsContent>
						<TabsContent value="config:oauth" className="config-main min-w-0">
							<div className="config-content">
								{/* OAuth 登录跑的是本机 pi 的认证流程：非本机环境不提供该页（导航按能力表过滤） */}
								<OAuthTab />
							</div>
						</TabsContent>
						<TabsContent value="config:settings" className="config-main min-w-0">
							<ConfigSettingsTab
								wslTargetHost={wslTargetHost}
								remoteTargetHostId={remoteTargetHostId}
								remoteHostLabel={remoteHostLabel}
								onRemoteDirtyChange={(dirty) => markRemoteDirty("settings", dirty)}
								statusBlock={statusBlock}
								configDiagnosticBlock={configDiagnosticBlock}
								loading={loading}
								settingsLoaded={settingsLoaded}
								data={settingsData}
								saving={saving}
								modelsData={modelsData}
								authData={authData}
								discoveredModels={discoveredModels}
								onChange={(data, reason) => {
									setSettingsData(data);
									if (reason === "normalize") {
										// 打开页面时的格式归一（补全 compaction / 剔除旧版 retry 字段）不是用户编辑：
										// 同步刷新基准快照，否则 settings.json 里只要缺这几个键，每次进设置都会报「有未保存更改」。
										baselineSettingsRef.current = deepClone(data);
										return;
									}
									markDirty("config:settings");
								}}
								onSave={handleSaveSettings}
							/>
						</TabsContent>
						<TabsContent value="skills" className="config-main min-w-0">
							<ConfigSkillsTab
								api={api}
								statusBlock={statusBlock}
								resourceScope={resourceScope}
								effectiveProjectId={effectiveProjectId}
								resourceOnly={resourceOnly}
								scopeSelector={resourceScopeSelector}
								resourceOptions={resourceOptions}
								projects={projects}
								projectOverrides={projectResourcesData.overrides}
								discoverySkills={discoveryData.skills}
								onError={setError}
								editingSkill={editingGlobalSkill}
								setEditingSkill={setEditingGlobalSkill}
								editContent={editGlobalContent}
								setEditContent={setEditGlobalContent}
								editLoading={editGlobalLoading}
								editSaved={editGlobalSaved}
								markDirty={markDirty}
								clearDirty={clearDirty}
								sourceProjectId={projectId}
								data={skillsData}
								loading={loading}
								creating={creatingSkill}
								newName={newSkillName}
								newDescription={newSkillDescription}
								newLocationId={newSkillLocationId}
								onRefresh={refreshSkills}
								onChangeNewName={setNewSkillName}
								onChangeNewDescription={setNewSkillDescription}
								onChangeNewLocation={setNewSkillLocationId}
								onCreate={handleCreateSkill}
								onToggle={handleToggleSkill}
								onDelete={setDeleteSkillConfirm}
								onEdit={handleEditGlobalSkill}
								onRename={handleRenameGlobalSkill}
							/>
						</TabsContent>
						<TabsContent value="prompts" className="config-main min-w-0">
							<div className="config-content">
								{statusBlock}
								{!loading && (
									<PromptsTab
										scope={resourceScope}
										projectId={resourceScope === "project" ? effectiveProjectId : undefined}
										scopeSelector={resourceScopeSelector}
										projectOverrides={projectResourcesData.overrides}
										discoveryPrompts={discoveryData.prompts}
										data={promptsData}
										loading={loading}
										creating={creatingPrompt}
										newName={newPromptName}
										newDescription={newPromptDescription}
										editingTemplate={editingPrompt}
										editContent={editPromptContent}
										editLoading={editPromptLoading}
										editSaving={editPromptSaving}
										onRefresh={refreshPrompts}
										onOpenRoot={() => {
											if (resourceScope === "project" && effectiveProjectId) {
												void api.projectResources.openDirectory(effectiveProjectId, "prompts").catch((err) => setError(err instanceof Error ? err.message : String(err)));
												return;
											}
											void api.prompts.openFolder(resourceOptions).catch((err) => setError(err instanceof Error ? err.message : String(err)));
										}}
										onDelete={setDeletePromptConfirm}
										onEdit={handleEditPrompt}
										onRename={handleRenamePrompt}
										onChangeNewName={setNewPromptName}
										onChangeNewDescription={setNewPromptDescription}
										onCreate={handleCreatePrompt}
										onToggle={handleTogglePrompt}
										onQuickSave={handleQuickSavePrompt}
										onCancelEdit={handleCancelEditPrompt}
										onChangeEditContent={(value) => {
											setEditPromptContent(value);
											markDirty("prompts");
										}}
										onSaveEdit={handleSaveEditPrompt}
									/>
								)}
							</div>
						</TabsContent>
						<TabsContent value="extensions" className="config-main min-w-0">
							<div className="config-content">
								{statusBlock}
								<ExtensionsTab
									scope={resourceScope}
									projectId={resourceScope === "project" ? effectiveProjectId : undefined}
									projectOverrides={projectResourcesData.overrides}
									discoveryExtensions={discoveryData.extensions}
									scopeSelector={resourceScopeSelector}
									data={extensionsData}
									loading={extensionsLoading}
									uninstallingSource={uninstallingExtensionSource}
									onRefresh={() => refreshExtensions(true)}
									// 开关后的刷新刻意走轻量路径：开关只改 enabled，主进程缓存里重投影即可，
									// 不必付出一次全量扫描（pi list + npm view）——那会让开关行长时间处于 pending。
									onRefreshAfterToggle={() => refreshExtensions(false)}
									onToggle={handleToggleExtension}
									onUninstall={handleRequestExtensionUninstall}
									onUninstallProjectPackage={handleRequestProjectPackageUninstall}
									onShowDiscoveredInFolder={(item) => void handleOpenDiscoveredLocation(item)}
									onShowInFolder={(extension) => void handleOpenExtensionLocation(extension)}
								/>
							</div>
						</TabsContent>
						{/* forceMount：面板自管草稿（工具动作 allow/ask/deny、目录边界等只在组件 state 里），
						    切走再回来不能丢未保存编辑；inactive 必须 hidden，否则叠在别的 tab 上。 */}
						<TabsContent value="security" forceMount className="config-main min-w-0 data-[state=inactive]:hidden">
							<div className="config-content">
								<SecuritySection ref={securitySectionRef} onDirtyChange={handleSecurityDirtyChange} />
							</div>
						</TabsContent>
						{/* forceMount：MCP 页自管草稿，切走再回来不能丢未保存编辑；inactive 必须 hidden，否则叠在别的 tab 上。 */}
						<TabsContent value="config:mcp" forceMount className="config-main min-w-0 data-[state=inactive]:hidden">
							<ConfigMcpTab
								remoteTargetHostId={remoteTargetHostId}
								remoteHostLabel={remoteHostLabel}
								onRemoteDirtyChange={(dirty) => markRemoteDirty("mcp", dirty)}
								wslTargetHost={wslTargetHost}
								statusBlock={statusBlock}
								configDiagnosticBlock={configDiagnosticBlock}
								loading={loading}
								saving={saving}
								wslMcpRaw={wslMcpRaw}
								setWslMcpRaw={setWslMcpRaw}
								markDirty={markDirty}
								onSaveWslMcp={handleSaveWslMcp}
								projectId={projectId}
								mcpTabRef={mcpTabRef}
								onGoToExtensions={() => {
									// 同区导航：扩展页与 MCP 页都属于配置区/项目资源区，保留当前作用域。
									setSection("extensions");
								}}
								onDirtyChange={handleMcpDirtyChange}
							/>
						</TabsContent>
						{/* 只有项目资源管理器会走到这里（见左侧导航同名开关）；forceMount：面板自管草稿，
						    切走再回来不能丢未保存编辑，inactive 必须 hidden，否则叠在别的 tab 上。 */}
						{resourceOnly ? (
							<TabsContent value="mcp" forceMount className="config-main min-w-0 data-[state=inactive]:hidden">
								<div className="config-content flex min-h-0 flex-col">
									<McpTab ref={resourceMcpTabRef} projectId={resourceOnly && projectKind !== "chat" ? effectiveProjectId : undefined} projectName={resourceOnly ? projectName : undefined} onGoToExtensions={() => setSection("extensions")} onDirtyChange={handleResourceMcpDirtyChange} />
								</div>
							</TabsContent>
						) : null}
						<TabsContent value="config:trust" className="config-main min-w-0">
							<ConfigTrustTab
								remoteTargetHostId={remoteTargetHostId}
								remoteHostLabel={remoteHostLabel}
								onRemoteDirtyChange={(dirty) => markRemoteDirty("trust", dirty)}
								wslTargetHost={wslTargetHost}
								statusBlock={statusBlock}
								configDiagnosticBlock={configDiagnosticBlock}
								loading={loading}
								data={trustData}
								saving={saving}
								onChange={(data) => {
									setTrustData(data);
									markDirty("config:trust");
								}}
								onSave={handleSaveTrust}
							/>
						</TabsContent>
						<TabsContent value="config:raw" className="config-main min-w-0">
							<ConfigRawTab
								wslTargetHost={wslTargetHost}
								statusBlock={statusBlock}
								configDiagnosticBlock={configDiagnosticBlock}
								loading={loading}
								piConfigDir={piConfigDir}
								fileName={rawFileName}
								content={rawContent}
								saving={saving}
								onChangeFileName={handleRawFileChange}
								onChangeContent={(value) => {
									setRawContent(value);
									markDirty("config:raw");
								}}
								onSave={handleSaveRaw}
							/>
						</TabsContent>
					</Tabs>
				</div>
			</div>

			{/* 用量查询配置弹窗：模型/认证/DSH 共用入口；provider + backend 决定配置落盘位置。
			    必须放在所有 Tabs 之外：Radix Tabs 默认卸载非激活内容，若放回 config:models
			    TabsContent 内，切到认证 tab / DSH 页时弹窗组件会随卸载消失（点击无反应的 bug）。 */}
			<UsageProbeConfigDialog
				open={usageProbeDialog != null}
				onClose={() => setUsageProbeDialog(null)}
				provider={usageProbeDialog?.provider ?? ""}
				backend={usageProbeDialog?.backend}
				// 「让 AI 帮我查」写入输入框后关宿主窗口：内嵌分区优先走宿主设置窗口的
				// 统一关闭确认（含系统设置草稿），独立弹窗退回自身的未保存确认流程。
				onCloseHost={props.onRequestHostClose ?? handleClose}
			/>

			<ConfigModalDialogs
				deleteSkillConfirm={deleteSkillConfirm}
				confirmDeleteSkill={confirmDeleteSkill}
				setDeleteSkillConfirm={setDeleteSkillConfirm}
				uninstallExtensionConfirm={uninstallExtensionConfirm}
				confirmUninstallExtension={confirmUninstallExtension}
				setUninstallExtensionConfirm={setUninstallExtensionConfirm}
				uninstallProjectPackageConfirm={uninstallProjectPackageConfirm}
				confirmUninstallProjectPackage={confirmUninstallProjectPackage}
				setUninstallProjectPackageConfirm={setUninstallProjectPackageConfirm}
				deletePromptConfirm={deletePromptConfirm}
				confirmDeletePrompt={confirmDeletePrompt}
				setDeletePromptConfirm={setDeletePromptConfirm}
				closeConfirmOpen={closeConfirmOpen}
				setCloseConfirmOpen={setCloseConfirmOpen}
				configUnsavedSummary={configUnsavedSummary}
				configUnsavedMessage={configUnsavedMessage}
				handleSaveAndClose={handleSaveAndClose}
				handleDiscardAndClose={handleDiscardAndClose}
				pendingEnvSwitch={pendingEnvSwitch}
				setPendingEnvSwitch={setPendingEnvSwitch}
				discardDraftsAndSwitch={discardDraftsAndSwitch}
				saveDraftsAndSwitch={saveDraftsAndSwitch}
				pendingRawFile={pendingRawFile}
				setPendingRawFile={setPendingRawFile}
				applyRawFileChange={applyRawFileChange}
				remoteDiscardConfirmOpen={remoteDiscardConfirmOpen}
				setRemoteDiscardConfirmOpen={setRemoteDiscardConfirmOpen}
				resetRemoteDirty={resetRemoteDirty}
				onClose={props.onClose}
				deleteConfirm={deleteConfirm}
				setDeleteConfirm={setDeleteConfirm}
			/>
		</>
	);

	if (embedded) {
		// 嵌入模式：宿主提供 Dialog 外壳与标题栏，这里只渲染内容；
		// 外层 config-pane 继承 .config-modal 同款控件密度（font/button/input 尺寸）。
		return <div className="config-pane flex min-h-0 min-w-0 flex-1 flex-col">{modalBody}</div>;
	}

	// 独立模式：完整 Dialog（标题栏含保存/导出/导入/关闭；内容与嵌入模式完全一致）
	return (
		<ConfigModalShell
			open={open}
			onRequestClose={handleClose}
			sizeClass={configModalSizeClass}
			saving={saving}
			hasDirty={hasDirty}
			targetKind={configTarget.kind}
			backendPane={backendPane}
			section={section}
			onSaveCurrent={() => void handleSaveCurrent()}
			onExport={handleExport}
			onImport={handleImport}
		>
			{modalBody}
		</ConfigModalShell>
	);
}
