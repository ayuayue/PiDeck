import { Button } from "./components/ui-shadcn/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui-shadcn/tabs";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "./components/ui-shadcn/dialog";
import { X, Cpu, FileCode2, FileText, KeyRound, LogIn, Puzzle, Settings2, Shield, ShieldCheck, Sparkles, PlugZap, FolderOpen } from "lucide-react";
import { cn } from "./lib/utils";
import { WORKBENCH_DIALOG_SIZE_CLASS } from "./components/common/workbenchDialogSize";
import { deepClone } from "./utils/deepEqual";
import { showNotice } from "./utils/notice";
import { formatIpcError } from "./utils/ipcError";
import { applyAdaptiveTemplateReset, collectModelSpecPatches, deriveProviderCompat, mergeAdaptiveModelTemplate } from "./utils/modelSpecAutoFill";
import type { FetchedModel, ConfigProxyMode } from "../../shared/types/fetchedModel";
import { Component, forwardRef, useRef, useState, useEffect, useCallback, useMemo, type ReactNode, type Ref } from "react";
import type { PiDesktopApi } from "../../preload";
import { OAuthTab } from "./config/OAuthTab";
import { ConfigBackendSwitch, ConfigEnvironmentStatus } from "./config/ConfigEnvironmentSwitch";
import { configTabsForTarget, firstConfigTabForTarget, isConfigTabSupported, resourcePagesSupported, securityPageSupported } from "./config/configEnvironmentModel";
import type { PiConfigTargetHost } from "./config/piConfigTargetModel";
import { RemoteConfigPanel } from "./config/RemoteConfigPanel";
import { ConfigDiagnosticCard } from "./config/ConfigDiagnosticCard";
import { WslConfigSourceHint } from "./config/WslConfigSourceHint";
import { usePiConfigDir } from "./config/usePiConfigDir";
import { usePiConfigTargetView } from "./config/usePiConfigTargetView";
import { useConfigTransfer } from "./config/useConfigTransfer";
import { useResourceTarget } from "./config/useResourceTarget";
import type { PiConfigTarget } from "../../shared/piConfig";
import { ModelsTab } from "./config/ModelsTab";
import { TokenDancePanel } from "./config/TokenDancePanel";
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
import { loadLastConfigTab, loadLastConfigTarget, normalizeModelsFile, parseJsonObject, parseSectionTabValue, rememberConfigTab, rememberConfigTarget, sectionTabValue, type ConfigSection } from "./config/configModal/configModalStorage";
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
import { ConfigStatusBlock } from "./config/configModal/ConfigStatusBlock";
import { useConfigDeepLinkFocus } from "./config/configModal/useConfigDeepLinkFocus";
import { useConfigBackendPane } from "./config/configModal/useConfigBackendPane";
import { useConfigWriteFlow } from "./config/configModal/useConfigWriteFlow";
import { useConfigLoadEffects } from "./config/configModal/useConfigLoadEffects";
import { useConfigTargetAutoSelect } from "./config/configModal/useConfigTargetAutoSelect";
import { useConfigPaneBridge, type ConfigPaneHandle, type ConfigPaneState } from "./config/configModal/useConfigPaneBridge";
import { useModelBaseUrlAutofix } from "./config/configModal/useModelBaseUrlAutofix";
import { useConfigDirtyMarks } from "./config/configModal/useConfigDirtyMarks";
import { useConfigSaveOrchestration } from "./config/configModal/useConfigSaveOrchestration";
import { useConfigUiPreferences } from "./config/configModal/useConfigUiPreferences";
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
import { replaceProviderHiddenIds, sameHiddenModelEntries } from "./config/hiddenModels";
import type { ProviderModelIdIndex } from "../../shared/types/modelSpecs";
import { DirtyMarker } from "./components/app/settings/SettingRows";
import { isValidProviderName } from "../../shared/providerName";
import { mergeProviderDraft, type AddProviderDraft } from "./config/addProviderDraft";
import { useAtomValue } from "jotai";
import { dshRuntimeStatusAtom } from "./atoms";
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

// 嵌入分区的对外契约（句柄 + 状态快照）随桥一起放在 hook 模块里，这里再导出供外壳（SettingsModal）引用。
export type { ConfigPaneHandle, ConfigPaneState } from "./config/configModal/useConfigPaneBridge";

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
	/** 深链要展开的供应商卡片（ModelsTab 消费）。声明在深链 effect 之前：回调需要直接引用它。 */
	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	// 深链落点（圆球「去配置用量」等）：搬迁到 config/configModal/useConfigDeepLinkFocus，行为不变。
	useConfigDeepLinkFocus({ open, focusConfigTab, focusProvider, resourceOnly, setSection, setTab, setFocusedProvider, setExpandedProvider });
	// 顶层后端分页（Pi / DSH）：搬迁到 config/configModal/useConfigBackendPane，行为不变。
	const { backendPane, selectBackendPane, dshPaneHidden } = useConfigBackendPane({ resourceOnly, focusBackendPane, setUsageProbeDialog });
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// 未保存修改集合与派生展示值（脏标记）：搬迁到 config/configModal/useConfigDirtyMarks，行为不变。
	const { dirtyTabs, setDirtyTabs, dirtyTabsRef, hasDirty, dshDirtyNavIds, hasDshDirty, hasPiDirty, configUnsavedSummary, configUnsavedMessage, markDirty, clearDirty, handleDshDirtyChange } = useConfigDirtyMarks();
	/** 资源页工具栏右侧的作用域标识：resourceOnly 展示固定项目名；主配置页无下拉（undefined 不渲染）。 */
	const resourceScopeSelector = resourceOnly ? (
		<div className="flex h-8 max-w-[16rem] items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-control text-muted-foreground" title={projectName ?? t("config.resourceScope.projectFallback")} aria-label={t("config.resourceScope.label")}>
			<FolderOpen className="size-3.5 shrink-0" aria-hidden="true" />
			<span className="truncate">{projectName?.trim() || t("config.resourceScope.projectFallback")}</span>
		</div>
	) : undefined;
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

	// 展开的 auth 项
	const [expandedAuth, setExpandedAuth] = useState<string | null>(null);
	// 新增 provider（弹窗开关）
	const [addingProvider, setAddingProvider] = useState(false);
	/** 正在编辑的 provider key（编辑弹窗目标）；null = 无编辑弹窗。 */
	const [editingProvider, setEditingProvider] = useState<string | null>(null);
	/** 新增/编辑供应商页的当前草稿保存入口，由设置窗口标题栏按钮调用。 */
	const providerPageSaveRef = useRef<(() => void) | undefined>(undefined);
	/** 标题栏保存触发页内提交后，等待下一轮 state 更新再执行 models.json 落盘。 */
	const providerPageSavePendingRef = useRef(false);
	/** 用户隐藏的供应商 / 模型与卡片排序偏好（搬迁到 config/configModal/useConfigUiPreferences，行为不变）。 */
	const {
		hiddenProviders,
		setHiddenModels,
		hiddenModels,
		hiddenAuthProviders,
		providerOrder,
		dshProviderOrder,
		handleToggleHiddenProvider,
		handleToggleHiddenModel,
		handleToggleHiddenAuthProvider,
		handleReorderProviders,
		handleReorderDshProviders,
		handleResetProviderOrder,
		handleResetDshProviderOrder,
		providerOrderScope,
	} = useConfigUiPreferences({ api, modelsData, authData });
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

	// 检测后的 baseUrl 自动补全（搬迁到 config/configModal/useModelBaseUrlAutofix，行为不变）。
	const applySuggestedBaseUrl = useModelBaseUrlAutofix({ setModelsData, markDirty });

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

	// 取数副作用（provider 迁移重读 / 主机清单重读 / 资源页刷新）：搬迁到 config/configModal/useConfigLoadEffects，行为不变。
	useConfigLoadEffects({
		open,
		paneVisible,
		setRemoteConfigHosts,
		setRemoteConfigHostsLoaded,
		loadConfig,
		section,
		tab,
		resourceScope,
		effectiveProjectId,
		bumpResourceGeneration,
		resourceTarget,
		configTarget,
		refreshSkills,
		refreshPrompts,
		refreshExtensions,
		setError,
	});

	const piConfigDir = usePiConfigDir(open);

	/** DSH 配置页句柄（顶部统一保存按钮经 saveByKey 调用其 save）。声明在落盘流程之前：TokenDance 安装回调要用。 */
	const dshConfigRef = useRef<DshConfigTabHandle>(null);

	// 落盘流程（统一保存 + 安装后整页重载）：搬迁到 config/configModal/useConfigWriteFlow，行为不变。
	const { saveAndReload, handleTokendanceInstalled } = useConfigWriteFlow({ setSaving, setError, onSaved, showToast, clearDirty, reloadConfig: loadConfig, dshConfigRef });

	// ── Models 操作 ──────────────────────────────────────

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

	// DSH runtime 安装态门控：runtime 不可用时整 Tab 换成安装引导（含下载与手动导入），
	// 不渲染任何 dsh 配置表单（表单此时项项都会失败）。
	const dshRuntimeStatus = useAtomValue(dshRuntimeStatusAtom);
	const dshUi = dshUiVisibilityFor(dshRuntimeStatus.state);

	// 保存与关闭编排（顶部统一保存 / 保存全部脏来源 / 关闭确认）：搬迁到 config/configModal/useConfigSaveOrchestration，行为不变。
	const { handleSecurityDirtyChange, handleMcpDirtyChange, handleResourceMcpDirtyChange, saveByKey, currentTabKey, handleSaveCurrent, handleClose, handleSaveAndClose, handleDiscardAndClose } = useConfigSaveOrchestration({
		configTarget,
		configTargetOption,
		dshUi,
		saving,
		backendPane,
		section,
		tab,
		addingProvider,
		editingProvider,
		providerPageSaveRef,
		providerPageSavePendingRef,
		dirtyTabs,
		dirtyTabsRef,
		clearDirty,
		markDirty,
		onSaved,
		showToast,
		handleSaveModels,
		saveSettingsDraftOnly,
		handleSaveAuth,
		handleSaveSettings,
		handleSaveTrust,
		handleSaveWslMcp,
		handleSaveRaw,
		saveGlobalSkillEditor,
		handleSaveEditPrompt,
		securitySectionRef,
		dshConfigRef,
		mcpTabRef,
		resourceMcpTabRef,
		remoteConfigDirty,
		setCloseConfirmOpen,
		setRemoteDiscardConfirmOpen,
		onClose: props.onClose,
	});

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
	// 打开时的目标选择（默认项目所在主机 / 记住的环境失效则回本机）：搬迁到 config/configModal/useConfigTargetAutoSelect，行为不变。
	useConfigTargetAutoSelect({ props, open, embedded, resourceOnly, remoteConfigHosts, remoteConfigHostsLoaded, configTarget, remoteConfigDirty, commitTargetSwitch, dirtyTabsRef });

	// 嵌入分区句柄与状态上报（搬迁到 config/configModal/useConfigPaneBridge，行为不变）。
	useConfigPaneBridge({ paneRef: props.paneRef, onPaneStateChange: props.onPaneStateChange, handleSaveCurrent, handleExport, handleImport, saveByKey, dirtyTabs, remoteConfigDirty, saving, hasDirty, configTarget, configUnsavedSummary, providerPageSavePendingRef, addingProvider, editingProvider, handleSaveModels });

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
	const statusBlock = <ConfigStatusBlock loading={loading} error={error} />;

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
		<ConfigModalShell open={open} onRequestClose={handleClose} sizeClass={configModalSizeClass} saving={saving} hasDirty={hasDirty} targetKind={configTarget.kind} backendPane={backendPane} section={section} onSaveCurrent={() => void handleSaveCurrent()} onExport={handleExport} onImport={handleImport}>
			{modalBody}
		</ConfigModalShell>
	);
}
