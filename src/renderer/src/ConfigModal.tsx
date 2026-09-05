import { Button, buttonVariants } from "./components/ui-shadcn/button";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "./components/ui-shadcn/tabs";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "./components/ui-shadcn/dialog";
import { ConfirmDialog } from "./components/ui-shadcn/ConfirmDialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "./components/ui-shadcn/alert-dialog";
import {
	X,
	Cpu,
	FileCode2,
	FileText,
	KeyRound,
	Puzzle,
	Settings2,
	Shield,
	ShieldCheck,
	Sparkles,
	PlugZap,
} from "lucide-react";
import { cn } from "./lib/utils";
import { deepClone } from "./utils/deepEqual";
import { showNotice } from "./utils/notice";
import { applyAdaptiveTemplateReset, collectModelSpecPatches, deriveProviderCompat, mergeAdaptiveModelTemplate } from "./utils/modelSpecAutoFill";
import type { FetchedModel, ConfigProxyMode } from "../../shared/types/fetchedModel";
import {
	Component,
	forwardRef,
	useRef,
	useState,
	useEffect,
	useCallback,
	useImperativeHandle,
	useMemo,
	type ReactNode,
	type Ref,
} from "react";
import type { PiDesktopApi } from "../../preload";
import { AuthTab } from "./config/AuthTab";
import { ModelsTab } from "./config/ModelsTab";
import { TokenDancePanel, type TokendanceInstallOutcome } from "./config/TokenDancePanel";
import { UsageProbeConfigDialog } from "./config/UsageProbeConfigDialog";
import { removeSelectedModelIndexes } from "./config/modelBatchSelection";
import { openDocsInSystemBrowser } from "./config/ConfigShared";
import { RawTab } from "./config/RawTab";
import { TrustTab } from "./config/TrustTab";
import { McpTab, type McpTabHandle } from "./config/McpTab";
import { SettingsTab } from "./config/SettingsTab";
import { PromptsTab } from "./config/PromptsTab";
import { SkillsTab } from "./config/SkillsTab";
import { ExtensionsTab } from "./config/ExtensionsTab";
import { SecuritySection, type SecuritySectionHandle } from "./components/config/SecuritySection";
import { DshLogo, PiLogo } from "./components/session/SessionSourceBadge";
import { DshConfigTab, type DshConfigTabHandle } from "./config/DshConfigTab";
import { t } from "./i18n";
import { CodeMirrorEditor } from "./components/app/CodeMirrorEditor";
import { translateBuiltinPromptDescription } from "./composerBehavior";
import type {
	AuthFile,
	ConfigTab,
	ModelItem,
	ModelsFile,
	SettingsFile,
} from "./config/configTypes";
import type { ConfigFileDiagnostic, CreatePiPromptTemplateInput, PiExtensionListResult, PiExtensionSummary, PiPromptTemplateListResult, PiPromptTemplateSummary, PiSkillListResult, PiSkillLocation, PiSkillSummary } from "../../shared/types";
import { getProviderHeaders, KNOWN_PROVIDER_ENDPOINTS } from "./config/providerHeaders";
import { TOKENDANCE_PROVIDER } from "../../shared/tokendance";
import { ALL_CONFIG_DIRTY_KEYS, dirtyKeysClearedByReload, dirtyKeysPreservedOnReload, reconcileConfigDirty } from "./config/configDirtyMarks";
import { formatConfigUnsavedMessage, summarizeConfigUnsavedChanges, type ConfigUnsavedItem } from "./config/configUnsavedChangesSummary";
import { DirtyMarker } from "./components/app/settings/SettingRows";
import { isValidProviderName } from "../../shared/providerName";
import { useAtomValue } from "jotai";
import { dshRuntimeStatusAtom } from "./atoms";
import { dshUiVisibilityFor } from "../../shared/types/dshRuntime";

const api: PiDesktopApi = (window as unknown as { piDesktop: PiDesktopApi })
	.piDesktop;

// ── 配置弹窗左侧导航 = shadcn Vertical Tabs ──
// config 组子页（模型/认证/设置/信任/MCP/原始文件）用 "config:<tab>" 复合值，
// 其余组直接以 section 名作 value；Tabs 受控 value 由此编码，业务仍走 section/tab 双 state，
// loadConfig 等既有依赖零改动。
type ConfigSection =
	| "config"
	| "security"
	| "skills"
	| "prompts"
	| "extensions";

// 注意：修改 ConfigSection/ConfigTab 枚举时需同步更新 CONFIG_SECTIONS/CONFIG_TABS 校验数组

/** section+tab → Tabs value（config 组子页编码为 "config:<tab>"）。 */
function sectionTabValue(section: ConfigSection, tab: ConfigTab): string {
	return section === "config" ? `config:${tab}` : section;
}

/** localStorage 键：Pi 管理页上次打开的 tab（重开弹窗时恢复位置，跨应用重启保留）。 */
const CONFIG_LAST_TAB_KEY = "pideck-config-last-tab";

/** localStorage 键：配置管理顶层后端分页（Pi/DSH）上次选择（重开弹窗时恢复）。 */
const CONFIG_BACKEND_PANE_KEY = "pideck-config-backend-pane";

/** 读取上次选定的配置管理后端分页；无记录/值失效时回退 Pi（默认后端，Pi 标签在左）。 */
function loadLastConfigBackendPane(): "dsh" | "pi" {
	try {
		return localStorage.getItem(CONFIG_BACKEND_PANE_KEY) === "dsh" ? "dsh" : "pi";
	} catch {
		return "pi";
	}
}

/** 全部合法 section / config 组子 tab，用于校验持久化值（避免版本更新后残留旧值导致无高亮）。 */
const CONFIG_SECTIONS: readonly ConfigSection[] = ["config", "security", "skills", "prompts", "extensions"];
const CONFIG_TABS: readonly ConfigTab[] = ["models", "auth", "settings", "trust", "mcp", "raw"];

/**
 * 读取上次打开的 tab；localStorage 不可用、无记录或值已失效时返回 null（由调用方回退默认值）。
 * Radix Dialog 关闭会卸载内容，state 在每次打开时重建，因此需要从外部存储恢复。
 */
function loadLastConfigTab(): { section: ConfigSection; tab?: ConfigTab } | null {
	try {
		const raw = localStorage.getItem(CONFIG_LAST_TAB_KEY);
		if (!raw) return null;
		const parsed = parseSectionTabValue(raw);
		if (!CONFIG_SECTIONS.includes(parsed.section)) return null;
		if (parsed.section === "config" && (!parsed.tab || !CONFIG_TABS.includes(parsed.tab))) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** Tabs value → section/tab；非 config 组无子 tab。 */
function parseSectionTabValue(value: string): {
	section: ConfigSection;
	tab?: ConfigTab;
} {
	const idx = value.indexOf(":");
	if (idx > 0) {
		return {
			section: value.slice(0, idx) as ConfigSection,
			tab: value.slice(idx + 1) as ConfigTab,
		};
	}
	return { section: value as ConfigSection };
}

/**
 * 配置页必须能打开用户手写/旧版本生成的非标准 models.json。
 * pi 自身对配置较宽松，但 UI 会访问 provider.models.length / map；这里先把缺失或异常字段归一化，
 * 避免单个 provider 配置错误导致整个 renderer 白屏。
 */
function normalizeModelsFile(value: unknown): ModelsFile {
	const rawProviders =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as { providers?: unknown }).providers
			: undefined;
	const providers: ModelsFile["providers"] = {};
	if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
		return { providers };
	}
	for (const [name, rawProvider] of Object.entries(rawProviders)) {
		const provider =
			rawProvider && typeof rawProvider === "object" && !Array.isArray(rawProvider)
				? (rawProvider as Record<string, unknown>)
				: {};
		const rawModels = provider.models;
		providers[name] = {
			...provider,
			models: Array.isArray(rawModels)
				? rawModels
					.filter((model): model is ModelItem | string =>
						Boolean(model) &&
						(typeof model === "object" && !Array.isArray(model) || typeof model === "string"),
					)
					.map((model) =>
						typeof model === "string" ? { id: model } : model,
					)
				: [],
		};
	}
	return { providers };
}

function ConfigDiagnosticCard(props: {
	diagnostic: ConfigFileDiagnostic;
	onOpenDocs: () => void;
	onOpenRaw: () => void;
}) {
	const { diagnostic } = props;
	return (
		<div className="config-diagnostic-card">
			<div>
				<strong>{t("config.diagnosticLoadFailed", { fileName: diagnostic.fileName })}</strong>
				<span>
					{diagnostic.line && diagnostic.column
						? t("config.diagnosticLocation", {
								line: diagnostic.line,
								column: diagnostic.column,
								message: diagnostic.message,
							})
						: diagnostic.message}
				</span>
				<small>
					{t("config.diagnosticHelp")}{" "}
					<a href={diagnostic.docsUrl} onClick={openDocsInSystemBrowser(diagnostic.docsUrl)}>
						{t("config.openOfficialDocs")}
					</a>
				</small>
			</div>
			{diagnostic.snippet && <pre>{diagnostic.snippet}</pre>}
			<div className="config-diagnostic-actions">
				<Button size="sm"  variant="default" onClick={props.onOpenRaw}>{t("config.openRawFile")}</Button>
				<Button size="sm"  variant="outline" onClick={props.onOpenDocs}>{t("config.openOfficialDocs")}</Button>
			</div>
		</div>
	);
}

type ConfigModalProps = {
	open: boolean;
	onClose: () => void;
	onSaved: () => void;
	/** 当前项目路径：有值时合并项目 `.mcp.json` / `.pi/mcp.json`（只读）。 */
	projectPath?: string;
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
	/** 未保存清单（tabKey/itemKey 为 i18n key，关闭确认整体展示）。 */
	unsaved: { totalCount: number; items: ConfigUnsavedItem[] };
};

export type ConfigPaneProps = {
	onClose: () => void;
	onSaved?: () => void;
	/** 当前项目路径：有值时合并项目 `.mcp.json` / `.pi/mcp.json`（只读）。 */
	projectPath?: string;
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
export const ConfigPane = forwardRef<ConfigPaneHandle, ConfigPaneProps>(
	function ConfigPane({ onClose, onSaved, projectPath, focusConfigTab, focusProvider, focusBackendPane, onStateChange, onRequestClose }, ref) {
		return (
			<ConfigModalContent
				open
				onClose={onClose}
				onSaved={onSaved ?? (() => {})}
				projectPath={projectPath}
				focusConfigTab={focusConfigTab}
				focusProvider={focusProvider}
				focusBackendPane={focusBackendPane}
				embedded
				paneRef={ref}
				onPaneStateChange={onStateChange}
				onRequestHostClose={onRequestClose}
			/>
		);
	},
);

// 小窗口保留外边距，避免 Pi 管理页完全压住工作区；821px 以上恢复桌面弹框尺寸。
// DialogContent 默认带 sm:max-w-lg，必须显式覆盖它，否则小窗口会变成窄高条。
const configModalSizeClass = "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] sm:max-w-[min(1300px,80vw)]";

class ConfigModalErrorBoundary extends Component<
	{ open: boolean; onClose: () => void; children: ReactNode },
	{ error: Error | null }
> {
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
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", configModalSizeClass, "config-modal", "[--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]")}>
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
									<a
										href="https://pi.dev/docs/latest/models"
										onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/models")}
									>{t("config.docsModels")}</a>
									{" / "}
									<a
										href="https://pi.dev/docs/latest/settings"
										onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/settings")}
									>{t("config.docsSettings")}</a>
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
	/** 嵌入模式：不渲染 Dialog 外壳与标题栏按钮（宿主提供窗口），自身仍维护全部状态/保存/关闭确认逻辑 */
	embedded?: boolean;
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
	const { open, onClose, onSaved, projectPath, embedded, focusConfigTab, focusProvider, focusBackendPane } = props;
	// 弹窗每次打开都会重新挂载（Radix Dialog 关闭即卸载内容），
	// 用 lazy initializer 在挂载时读一次 localStorage，恢复到上次所在 tab。
	const [lastTab] = useState(loadLastConfigTab);
	const [section, setSection] = useState<ConfigSection>(lastTab?.section ?? "config");
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
	const openUsageProbeDialogFor = useCallback(
		(provider: string, backend: "pi" | "dsh") => {
			setUsageProbeDialog({ provider, backend });
		},
		[],
	);
	useEffect(() => {
		if (!open) return;
		if (focusConfigTab) setTab(focusConfigTab);
		if (focusProvider) {
			setFocusedProvider(focusProvider);
			setTab("models");
			setExpandedProvider(focusProvider);
		}
		// focusProvider/focusConfigTab 变化即应用：设置窗口已开时点圆球跳转也要生效。
	}, [open, focusConfigTab, focusProvider]);
	/** 配置管理顶层后端分页：以 Pi 为主（默认 Pi，且 Pi 标签在左），dsh 页在右。
	 *  新建会话默认后端跟随设置项 defaultAgentBackend（默认 pi），与此处配置管理入口相互独立。
	 *  弹窗每次打开都会重建 state，这里从 localStorage 恢复上次选定的后端分页。 */
	const [backendPane, setBackendPane] = useState<"dsh" | "pi">(focusBackendPane ?? loadLastConfigBackendPane);
	/** 切换后端分页并持久化：退出配置管理再进入时停留在上次选定的后端。 */
	const selectBackendPane = useCallback((value: string) => {
		const next = value === "pi" ? "pi" : "dsh";
		setBackendPane(next);
		// 用量查询弹窗是 per-provider 的：切换 Pi/DSH 页时关闭，
		// 避免「从认证页点开、切到模型页后弹窗还挂着」的越界出现（用户反馈的闪现 bug）。
		setUsageProbeDialog(null);
		try {
			localStorage.setItem(CONFIG_BACKEND_PANE_KEY, next);
		} catch {
			/* localStorage 不可用（隐私模式等）时静默失败，仅本次会话内不记忆 */
		}
	}, []);
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	/** 各 tab 未保存修改集合：key 用 sectionTabValue 编码（如 "config:models"/"skills"），顶部保存按钮与关闭确认依赖它 */
	const [dirtyTabs, setDirtyTabs] = useState<Set<string>>(new Set());
	/** loadConfig 不能依赖 dirtyTabs（否则切 tab 会重建回调并误触发重载）；用 ref 读最新脏集合。 */
	const dirtyTabsRef = useRef(dirtyTabs);
	dirtyTabsRef.current = dirtyTabs;
	/** MCP 页句柄：自管加载/保存，顶部统一保存按钮经 saveByKey 转发。 */
	const mcpTabRef = useRef<McpTabHandle>(null);
	/** 关闭弹框时存在未保存修改 → 弹出保存确认（借鉴设置页关闭逻辑） */
	const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
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
	const configUnsavedSummary = useMemo(
		() => summarizeConfigUnsavedChanges(dirtyTabs),
		[dirtyTabs],
	);
	const configUnsavedMessage = useMemo(
		() => formatConfigUnsavedMessage(configUnsavedSummary, t),
		[configUnsavedSummary],
	);

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
	const [settingsData, setSettingsData] = useState<SettingsFile>({});
	/** 自动发现的模型：auth-only 供应商通过已知端点获取的模型列表 */
	const [discoveredModels, setDiscoveredModels] = useState<
		Record<string, Array<{ id: string; name?: string }>>
	>({});
	const [trustData, setTrustData] = useState<Record<string, boolean>>({});
	const [skillsData, setSkillsData] = useState<PiSkillListResult>({
		locations: [],
		skills: [],
	});
	const [extensionsData, setExtensionsData] = useState<PiExtensionListResult>({
		extensions: [],
		raw: "",
	});
	const [extensionsLoading, setExtensionsLoading] = useState(false);
	const [creatingSkill, setCreatingSkill] = useState(false);
	const [uninstallingExtensionSource, setUninstallingExtensionSource] = useState<string | null>(null);
	const [newSkillName, setNewSkillName] = useState("");
	const [newSkillDescription, setNewSkillDescription] = useState("");
	const [newSkillLocationId, setNewSkillLocationId] = useState<PiSkillLocation["id"]>("pi-global");
	const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<PiSkillSummary | null>(null);
	const [editingGlobalSkill, setEditingGlobalSkill] = useState<PiSkillSummary | null>(null);
	const [editGlobalContent, setEditGlobalContent] = useState("");
	const [editGlobalLoading, setEditGlobalLoading] = useState(false);
	const [editGlobalSaving, setEditGlobalSaving] = useState(false);
	const [editGlobalSaved, setEditGlobalSaved] = useState(false);
	const [promptsData, setPromptsData] = useState<PiPromptTemplateListResult>({
		templates: [],
		globalDir: "",
	});
	const [creatingPrompt, setCreatingPrompt] = useState(false);
	const [newPromptName, setNewPromptName] = useState("");
	const [newPromptDescription, setNewPromptDescription] = useState("");
	const [editingPrompt, setEditingPrompt] = useState<PiPromptTemplateSummary | null>(null);
	const [editPromptContent, setEditPromptContent] = useState("");
	const [editPromptLoading, setEditPromptLoading] = useState(false);
	const [editPromptSaving, setEditPromptSaving] = useState(false);
	/** 用户已删除的内置模板名称（仅当前会话有效） */
	const [deletedBuiltinNames, setDeletedBuiltinNames] = useState<Set<string>>(new Set());
	/** 待确认删除的 Prompt 模板（删除前弹确认框） */
	const [deletePromptConfirm, setDeletePromptConfirm] = useState<PiPromptTemplateSummary | null>(null);
	const [uninstallExtensionConfirm, setUninstallExtensionConfirm] = useState<PiExtensionSummary | null>(null);
	const [rawContent, setRawContent] = useState("");
	const [rawFileName, setRawFileName] = useState("models.json");
	// pi 全局配置目录（源文件页标注实际编辑位置）；加载失败时静默降级不显示路径。
	const [piConfigDir, setPiConfigDir] = useState<string | null>(null);

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
		reconcileConfigDirty(
			next,
			"config:raw",
			{ fileName: rawFileName, content: rawContent },
			baselineRawRef.current,
		);
		dirtyTabsRef.current = next;
		// 只有真正增删了 key 才提交 state，避免每次键入都重建相同 Set 触发无关重渲染
		const changed = next.size !== before.size || [...next].some((key) => !before.has(key));
		if (changed) setDirtyTabs(next);
	}, [modelsData, authData, settingsData, trustData, rawContent, rawFileName]);

	// 展开的 provider / auth 项
	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	const [expandedAuth, setExpandedAuth] = useState<string | null>(null);
	// 新增 provider
	const [addingProvider, setAddingProvider] = useState(false);
	const [newProviderName, setNewProviderName] = useState("");
	// 重命名 provider
	const [renamingProvider, setRenamingProvider] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	// 新增 auth
	const [addingAuth, setAddingAuth] = useState(false);
	const [newAuthName, setNewAuthName] = useState("");
	// 远程拉取模型列表
	const [fetchingProvider, setFetchingProvider] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<Record<string, FetchedModel[]>>({});
	// 正在重置为自适应的模型行 key（`${providerName}\u0000${index}`），null 表示无。
	const [resettingModelKey, setResettingModelKey] = useState<string | null>(null);

	/**
	 * 根据 API 类型返回对应的获取模型提示。
	 * 不同服务对 /models 端点的支持不同，提供针对性的指导。
	 */
	function getFetchModelsHintByApi(api: string | undefined, baseUrl: string): string {
		switch (api) {
			case "openai-completions":
				return t("config.fetchModelsHintOpenaiCompletions", { baseUrl });
			case "openai-responses":
				return t("config.fetchModelsHintOpenai", { baseUrl });
			case "openai-codex-responses":
				return t("config.fetchModelsHintOpenaiCodex");
			case "anthropic-messages":
				return t("config.fetchModelsHintAnthropic");
			case "google-generative-ai":
				return t("config.fetchModelsHintGoogle");
			case "mistral-conversations":
				return t("config.fetchModelsHintMistral");
			default:
				// 未知 API 类型时使用通用提示
				return t("config.fetchModelsHint");
		}
	}

	// 每个 provider 独立的模型拉取错误状态，避免全局 setError 相互覆盖
	const [fetchModelsErrorByProvider, setFetchModelsErrorByProvider] = useState<
		Record<string, string | undefined>
	>({});
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
	const [testModelIdByProvider, setTestModelIdByProvider] = useState<
		Record<string, string>
	>({});
	// 每个 provider 的测试/拉取模型代理模式：follow 跟随全局，pi/desktop 强制走对应代理，off 强制直连。
	// 独立于全局代理开关：有些供应商（如海外网关）只在代理下才通，而全局开关会影响所有会话。
	const [testProxyModeByProvider, setTestProxyModeByProvider] = useState<
		Record<string, ConfigProxyMode>
	>({});
	// 代理配置快照（用于下拉里展示实际 URL，给用户明确反馈走的是哪个代理）。
	const [proxySettings, setProxySettings] = useState<{
		piProxyUrl: string;
		desktopProxyUrl: string;
	} | null>(null);
	useEffect(() => {
		api.settings
			.get()
			.then((s) =>
				setProxySettings({
					piProxyUrl: s.piProxyUrl ?? "",
					desktopProxyUrl: s.desktopProxyUrl ?? "",
				}),
			)
			.catch(() => setProxySettings(null));
	}, []);
	// 删除确认对话框
	const [deleteConfirm, setDeleteConfirm] = useState<{
		type: "provider" | "model" | "auth" | "batch";
		title: string;
		message: string;
		onConfirm: () => void;
	} | null>(null);

	const loadConfig = useCallback(
		async (target: ConfigTab, options?: { force?: boolean; silent?: boolean }) => {
			// silent：测试连接成功后回读磁盘用——不置 loading，避免 ModelsTab 在
			// `!loading && ...` 条件下被卸载重建、滚动容器内容塔缩后 scrollTop 归零。
			if (!options?.silent) setLoading(true);
			setError(null);
			setConfigDiagnostic(null);
			try {
				// 切 tab 时不要把仍有草稿的内存冲掉；保存/导入传 force 才整页对齐磁盘。
				const preserved = options?.force
					? new Set<string>()
					: dirtyKeysPreservedOnReload(target, dirtyTabsRef.current);
				const skipModels = preserved.has("config:models");
				const skipAuth = preserved.has("config:auth");
				const skipSettings = preserved.has("config:settings");
				const skipTrust = preserved.has("config:trust");
				const skipMcp = preserved.has("config:mcp");
				const skipRaw = preserved.has("config:raw");
				if (target === "models") {
					const res = await api.config.getModels();
					if (!skipModels) {
						const parsed = normalizeModelsFile(res.parsed);
						setModelsData(parsed);
						baselineModelsRef.current = deepClone(parsed);
					}
					if (!skipRaw) {
						setRawContent(res.raw);
						setRawFileName("models.json");
						baselineRawRef.current = { fileName: "models.json", content: res.raw };
					}
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "auth") {
					const res = await api.config.getAuth();
					if (!skipAuth) {
						setAuthData(res.parsed as AuthFile);
						baselineAuthRef.current = deepClone(res.parsed as AuthFile);
					}
					if (!skipRaw) {
						setRawContent(res.raw);
						setRawFileName("auth.json");
						baselineRawRef.current = { fileName: "auth.json", content: res.raw };
					}
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "settings") {
					// 同时加载 settings、auth 和 models 数据，确保 defaultProvider / defaultModel 下拉能聚合所有可用信息
					const [settingsRes, authRes, modelsRes] = await Promise.all([
						api.config.getSettings(),
						api.config.getAuth(),
						api.config.getModels(),
					]);
					if (!skipSettings) {
						setSettingsData(settingsRes.parsed as SettingsFile);
						baselineSettingsRef.current = deepClone(settingsRes.parsed as SettingsFile);
					}
					if (!skipAuth) {
						setAuthData(authRes.parsed as AuthFile);
						baselineAuthRef.current = deepClone(authRes.parsed as AuthFile);
					}
					if (!skipModels) {
						const parsed = normalizeModelsFile(modelsRes.parsed);
						setModelsData(parsed);
						baselineModelsRef.current = deepClone(parsed);
					}
					if (!skipRaw) {
						setRawContent(settingsRes.raw);
						setRawFileName("settings.json");
						baselineRawRef.current = { fileName: "settings.json", content: settingsRes.raw };
					}
					setConfigDiagnostic(settingsRes.diagnostic ?? null);

					// 对于 auth 中有但 models 中没有模型的供应商，自动尝试获取模型列表
					const authProviders = authRes.parsed as AuthFile;
					const modelsProviders = normalizeModelsFile(modelsRes.parsed).providers;
					const discovered: Record<string, Array<{ id: string; name?: string }>> = {};
					const fetchPromises: Array<Promise<void>> = [];

					for (const [providerName, authEntry] of Object.entries(authProviders)) {
						// 跳过已有模型的供应商
						if (modelsProviders[providerName]?.models?.length) continue;
						const apiKey =
							typeof authEntry.key === "string" ? authEntry.key : "";
						if (!apiKey) continue;

						// 情况1：从 KNOWN_PROVIDER_ENDPOINTS 获知该供应商的 API 端点
						const knownEndpoint = KNOWN_PROVIDER_ENDPOINTS[providerName];
						// 情况2：从 models.json 中该供应商的配置获知 baseUrl
						const modelsProvider = modelsProviders[providerName];
						const modelsBaseUrl =
							modelsProvider && typeof modelsProvider.baseUrl === "string"
								? modelsProvider.baseUrl
								: undefined;
						const baseUrl = knownEndpoint?.baseUrl ?? modelsBaseUrl;
						if (!baseUrl) continue;

						const apiType =
							knownEndpoint?.apiType ??
							(typeof modelsProvider?.api === "string"
								? modelsProvider.api
								: undefined);

						fetchPromises.push(
							api.config
								.fetchModels(
									baseUrl,
									apiKey,
									apiType,
									getProviderHeaders(modelsProvider?.headers),
								)
								.then((result) => {
									if (result.success && result.models) {
										discovered[providerName] = result.models;
									}
								})
								.catch(() => {
									// 静默失败，不阻塞 UI
								}),
						);
					}

					if (fetchPromises.length > 0) {
						// 不 await，在后台获取后更新状态即可
						void Promise.allSettled(fetchPromises).then(() => {
							if (Object.keys(discovered).length > 0) {
								setDiscoveredModels(discovered);
							}
						});
					}
				} else if (target === "trust") {
					const res = await api.config.getTrust();
					if (!skipTrust) {
						setTrustData(res.parsed as Record<string, boolean>);
						baselineTrustRef.current = deepClone(res.parsed as Record<string, boolean>);
					}
					if (!skipRaw) {
						setRawContent(res.raw);
						setRawFileName("trust.json");
						baselineRawRef.current = { fileName: "trust.json", content: res.raw };
					}
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "mcp") {
					// MCP 页自己拉盘；这里只同步源文件编辑器和 force 重载。
					if (!skipRaw) {
						const res = await api.config.getMcp(projectPath);
						setRawContent(res.writableRaw);
						setRawFileName("mcp.json");
						baselineRawRef.current = { fileName: "mcp.json", content: res.writableRaw };
					}
					if (options?.force && !skipMcp) void mcpTabRef.current?.reload();
				} else if (target === "raw") {
					// 源文件 tab 复用当前 tab 对应的文件
					const fileName =
						tab === "models"
							? "models.json"
							: tab === "auth"
								? "auth.json"
								: tab === "trust"
									? "trust.json"
									: tab === "mcp"
										? "mcp.json"
										: "settings.json";
					if (!skipRaw) setRawFileName(fileName);
					// 基准快照随内容一起更新：切文件后新旧草稿都以新文件为比较基准
					const res =
						fileName === "models.json"
							? await api.config.getModels()
							: fileName === "auth.json"
								? await api.config.getAuth()
								: fileName === "trust.json"
									? await api.config.getTrust()
									: fileName === "mcp.json"
										? await api.config.getMcp(projectPath).then((snapshot) => ({ raw: snapshot.writableRaw, diagnostic: undefined }))
										: await api.config.getSettings();
					if (!skipRaw) {
						setRawContent(res.raw);
						baselineRawRef.current = { fileName, content: res.raw };
					}
					setConfigDiagnostic(res.diagnostic ?? null);
				}
				// 被跳过的脏草稿保持黄点；其余被磁盘覆盖的 key 必须清掉，否则保存后假脏。
				for (const key of dirtyKeysClearedByReload(target)) {
					if (!preserved.has(key)) clearDirty(key);
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[tab, clearDirty, projectPath],
	);

	useEffect(() => {
		if (!open) return;
		const onMigrated = () => {
			void loadConfig("models");
		};
		window.addEventListener("pideck:provider-migrated", onMigrated);
		return () => window.removeEventListener("pideck:provider-migrated", onMigrated);
	}, [open, loadConfig]);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		void api.config.getConfigDir()
			.then((dir) => { if (!cancelled) setPiConfigDir(dir); })
			.catch(() => {
				// 获取失败不影响源文件编辑，仅不展示路径
			});
		return () => { cancelled = true; };
	}, [open]);

	useEffect(() => {
		if (!open) return;
		if (section === "skills") {
			void refreshSkills();
			return;
		}
		if (section === "prompts") {
			void refreshPrompts();
			return;
		}
		if (section === "extensions") {
			// 扩展页需要显示当前/最新版本与可更新状态，首次进入强制查一次版本；
			// 主进程 listCacheHasVersionInfo 会让后续进入直接吃带版本的缓存，不重复打 npm view。
			void refreshExtensions(true);
			return;
		}
		void loadConfig(tab);
	}, [open, section, tab, loadConfig]);

	const showToast = (msg: string) => {
		showNotice(msg, 2500);
	};

	/** 去掉 Electron IPC 包装前缀，只保留真正业务错误，方便 toast 阅读。 */
	const formatIpcError = (error: unknown): string => {
		const raw = error instanceof Error ? error.message : String(error);
		const matched = raw.match(
			/Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]+)$/i,
		);
		return (matched?.[1] ?? raw).trim();
	};

	/** 统一保存流程：写盘 → 校验 → toast；成功时清除对应 tab 的未保存标记，返回是否成功。 */
	const saveAndReload = async (
		saveFn: () => Promise<{ valid: boolean; error?: string }>,
		successMessage?: string,
		dirtyKey?: string,
	): Promise<boolean> => {
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
	const handleTokendanceInstalled = useCallback((outcome: TokendanceInstallOutcome) => {
		// 主进程已直接落盘 models.json：以磁盘为准整页重载（force 清空草稿保留集——
		// 安装是明确的落盘动作，与保存/导入同语义）；DSH 侧若写入成功同步刷新配置页。
		void loadConfig("models", { force: true }).catch(() => undefined);
		if (outcome.dshSaved) {
			void dshConfigRef.current?.reload().catch(() => undefined);
		}
	}, [loadConfig]);

	const handleAddProvider = () => {
		const providerName = newProviderName.trim();
		// 空：静默返回（用户尚未输入）；非法字符：提示规则，避免 DSH credentialRefFor
		// 把含特殊字符的名字转成非法环境变量名 → 密钥读不到。
		if (!providerName) return;
		if (!isValidProviderName(providerName)) {
			showNotice(t("config.providerNameRule"));
			return;
		}
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				// 默认不写入 headers，保持和手写 models.json 一致；需要兼容特定代理时再由用户显式选择 User-Agent。
				[providerName]: { models: [] },
			},
		};
		setModelsData(updated);
		markDirty("config:models");
		setExpandedProvider(providerName);
		setAddingProvider(false);
		setNewProviderName("");
	};

	// 重命名 provider：保留所有配置和模型，仅修改 key 名称
	const handleStartRename = (name: string) => {
		setRenamingProvider(name);
		setRenameValue(name);
	};

	const handleConfirmRename = (oldName: string) => {
		const newName = renameValue.trim();
		if (!newName || newName === oldName || modelsData.providers[newName]) {
			// 名称未变、为空或已存在则不操作
			setRenamingProvider(null);
			setRenameValue("");
			return;
		}
		// 重命名同样走严格白名单（新名字会经 credentialRefFor / 配置 key）。
		if (!isValidProviderName(newName)) {
			showNotice(t("config.providerNameRule"));
			return;
		}
		const providers = { ...modelsData.providers };
		providers[newName] = providers[oldName];
		delete providers[oldName];
		setModelsData({ ...modelsData, providers });
		markDirty("config:models");
		// 重命名 provider 时同步 auth.json 里的同名 key，否则 pi 按新名称
		// 查不到认证 → 模型列表加载为空（用户反馈的“改名称后模型空”根因）。
		if (authData[oldName]) {
			const updatedAuth = { ...authData };
			updatedAuth[newName] = updatedAuth[oldName];
			delete updatedAuth[oldName];
			setAuthData(updatedAuth);
			markDirty("config:auth");
		}
		if (expandedProvider === oldName) setExpandedProvider(newName);
		setRenamingProvider(null);
		setRenameValue("");
	};

	const handleCancelRename = () => {
		setRenamingProvider(null);
		setRenameValue("");
	};

	const handleDeleteProvider = (name: string) => {
		setDeleteConfirm({
			type: "provider",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				delete providers[name];
				setModelsData({ ...modelsData, providers });
				markDirty("config:models");
				if (expandedProvider === name) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateProvider = (name: string) => {
		const sourceProvider = modelsData.providers[name];
		if (!sourceProvider) return;
		
		// 生成新名称：用连字符后缀（符合 provider 名严格白名单，避免空格/特殊字符）。
		let newName = `${name}-copy`;
		let counter = 2;
		while (modelsData.providers[newName]) {
			newName = `${name}-copy-${counter}`;
			counter++;
		}
		
		// 深拷贝 provider 配置，包括 models 数组（含 apiKey）。
		const duplicatedProvider = JSON.parse(JSON.stringify(sourceProvider));
		
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[newName]: duplicatedProvider,
			},
		});
		markDirty("config:models");
		// 同步 auth.json：复制后的 provider 若有独立 auth key，也需要复制，
		// 否则 pi 按新名称查不到认证 → 模型列表加载为空。
		if (authData[name]) {
			setAuthData({ ...authData, [newName]: { ...authData[name] } });
			markDirty("config:auth");
		}
		
		// 展开新复制的 provider
		setExpandedProvider(newName);
	};

	/**
	 * 检测成功且实际走通 /v1（或 /v1beta）时，把表单里的 baseUrl 自动改成带版本路径。
	 * 原因：检测侧会兼容补路径，但 pi 会话会原样读 models.json；不改写则「测试正常、会话 404」。
	 * 仅改内存表单，需用户点保存后才写入磁盘。
	 * 后端仅在确实需要改写时返回 suggestedBaseUrl，前端直接应用即可。
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

	// 从 provider 的 baseUrl + apiKey 拉取可用模型列表
	const handleFetchModels = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: t("config.missingBaseUrlApiKey"),
			}));
			return;
		}
		setFetchingProvider(providerName);
		setFetchModelsErrorByProvider((prev) => ({
			...prev,
			[providerName]: undefined,
		}));
		try {
			const result = await api.config.fetchModels(
				provider.baseUrl,
				provider.apiKey,
				provider.api as string | undefined,
				getProviderHeaders(provider.headers),
				// 拉取列表与测试同用 per-provider 代理选择（海外网关需代理时不用改全局开关）。
				testProxyModeByProvider[providerName] ?? "follow",
			);
			if (result.success && result.models) {
				setFetchedModels((prev) => ({
					...prev,
					[providerName]: result.models!,
				}));
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: undefined,
				}));
				const normalized = applySuggestedBaseUrl(
					providerName,
					result.suggestedBaseUrl,
				);
				if (normalized && result.suggestedBaseUrl) {
					showToast(
						t("config.baseUrlAutoNormalized", {
							url: result.suggestedBaseUrl,
						}),
					);
				} else {
					showToast(t("config.fetchedModels", { count: result.models.length }));
				}
			} else {
				// 根据 API 类型提供不同的错误提示
				const apiTypeHint = getFetchModelsHintByApi(provider.api as string | undefined, provider.baseUrl);
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: (result.error ?? t("config.fetchModelsFailed")) + "\n" + apiTypeHint,
				}));
			}
		} catch (e) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: e instanceof Error ? e.message : String(e),
			}));
		} finally {
			setFetchingProvider(null);
		}
	};

	// 测试 provider 连接：先落盘表单配置，再用真实 pi 做一次最小调用。
	// 保存的目的：pi 只读磁盘上的 models.json（baseUrl/apiKey 都从那里解析），
	// 用真实 pi 测试才能与会话结果一致（不再用 net.fetch 模拟请求）。
	const handleTestProvider = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setError(t("config.missingBaseUrlApiKey"));
			return;
		}
		// 确定测试用的模型：优先用户指定的 testModelId，否则取第一个模型 id
		const modelId =
			(testModelIdByProvider[providerName] ?? "").trim() ||
			provider.models[0]?.id ||
			"";
		if (!modelId) {
			setError(t("config.missingTestModel"));
			return;
		}
		setTestingProvider(providerName);
		setTestResult(null);
		setError(null);
		try {
			const result = await api.config.testProvider(
				providerName,
				modelId,
				modelsData,
				testProxyModeByProvider[providerName] ?? "follow",
			);
			setTestResult({ providerName, ...result });
			if (result.success) {
				// 测试即保存：清除脏标记并回读磁盘，保持表单与磁盘、baseline 一致。
				// silent 回读：不卸载 ModelsTab（loading 会塔缩滚动容器、滚动位置丢失），
				// 用户停留在测试结果卡片处。
				clearDirty("config:models");
				await loadConfig("models", { force: true, silent: true });
				onSaved();
			}
		} catch (e) {
			setTestResult({
				providerName,
				success: false,
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setTestingProvider(null);
		}
	};

	const handleAddModel = (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		// 新模型先保持未知字段为空：ID 失焦/保存时由端点元数据或唯一 catalog 候选补齐。
		// 不能在这里写 1M/128K/reasoning/image 这类猜测值，否则真正规格永远无法覆盖。
		const newModel: ModelItem = {
			id: "",
			name: "",
		};
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models: [...provider.models, newModel] },
			},
		};
		setModelsData(updated);
		markDirty("config:models");
	};

	const handleUpdateModel = (
		providerName: string,
		index: number,
		field: string,
		value: unknown,
	) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const models = [...provider.models];
		models[index] = { ...models[index], [field]: value };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models },
			},
		});
		markDirty("config:models");
	};

	/**
	 * 重置为自适应：
	 * 1. 显式拉取当前 provider 的 /models，取当前 modelId 的实报字段（失败也继续，listing 视为空）；
	 * 2. 查询模型规格（运行中 pi 模型列表优先 + bundled pi-ai catalog 兜底，见 resolveModelSpecFromCatalogs）；
	 * 3. endpoint 实报优先合并，然后只覆盖模板有值的字段。模板未提供的容量字段保留手填值，
	 *    不落空——否则 Pi 按 128k 回退，用户手填的 1000000 被静默丢掉。
	 */
	const handleResetModelToAdaptive = async (providerName: string, index: number) => {
		const provider = modelsData.providers[providerName];
		const model = provider?.models[index];
		if (!provider || !model) return;
		setResettingModelKey(`${providerName}\u0000${index}`);
		try {
			let listing: FetchedModel | undefined;
			if (provider.baseUrl && provider.apiKey) {
				const result = await api.config.fetchModels(
					provider.baseUrl,
					provider.apiKey,
					provider.api as string | undefined,
					getProviderHeaders(provider.headers),
				);
				if (result.success && result.models) {
					listing = result.models.find((item) => item.id === model.id);
				}
			}
			const spec = await api.projects
				.getModelSpec(providerName, model.id, model.name)
				.catch(() => null);
			const template = mergeAdaptiveModelTemplate(listing, spec, model.id);
			const nextModel = applyAdaptiveTemplateReset(model, template);
			const models = [...provider.models];
			models[index] = nextModel;
			setModelsData({
				...modelsData,
				providers: {
					...modelsData.providers,
					[providerName]: { ...provider, models },
				},
			});
			markDirty("config:models");
			showNotice(
				template.matchedId
					? t("config.modelResetAdaptiveDone", { model: template.matchedId })
					: t("config.modelResetAdaptiveKept"),
				3000,
			);
		} finally {
			setResettingModelKey(null);
		}
	};

	const handleUpdateModelThinkingLevel = (
		providerName: string,
		index: number,
		key: "xhigh" | "max",
		value: "" | "xhigh" | "max",
	) => {
		const provider = modelsData.providers[providerName];
		const currentModel = provider?.models[index];
		if (!provider || !currentModel) return;
		const models = [...provider.models];
		const nextThinkingLevelMap = {
			...(currentModel.thinkingLevelMap ?? {}),
		};
		if (value) nextThinkingLevelMap[key] = value;
		else delete nextThinkingLevelMap[key];
		const nextModel = {
			...currentModel,
			// xhigh/max 只有 reasoning 模型才有意义；打开映射时同步开启。
			reasoning: value ? true : currentModel.reasoning,
		};
		if (Object.keys(nextThinkingLevelMap).length > 0) {
			nextModel.thinkingLevelMap = nextThinkingLevelMap;
		} else {
			delete nextModel.thinkingLevelMap;
		}
		models[index] = nextModel;

		const nextProvider = value
			? {
				...provider,
				compat: {
					supportsDeveloperRole: false,
					...(provider.compat ?? {}),
					supportsReasoningEffort: true,
				},
			}
			: { ...provider };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...nextProvider, models },
			},
		});
		markDirty("config:models");
	};

	const handleDeleteModel = (providerName: string, index: number) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const model = provider.models[index];
		if (!model) return;
		setDeleteConfirm({
			type: "model",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: `${providerName}/${model.id}` }),
			onConfirm: () => {
				const models = provider.models.filter((_, i) => i !== index);
				setModelsData({
					...modelsData,
					providers: {
						...modelsData.providers,
						[providerName]: { ...provider, models },
					},
				});
				markDirty("config:models");
				setDeleteConfirm(null);
			},
		});
	};

	const handleDeleteModels = (providerName: string, indexes: number[]) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const validIndexes = [...new Set(indexes)].filter(
			(index) => Number.isInteger(index) && index >= 0 && index < provider.models.length,
		);
		if (validIndexes.length === 0) return;
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("config.deleteModelsBatchConfirm", {
				provider: providerName,
				count: validIndexes.length,
			}),
			onConfirm: () => {
				setModelsData((current) => {
					const currentProvider = current.providers[providerName];
					if (!currentProvider) return current;
					return {
						...current,
						providers: {
							...current.providers,
							[providerName]: {
								...currentProvider,
								models: removeSelectedModelIndexes(currentProvider.models, new Set(validIndexes)),
							},
						},
					};
				});
				markDirty("config:models");
				setDeleteConfirm(null);
			},
		});
	};

	const handleSaveModels = async (): Promise<boolean> => {
		// 保存前按能力目录批量补全空字段（端点/用户值不覆盖；未命中留空）。
		const { providers: filledProviders, filledCount } = await collectModelSpecPatches(
			modelsData,
			(providerName, modelId, modelName) =>
				api.projects.getModelSpec(providerName, modelId, modelName),
		);
		const base = filledCount > 0 ? { ...modelsData, providers: filledProviders } : modelsData;
		// 保存前规范化所有供应商的 compat 字段，确保布尔值显式写入而不依赖后端默认值；
		// supportsReasoningEffort 联动档位映射（见 deriveProviderCompat）。
		const normalizedData = {
			...base,
			providers: Object.fromEntries(
				Object.entries(base.providers).map(([name, provider]) => [
					name,
					{
						...provider,
						compat: deriveProviderCompat(provider),
					},
				]),
			),
		};
		setSaving(true);
		setError(null);
		try {
			const result = await api.config.saveModels(normalizedData);
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return false;
			}
			onSaved();
			clearDirty("config:models");
			// 保存成功后才把补全值写回 UI：失败时保留原值，下次保存会重新补全（幂等）
			if (filledCount > 0) {
				setModelsData(base);
			}
			// 保存后用真实 pi 验证配置能否正常加载模型：加载为空/失败时给醒目警告，
			// 避免用户以为“保存成功=一切正常”，实际模型列表却是空的。
			if (result.modelLoadOk) {
				showToast(t("config.modelsSavedVerified", { count: result.modelCount ?? 0 }));
			} else {
				showNotice(t("config.modelsSavedButLoadFailed"), 6000, "warning");
			}
			await loadConfig("models", { force: true });
			return true;
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			return false;
		} finally {
			setSaving(false);
		}
	};

	// ── Auth 操作 ────────────────────────────────────────

	const handleUpdateAuth = (provider: string, field: string, value: string) => {
		setAuthData({
			...authData,
			[provider]: { ...authData[provider], [field]: value },
		});
		markDirty("config:auth");
	};

	/**
	 * 添加认证条目。
	 * name 和 key 从 AuthTab 供应商选择弹窗直接传入，
	 * 避免 React 闭包中状态尚未刷新的问题，且支持弹窗内直接填写 API Key。
	 */
	const handleAddAuth = (name?: string, key?: string) => {
		const finalName = name ?? newAuthName.trim();
		if (!finalName) return;
		setAuthData({
			...authData,
			[finalName]: { type: "api_key", key: key ?? "" },
		});
		markDirty("config:auth");
		setExpandedAuth(finalName);
		setAddingAuth(false);
		setNewAuthName("");
	};

	const handleDeleteAuth = (provider: string) => {
		setDeleteConfirm({
			type: "auth",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: provider }),
			onConfirm: () => {
				const updated = { ...authData };
				delete updated[provider];
				setAuthData(updated);
				markDirty("config:auth");
				if (expandedAuth === provider) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateAuth = (provider: string) => {
		const sourceAuth = authData[provider];
		if (!sourceAuth) return;
		const duplicatedAuth = JSON.parse(JSON.stringify(sourceAuth));
		let newName = `${provider} copy`;
		let counter = 2;
		while (authData[newName]) {
			newName = `${provider} copy ${counter}`;
			counter++;
		}
		setAuthData({
			...authData,
			[newName]: duplicatedAuth,
		});
		markDirty("config:auth");
		setExpandedAuth(newName);
	};

	const handleDeleteProviders = (names: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: names.length }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				for (const name of names) delete providers[name];
				setModelsData({ ...modelsData, providers });
				markDirty("config:models");
				if (names.includes(expandedProvider ?? "")) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDeleteAuths = (providers: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: providers.length }),
			onConfirm: () => {
				const updated = { ...authData };
				for (const provider of providers) delete updated[provider];
				setAuthData(updated);
				markDirty("config:auth");
				if (providers.includes(expandedAuth ?? "")) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleSaveAuth = async (): Promise<boolean> => {
		const ok = await saveAndReload(
			() => api.config.saveAuth(authData),
			undefined,
			"config:auth",
		);
		await loadConfig("auth", { force: true });
		return ok;
	};

	// ── Settings 操作 ────────────────────────────────────

	const handleSaveSettings = async (): Promise<boolean> => {
		const ok = await saveAndReload(
			() => api.config.saveSettings(settingsData),
			undefined,
			"config:settings",
		);
		await loadConfig("settings", { force: true });
		return ok;
	};

	// ── Trust 操作 ────────────────────────────────────────

	const handleSaveTrust = async (): Promise<boolean> => {
		const ok = await saveAndReload(
			() => api.config.saveRaw("trust.json", JSON.stringify(trustData, null, 2)),
			undefined,
			"config:trust",
		);
		await loadConfig("trust", { force: true });
		return ok;
	};

	// ── Raw 操作 ─────────────────────────────────────────

	const handleSaveRaw = async (): Promise<boolean> => {
		const isModelsFile = rawFileName === "models.json";
		const ok = await saveAndReload(
			() => api.config.saveRaw(rawFileName, rawContent),
			isModelsFile ? t("config.modelsSaved") : undefined,
			"config:raw",
		);
		if (isModelsFile) {
			await loadConfig("models", { force: true });
		} else if (rawFileName === "auth.json") await loadConfig("auth", { force: true });
		else if (rawFileName === "trust.json") await loadConfig("trust", { force: true });
		else if (rawFileName === "mcp.json") await loadConfig("mcp", { force: true });
		else await loadConfig("settings", { force: true });
		return ok;
	};

	// 切换源文件时重新加载对应文件内容
	const handleRawFileChange = async (fileName: string) => {
		setLoading(true);
		try {
			const res =
				fileName === "models.json"
					? await api.config.getModels()
					: fileName === "auth.json"
						? await api.config.getAuth()
						: fileName === "trust.json"
							? await api.config.getTrust()
							: fileName === "mcp.json"
								? await api.config.getMcp(projectPath).then((snapshot) => ({ raw: snapshot.writableRaw }))
								: await api.config.getSettings();
			setRawFileName(fileName);
			setRawContent(res.raw);
			baselineRawRef.current = { fileName, content: res.raw };
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	// ── 导出 / 导入 ─────────────────────────────────────

	/** 将三个配置文件打包为 JSON 并触发浏览器下载。 */
	const handleExport = async () => {
		try {
			const json = await api.config.export();
			const blob = new Blob([json], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			// 文件名含时间戳，便于用户区分多次备份
			a.download = `pideck-config-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
			showToast(t("config.exported"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	/** 刷新 prompt templates 列表 */
	const refreshPrompts = async () => {
		const res = await api.prompts.list();
		// 过滤掉用户已删除的内置模板，同时翻译内置模板的 description
		res.templates = res.templates
			.filter((t) => t.userCreated || !deletedBuiltinNames.has(t.name))
			.map((tpl) => ({
				...tpl,
				description: translateBuiltinPromptDescription(tpl),
			}));
		setPromptsData(res);
	};

	/** 创建新 prompt template */
	const handleCreatePrompt = async () => {
		setCreatingPrompt(true);
		setError(null);
		try {
			await api.prompts.create({
				name: newPromptName,
				description: newPromptDescription,
			});
			setNewPromptName("");
			setNewPromptDescription("");
			await refreshPrompts();
			showToast(t("config.promptCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingPrompt(false);
		}
	};

	/** 确认删除 prompt template */
	const confirmDeletePrompt = async (target: PiPromptTemplateSummary) => {
		setError(null);
		if (target.userCreated) {
			try {
				await api.prompts.delete(target.path);
				await refreshPrompts();
				showToast(t("config.promptDeletedToast"));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		} else {
			// 内置模板：从显示列表中移除
			setDeletedBuiltinNames((prev) => new Set(prev).add(target.name));
			showToast(t("config.promptDeletedToast"));
		}
	};

	/** 打开 prompt template 编辑器 */
	const handleEditPrompt = async (template: PiPromptTemplateSummary) => {
		// 内置模板直接使用预加载的 content，无需从文件读取
		if (!template.userCreated) {
			setEditingPrompt(template);
			setEditPromptContent(template.content);
			setEditPromptLoading(false);
			setError(null);
			return;
		}
		setEditingPrompt(template);
		setEditPromptContent("");
		setEditPromptLoading(true);
		setError(null);
		try {
			const content = await api.prompts.edit(template.path);
			setEditPromptContent(content as string);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingPrompt(null);
		} finally {
			setEditPromptLoading(false);
		}
	};

	/** 取消编辑 prompt template（放弃未保存修改，清除标记） */
	const handleCancelEditPrompt = () => {
		setEditingPrompt(null);
		setEditPromptContent("");
		clearDirty("prompts");
	};

	/** 保存 prompt template 编辑器内容；返回是否成功（关闭确认框等待其结果再决定是否关闭） */
	const handleSaveEditPrompt = async (): Promise<boolean> => {
		if (!editingPrompt || editPromptSaving) return false;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				// 内置模板：先创建用户副本，再写入编辑内容
				const created = await api.prompts.create({
					name: editingPrompt.name,
					description: editingPrompt.description,
				});
				await api.prompts.edit(created.path, editPromptContent);
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent);
			}
			clearDirty("prompts");
			showToast(t("config.promptSavedToast"));
			setEditingPrompt(null);
			await refreshPrompts();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** Ctrl+S 快速保存：保存但不关闭弹框、不弹提示 */
	const handleRenamePrompt = async (template: { name: string; path: string }, newName: string) => {
		setError(null);
		try {
			await api.prompts.rename(template.name, newName);
			await refreshPrompts();
			showToast(t("config.promptRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleQuickSavePrompt = async (): Promise<boolean> => {
		if (!editingPrompt || editPromptSaving) return false;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				const created = await api.prompts.create({
					name: editingPrompt.name,
					description: editingPrompt.description,
				});
				await api.prompts.edit(created.path, editPromptContent);
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent);
			}
			clearDirty("prompts");
			await refreshPrompts();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** 从用户选择的 JSON 文件导入配置，成功后刷新当前 tab。 */
	const refreshSkills = async () => {
		const res = await api.skills.list();
		setSkillsData(res);
		if (res.locations[0] && !res.locations.some((item) => item.id === newSkillLocationId)) {
			setNewSkillLocationId(res.locations[0].id);
		}
	};

	const handleCreateSkill = async () => {
		setCreatingSkill(true);
		setError(null);
		try {
			await api.skills.create({
				name: newSkillName,
				description: newSkillDescription,
				locationId: newSkillLocationId,
			});
			setNewSkillName("");
			setNewSkillDescription("");
			await refreshSkills();
			showToast(t("config.skillCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingSkill(false);
		}
	};

	const handleToggleSkill = async (path: string, enabled: boolean) => {
		setError(null);
		try {
			await api.skills.toggle(path, enabled);
			await refreshSkills();
			showToast(enabled ? t("config.skillEnabledToast") : t("config.skillDisabledToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const confirmDeleteSkill = async () => {
		if (!deleteSkillConfirm) return;
		const target = deleteSkillConfirm;
		setDeleteSkillConfirm(null);
		setError(null);
		try {
			await api.skills.delete(target.path);
			await refreshSkills();
			showToast(t("config.skillDeletedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleRenameGlobalSkill = async (skill: PiSkillSummary, newName: string) => {
		setError(null);
		try {
			await api.skills.rename(skill.path, newName);
			await refreshSkills();
			showToast(t("config.skillRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleEditGlobalSkill = async (skill: PiSkillSummary) => {
		setEditingGlobalSkill(skill);
		setEditGlobalContent("");
		setEditGlobalLoading(true);
		setError(null);
		try {
			const content = await window.piDesktop.files.readContent(skill.path);
			setEditGlobalContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingGlobalSkill(null);
		} finally {
			setEditGlobalLoading(false);
		}
	};

	// Ctrl+S / Cmd+S 快捷键保存 skill 编辑器
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s" && editingGlobalSkill && !editGlobalSaving) {
				e.preventDefault();
				void saveGlobalSkillEditor();
			}
		};
		if (editingGlobalSkill) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [editingGlobalSkill, editGlobalSaving]);

	const saveGlobalSkillEditor = async (): Promise<boolean> => {
		if (!editingGlobalSkill || editGlobalSaving) return false;
		setEditGlobalSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingGlobalSkill.path, editGlobalContent);
			clearDirty("skills");
			setEditGlobalSaved(true);
			window.setTimeout(() => setEditGlobalSaved(false), 2000);
			await refreshSkills();
			return true;
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			return false;
		} finally {
			setEditGlobalSaving(false);
		}
	};

	/**
	 * 加载扩展列表。
	 * - forceRefresh=false：优先用主进程缓存（启动预热后通常秒开）
	 * - forceRefresh=true：手动刷新时强制重扫，并查询 npm 更新信息
	 */
	const refreshExtensions = async (forceRefresh = false) => {
		setExtensionsLoading(true);
		setError(null);
		try {
			const res = await api.extensions.list(forceRefresh);
			setExtensionsData(res);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExtensionsLoading(false);
		}
	};

	const confirmUninstallExtension = async () => {
		if (!uninstallExtensionConfirm) return;
		const target = uninstallExtensionConfirm;
		// 防御性检查：内置扩展不应出现在确认弹窗中
		if (target.builtIn) {
			setUninstallExtensionConfirm(null);
			return;
		}
		setUninstallExtensionConfirm(null);
		// 立刻进入卸载态以触发卡片退场动画，同时发起真实卸载；两者并行，避免"删完才闪一下"。
		setUninstallingExtensionSource(target.source);
		const exitAnimation = new Promise<void>((resolve) => {
			window.setTimeout(resolve, 280);
		});
		try {
			await Promise.all([
				api.extensions.uninstall(target.source, target.scope),
				exitAnimation,
			]);
			// 与禁用/手动刷新一致：强制重扫并跳过可能残留的 in-flight 缓存结果。
			await refreshExtensions(true);
			showToast(t("config.extensionUninstalledToast"));
		} catch (e) {
			// 配置页顶部红字容易被滚出视口；卸载失败用 error toast，用户能立刻看到。
			// 附带一条终端可手动执行的卸载命令（pi uninstall 与主进程内部执行的
			// pi remove 是同一命令的别名），并提供一键复制按钮；命令本身也在正文里。
			const uninstallCmd = `pi uninstall ${target.source}${target.scope === "project" ? " -l" : ""}`;
			showNotice(
				t("config.extensionUninstallFailed", { error: formatIpcError(e) }) +
					" " +
					t("config.extensionUninstallManual", { command: uninstallCmd }),
				6000,
				"error",
				undefined,
				{
					action: {
						label: t("config.copyUninstallCmd"),
						onClick: () => void navigator.clipboard.writeText(uninstallCmd),
					},
				},
			);
		} finally {
			setUninstallingExtensionSource(null);
		}
	};

	const handleImport = async () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const result = await api.config.import(text);
				if (!result.valid) {
					setError(result.error ?? t("config.importFailed"));
					return;
				}
				onSaved();
				// 导入会整体替换四个配置文件：当前 tab 由 loadConfig 重载并清标记，其余 tab 的数据在磁盘上已全部变化，
				// 统一清除它们的脏标记，避免残留黄点/关闭误弹确认（skills/prompts 编辑不涉及配置文件，保留）。
				for (const key of ALL_CONFIG_DIRTY_KEYS) clearDirty(key);
				await loadConfig(tab, { force: true });
				showToast(t("config.imported"));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		};
		input.click();
	};

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
				return handleSaveModels();
			case "config:auth":
				return handleSaveAuth();
			case "config:settings":
				return handleSaveSettings();
			case "config:trust":
				return handleSaveTrust();
			case "config:mcp": {
				const ok = (await mcpTabRef.current?.save()) ?? false;
				if (ok) {
					clearDirty("config:mcp");
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

	/** 顶部统一保存按钮：保存当前 tab（无修改也允许再次保存，重新写盘当前 tab；不关闭弹框）。 */
	const handleSaveCurrent = async () => {
		if (saving) return;
		// 无修改也放开再次保存；skills/prompts/extensions 等无保存语义的页
		// 由各自 save 方法（如 saveGlobalSkillEditor 的 !editingGlobalSkill 守卫）返回 false，不产生副作用。
		await saveByKey(currentTabKey);
	};

	/** 关闭弹框：有未保存修改时先弹保存确认（借鉴设置页），无修改直接关闭。 */
	const handleClose = () => {
		if (dirtyTabs.size > 0) {
			setCloseConfirmOpen(true);
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
				const roots = new Set<string>();
				for (const key of dirtyTabs) {
					roots.add(key.startsWith("dsh:") ? "dsh" : key);
				}
				for (const key of roots) {
					const ok = await saveByKey(key);
					if (!ok) return false;
				}
				return true;
			},
		}),
		[handleSaveCurrent, handleExport, handleImport, saveByKey, dirtyTabs],
	);
	useEffect(() => {
		props.onPaneStateChange?.({
			saving,
			hasDirty,
			unsaved: configUnsavedSummary
				? { totalCount: configUnsavedSummary.totalCount, items: configUnsavedSummary.items }
				: { totalCount: 0, items: [] },
		});
	}, [saving, hasDirty, configUnsavedSummary, props.onPaneStateChange]);

	/**
	 * 关闭确认框选择保存并关闭：汇总**全部**脏来源逐个保存（不是只存当前 tab），
	 * dsh:<nav> 归并到 dsh 一个保存入口；任一保存失败则留下重试（错误已展示在内容区）。
	 */
	const handleSaveAndClose = async () => {
		const roots = new Set<string>();
		for (const key of dirtyTabs) {
			roots.add(key.startsWith("dsh:") ? "dsh" : key);
		}
		for (const key of roots) {
			const ok = await saveByKey(key);
			if (!ok) return;
		}
		setCloseConfirmOpen(false);
		props.onClose();
	};

	/** 关闭确认框选择放弃更改：丢弃所有未保存修改直接关闭。 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		props.onClose();
	};

	const configNavItems: Array<{ id: ConfigTab; label: string; icon: ReactNode }> = [
		{ id: "models", label: t("config.nav.models"), icon: <Cpu size={14} aria-hidden="true" /> },
		{ id: "auth", label: t("config.nav.auth"), icon: <KeyRound size={14} aria-hidden="true" /> },
		{ id: "settings", label: t("config.nav.settings"), icon: <Settings2 size={14} aria-hidden="true" /> },
		{ id: "trust", label: t("config.nav.trust"), icon: <ShieldCheck size={14} aria-hidden="true" /> },
		{ id: "mcp", label: t("config.nav.mcp"), icon: <PlugZap size={14} aria-hidden="true" /> },
		{ id: "raw", label: t("config.nav.raw"), icon: <FileCode2 size={14} aria-hidden="true" /> },
	];

	// 加载态/错误提示：每个 TabsContent 顶部共用（Tabs 会卸载非激活内容，不能只挂一处）。
	// 同一 JSX element 可在多处渲染，不会造成重复副作用。
	const statusBlock = (
		<>
			{loading && <div className="py-12 text-center text-control text-muted-foreground">{t("common.loading")}</div>}
			{error && <div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{error}</div>}
		</>
	);

	// 配置诊断卡：config 组 5 个子页顶部共用（任意子页打开时都显示）。
	const configDiagnosticBlock = configDiagnostic ? (
		<ConfigDiagnosticCard
			diagnostic={configDiagnostic}
			onOpenDocs={() => api.app.openExternal(configDiagnostic.docsUrl, true)}
			onOpenRaw={() => setTab("raw")}
		/>
	) : null;

	if (!open && !embedded) return null;

	// 对话框主体（后端分页 + 各种确认弹窗）：独立 ConfigModal 与嵌入分区共用同一份，
	// 唯一的差别是外壳（Dialog/标题栏按钮）由谁提供——embedded 时宿主 SettingsModal 承担。
	const modalBody = (
		<>
			{/* 顶层后端分页：Pi 配置管理（默认，在左）/ DSH 配置管理（在右） */}
			<Tabs value={backendPane} onValueChange={selectBackendPane} className="flex min-h-0 min-w-0 flex-1 flex-col">
				<TabsList
					// 嵌入设置窗口时 Pi/DSH 用 shadcn line variant（下划线式）：与顶层「系统设置/配置管理」
					// 的分段条（default variant）区分层级——上层页面级、下层内容级，避免两条同款 tab 冲突。
					variant={embedded ? "line" : "default"}
					className={cn(
						"shrink-0",
						embedded
							? "justify-start gap-1 px-3"
							: "config-backend-switch h-9 justify-start gap-1 border-b border-border/60 px-3",
					)}>
					<TabsTrigger
						variant={embedded ? "line" : "default"}
						value="pi"
						className={cn(
							"h-8 gap-1.5 px-3 text-[13px] font-medium",
							!embedded && "config-backend-tab",
						)}
					>
						<PiLogo className="size-3.5 shrink-0" />
						{t("config.backend.pi")}
						{hasPiDirty ? <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
					</TabsTrigger>
					<TabsTrigger
						variant={embedded ? "line" : "default"}
						value="dsh"
						className={cn(
							"h-8 gap-1.5 px-3 text-[13px] font-medium",
							!embedded && "config-backend-tab",
						)}
					>
						<DshLogo className="size-3.5 shrink-0" />
						{t("config.backend.dsh")}
						{/* 后端分页黄点：该后端任意分区有草稿时提醒 */}
						{hasDshDirty ? <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
					</TabsTrigger>
				</TabsList>
				{/* forceMount + inactive hidden：Pi/DSH 两个后端页都保持挂载，切换后端不会丢草稿；
				    与 config:mcp 同款做法，inactive 必须 hidden 避免叠在另一页上。 */}
				<TabsContent value="dsh" forceMount className="flex min-h-0 min-w-0 flex-1 data-[state=inactive]:hidden">
					{/* runtime 安装态不再整页替换：概览页内嵌 DshRuntimeSection 状态自适应区块，
					    未装→安装引导，已装→版本/目录/卸载/导入，一个页面操作完。 */}
					{dshRuntimeStatus.state !== "checking" ? (
						<DshConfigTab
							ref={dshConfigRef}
							onDirtyChange={handleDshDirtyChange}
							dirtyNavIds={dshDirtyNavIds}
							onOpenUsageProbeDialog={(provider) => openUsageProbeDialogFor(provider, "dsh")}
						/>
					) : null}
				</TabsContent>
				<TabsContent value="pi" forceMount className="flex min-h-0 min-w-0 flex-1 data-[state=inactive]:hidden">
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
					try {
						localStorage.setItem(CONFIG_LAST_TAB_KEY, value);
					} catch {
						/* localStorage 不可用（隐私模式等）时静默失败，仅本次会话内不记忆 */
					}
				}}
				className="config-layout flex min-h-0 flex-1 flex-row gap-0 bg-transparent max-[820px]:flex-col"
			>
				<TabsList
					className="config-sidebar flex min-h-0 shrink-0 flex-col items-stretch gap-2.5 overflow-auto border-0 border-r border-border rounded-none bg-transparent p-2.5 data-[orientation=vertical]:w-[160px] max-[820px]:flex-row max-[820px]:gap-3 max-[820px]:overflow-x-auto max-[820px]:overflow-y-hidden max-[820px]:border-r-0 max-[820px]:border-b"
					aria-label={t("config.title")}
				>
					<div className="config-sidebar-group grid gap-0.5">
						<span className="px-2 pb-1 text-micro font-semibold text-muted-foreground">{t("config.group.config")}</span>
						{configNavItems.map((item) => (
							<TabsTrigger
								key={item.id}
								value={`config:${item.id}`}
								className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium"
							>
								<span className="config-nav-icon">{item.icon}</span>
								{item.label}
								{/* 未保存黄点：与 DSH 导航同款 */}
								{dirtyTabs.has(`config:${item.id}`) || dirtyTabs.has(item.id) ? <span className="ml-auto size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
							</TabsTrigger>
						))}
					</div>
					<div className="config-sidebar-group grid gap-0.5">
						<span className="px-2 pb-1 text-micro font-semibold text-muted-foreground">{t("config.group.agent")}</span>
						<TabsTrigger value="security" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon"><Shield size={14} aria-hidden="true" /></span>
							{t("config.nav.security")}
						</TabsTrigger>
						<TabsTrigger value="extensions" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon"><Puzzle size={14} aria-hidden="true" /></span>
							{t("config.nav.extensions")}
						</TabsTrigger>
						<TabsTrigger value="skills" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon"><Sparkles size={14} aria-hidden="true" /></span>
							{t("config.nav.skills")}
						</TabsTrigger>
						<TabsTrigger value="prompts" className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
							<span className="config-nav-icon"><FileText size={14} aria-hidden="true" /></span>
							{t("config.nav.prompts")}
						</TabsTrigger>
					</div>
				</TabsList>

					<TabsContent value="config:models" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<>
						{/* TokenDance：确认后一键写入配置（pi models.json + DSH 模型目录），不内置注入 */}
						<TokenDancePanel
							configured={!!modelsData.providers[TOKENDANCE_PROVIDER]}
							onInstalled={handleTokendanceInstalled}
						/>
						<ModelsTab
							data={modelsData}
							expandedProvider={expandedProvider}
							focusProvider={focusedProvider}
							onOpenUsageProbeDialog={(provider) => openUsageProbeDialogFor(provider, "pi")}
							addingProvider={addingProvider}
							newProviderName={newProviderName}
							renamingProvider={renamingProvider}
							renameValue={renameValue}
							fetchingProvider={fetchingProvider}
							fetchedModels={fetchedModels}
							fetchModelsErrorByProvider={fetchModelsErrorByProvider}
							testingProvider={testingProvider}
							testResult={testResult}
							testModelIdByProvider={testModelIdByProvider}
							testProxyModeByProvider={testProxyModeByProvider}
							proxySettings={proxySettings}
							saving={saving}
							onToggleProvider={(name) =>
								setExpandedProvider(expandedProvider === name ? null : name)
							}
							onStartAddProvider={() => {
								setAddingProvider(true);
								setNewProviderName("");
							}}
							onCancelAddProvider={() => setAddingProvider(false)}
							onChangeNewProviderName={setNewProviderName}
							onConfirmAddProvider={handleAddProvider}
							onStartRename={handleStartRename}
							onChangeRenameValue={setRenameValue}
							onConfirmRename={handleConfirmRename}
							onCancelRename={handleCancelRename}
							onDeleteProvider={handleDeleteProvider}
							onDuplicateProvider={handleDuplicateProvider}
							onDeleteProviders={handleDeleteProviders}
							onAddModel={handleAddModel}
							onUpdateModel={handleUpdateModel}
							onUpdateModelThinkingLevel={handleUpdateModelThinkingLevel}
							onDeleteModel={handleDeleteModel}
							onDeleteModels={handleDeleteModels}
							onResetModel={handleResetModelToAdaptive}
							resettingModelKey={resettingModelKey}
							onFetchModels={handleFetchModels}
							onTestProvider={handleTestProvider}
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
						</div>
					</TabsContent>

					<TabsContent value="config:auth" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<AuthTab
							data={authData}
							expandedAuth={expandedAuth}
							addingAuth={addingAuth}
							newAuthName={newAuthName}
							saving={saving}
							modelsData={modelsData}
							onToggleAuth={(name) =>
								setExpandedAuth(expandedAuth === name ? null : name)
							}
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
							onOpenUsageProbeDialog={(provider) => openUsageProbeDialogFor(provider, "pi")}
						/>
					)}
						</div>
					</TabsContent>

					<TabsContent value="config:settings" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<SettingsTab
							data={settingsData}
							saving={saving}
							modelsData={modelsData}
							authData={authData}
							discoveredModels={discoveredModels}
							onChange={(data) => {
								setSettingsData(data);
								markDirty("config:settings");
							}}
							onSave={handleSaveSettings}
						/>
					)}
						</div>
					</TabsContent>

					<TabsContent value="skills" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{!loading && (
						editingGlobalSkill ? (
							<div className="prompts-editor-backdrop" onClick={() => setEditingGlobalSkill(null)}>
								<div className="prompts-editor-modal" onClick={(e) => e.stopPropagation()}>
									<div className="file-diff-header">
										<span className="file-diff-header-file">{editingGlobalSkill.name} · SKILL.md</span>
										<div className="file-diff-header-actions">
											<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")} onClick={() => { clearDirty("skills"); setEditingGlobalSkill(null); }}>
												<X size={18} strokeWidth={2.2} aria-hidden="true" />
											</Button>
										</div>
									</div>
									{editGlobalLoading ? (
										<div className="py-12 text-center text-control text-text-tertiary">{t("common.loading")}</div>
									) : (
										<div className="prompts-monaco-wrap">
											<CodeMirrorEditor
												value={editGlobalContent}
												onChange={(value) => {
													setEditGlobalContent(value);
													markDirty("skills");
												}}
											/>
									</div>
								)}
								{editGlobalSaved && <span className="file-diff-hint saved">{t("config.promptSavedHint")}</span>}
							</div>
						</div>
					) : (
							<SkillsTab
							data={skillsData}
							loading={loading}
							creating={creatingSkill}
							newName={newSkillName}
							newDescription={newSkillDescription}
							newLocationId={newSkillLocationId}
							onRefresh={refreshSkills}
							onOpenRoot={() => api.skills.openFolder()}
							onChangeNewName={setNewSkillName}
							onChangeNewDescription={setNewSkillDescription}
							onChangeNewLocation={setNewSkillLocationId}
							onCreate={handleCreateSkill}
							onToggle={(skill, enabled) => handleToggleSkill(skill.path, enabled)}
							onDelete={setDeleteSkillConfirm}
							onEdit={handleEditGlobalSkill}
							onRename={handleRenameGlobalSkill}
						/>
						)
					)}
						</div>
					</TabsContent>

					<TabsContent value="prompts" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{!loading && (
						<PromptsTab
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
							onOpenRoot={() => api.prompts.openFolder()}
							onChangeNewName={setNewPromptName}
							onChangeNewDescription={setNewPromptDescription}
							onCreate={handleCreatePrompt}
							onDelete={setDeletePromptConfirm}
							onEdit={handleEditPrompt}
							onRename={handleRenamePrompt}
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
							data={extensionsData}
							loading={extensionsLoading}
							uninstallingSource={uninstallingExtensionSource}
							onRefresh={() => void refreshExtensions(true)}
							onUninstall={setUninstallExtensionConfirm}
						/>
						</div>
					</TabsContent>

					<TabsContent value="security" className="config-main min-w-0">
						<div className="config-content">
						<SecuritySection
							ref={securitySectionRef}
							onDirtyChange={handleSecurityDirtyChange}
						/>
						</div>
					</TabsContent>

					{/* forceMount：MCP 页自管草稿，切走再回来不能丢未保存编辑；inactive 必须 hidden，否则叠在别的 tab 上。 */}
					<TabsContent value="config:mcp" forceMount className="config-main min-w-0 data-[state=inactive]:hidden">
						<div className="config-content flex min-h-0 flex-col">
						<McpTab ref={mcpTabRef} projectPath={projectPath} onDirtyChange={handleMcpDirtyChange} />
						</div>
					</TabsContent>

					<TabsContent value="config:trust" className="config-main min-w-0">
						<div className="config-content">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<TrustTab
							data={trustData}
							saving={saving}
							onChange={(data) => {
								setTrustData(data);
								markDirty("config:trust");
							}}
							onSave={handleSaveTrust}
						/>
					)}
						</div>
					</TabsContent>

					<TabsContent value="config:raw" className="config-main min-w-0">
						<div className="config-content flex min-h-0 flex-col">
					{statusBlock}
					{configDiagnosticBlock}
					{!loading && (
						<RawTab
							fileName={rawFileName}
							content={rawContent}
							saving={saving}
							configDir={piConfigDir ?? undefined}
							onChangeFileName={handleRawFileChange}
							onChangeContent={(value) => {
								setRawContent(value);
								markDirty("config:raw");
							}}
							onSave={handleSaveRaw}
						/>
					)}
						</div>
					</TabsContent>
				</Tabs>
				</TabsContent>
			</Tabs>

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

				{deleteSkillConfirm && (
					<ConfirmDialog
						title={t("config.deleteSkillConfirmTitle")}
						message={t("config.deleteSkillConfirmBody", { name: deleteSkillConfirm.name }) + "\n" + deleteSkillConfirm.path}
						confirmLabel={t("common.delete")}
						danger
						onConfirm={() => void confirmDeleteSkill()}
						onCancel={() => setDeleteSkillConfirm(null)}
					/>
				)}

				{uninstallExtensionConfirm && (
					<ConfirmDialog
						title={t("config.uninstallExtensionTitle")}
						message={t("config.uninstallExtensionBody", { source: uninstallExtensionConfirm.source }) + (uninstallExtensionConfirm.path ? "\n" + uninstallExtensionConfirm.path : "")}
						confirmLabel={t("config.uninstall")}
						danger
						onConfirm={confirmUninstallExtension}
						onCancel={() => setUninstallExtensionConfirm(null)}
					/>
				)}

				{deletePromptConfirm && (
					<ConfirmDialog
						title={t("config.deletePromptConfirmTitle")}
						message={t("config.deletePromptConfirmBody", { name: deletePromptConfirm.name })}
						confirmLabel={t("common.delete")}
						danger
						onConfirm={() => void confirmDeletePrompt(deletePromptConfirm)}
						onCancel={() => setDeletePromptConfirm(null)}
					/>
				)}

				{/* 关闭确认：有未保存修改时弹出，保存并关闭 / 放弃更改 / 取消（借鉴设置页） */}
				{closeConfirmOpen && (
					<AlertDialog open onOpenChange={(open) => { if (!open) setCloseConfirmOpen(false); }}>
						<AlertDialogContent>
							<AlertDialogHeader>
								<AlertDialogTitle>{t("config.unsavedTitle")}</AlertDialogTitle>
								<AlertDialogDescription asChild>
									<div className="grid max-h-56 gap-1.5 overflow-auto text-left">
										{configUnsavedSummary && configUnsavedSummary.totalCount === 1 ? (
											/* 单项：沿用带「是否在关闭前保存？」的单行提示，不需要列表 */
											<p>{configUnsavedMessage}</p>
										) : (
											<>
												{/* 多项：先给总数，再逐条列出变更项（footer 按钮承担保存/放弃语义） */}
												<p>{t("config.unsavedListIntro", { count: configUnsavedSummary?.totalCount ?? 0 })}</p>
												<ul className="grid gap-0.5 pl-4 list-disc">
													{configUnsavedSummary?.items.map((item) => (
														<li key={`${item.tabKey}\u0000${item.itemKey}`}>
															{t(item.tabKey)} · {t(item.itemKey)}
														</li>
													))}
												</ul>
											</>
										)}
									</div>
								</AlertDialogDescription>
							</AlertDialogHeader>
							<AlertDialogFooter>
								<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
								<AlertDialogAction className={buttonVariants({ variant: "destructive" })} onClick={handleDiscardAndClose}>
									{t("config.discardChanges")}
								</AlertDialogAction>
								<AlertDialogAction onClick={() => void handleSaveAndClose()}>
									{t("config.saveAndClose")}
								</AlertDialogAction>
							</AlertDialogFooter>
						</AlertDialogContent>
					</AlertDialog>
				)}

				{/* toast 已改用 sonner */}
				{deleteConfirm && (
					<ConfirmDialog
						title={deleteConfirm.title}
						message={deleteConfirm.message}
						confirmLabel={t("common.delete")}
						danger
						onConfirm={deleteConfirm.onConfirm}
						onCancel={() => setDeleteConfirm(null)}
					/>
				)}
		</>
	);

	if (embedded) {
		// 嵌入模式：宿主提供 Dialog 外壳与标题栏，这里只渲染内容；
		// 外层 config-pane 继承 .config-modal 同款控件密度（font/button/input 尺寸）。
		return (
			<div className="config-pane flex min-h-0 min-w-0 flex-1 flex-col">
				{modalBody}
			</div>
		);
	}

	// 独立模式：完整 Dialog（标题栏含保存/导出/导入/关闭；内容与嵌入模式完全一致）
	return (
		<Dialog open={open} onOpenChange={(next) => !next && handleClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", configModalSizeClass, "config-modal", "[--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]")}>
				{/* 顶栏/侧栏控件与设置弹窗、会话顶栏统一到 sm / text-sm 密度 */}
				<DialogHeader className="flex-row items-center justify-between px-4 py-2.5">
					<DialogTitle className="text-sm font-semibold tracking-tight">{t("config.title")}</DialogTitle>
					<div className="flex items-center gap-1.5">
						{/* 顶部统一保存：各 tab 内部保存按钮可能被滚动藏住，这里常驻可见；
						    有未保存修改时按钮带黄点标记；无修改也放开再次保存，不再禁用 */}
						<Button
							variant="default"
							size="sm"
							onClick={() => void handleSaveCurrent()}
							disabled={saving}
							title={hasDirty ? t("config.dirtyTooltip") : undefined}
						>
							{hasDirty && (
								<span className="size-2 rounded-full bg-amber-400" aria-hidden="true" />
							)}
							{saving ? t("common.saving") : t("common.save")}
						</Button>
						{backendPane === "pi" && section === "config" ? (
							<>
								<Button variant="outline" size="sm" onClick={handleExport}>
									{t("common.export")}
								</Button>
								{/* 导入与导出统一 outline 白底描边：与深色「保存」主按钮形成主次层级，避免并排按钮一描边一填充的不一致（对齐 SettingsModal 同款按钮组） */}
								<Button variant="outline" size="sm" onClick={handleImport}>
									{t("common.import")}
								</Button>
							</>
						) : undefined}
						<DialogClose asChild>
							<Button variant="ghost" size="icon-sm" className="size-7" aria-label={t("common.close")} title={t("common.close")}>
								<X size={16} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
			{modalBody}
			</DialogContent>
		</Dialog>
	);
}
