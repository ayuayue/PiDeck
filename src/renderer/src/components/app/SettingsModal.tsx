import { Component, Fragment, lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getDefaultStore, useAtom } from "jotai";
import { settingsFocusAtom, type SettingsPaneId, type SettingsTabId } from "../../atoms";
import { useSettingsFocus } from "./settings/useSettingsFocus.ts";
import {
	Settings2,
	Network,
	Wrench,
	PawPrint,
	Volume2,
	Trash2,
	Brush,
	Eye,
	ChartColumnBig,
	Activity,
	MessageSquare,
	ImageIcon,
	Globe,
	FileCode2,
	GitBranch,
	SlidersHorizontal,
	MonitorCog,
	X,
} from "lucide-react";
import { t, type TranslationKey } from "../../i18n";
import { applyAppearanceAttributes, type AppearanceSettings } from "../../themeAppearance";
import { Button } from "../ui-shadcn/button";
import {
	Tabs,
	TabsContent,
	TabsList,
	TabsTrigger,
} from "../ui-shadcn/tabs";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../ui-shadcn/alert-dialog";
import { cn } from "../../lib/utils";
import { deepClone } from "../../utils/deepEqual";
import { buttonVariants } from "../ui-shadcn/button";
import { useVisionBridgeDraft } from "./settings/visionDraft.ts";
import { dirtySettingsTabIds, type SettingsUnsavedTabId } from "./settings/unsavedChangesSummary";
import { computeDirtyFields } from "./settings/settingsDirtyFields.ts";
import { SETTINGS_TAB_IDS, SETTINGS_TAB_LAYOUT } from "./settings/settingsTabLayout";
import { useGitModels } from "./settings/gitModels.ts";
import { formatSettingsUnsavedMessage, summarizeSettingsUnsavedChanges } from "./settings/unsavedChangesSummary.ts";
import { UpdateInstallUnsavedDialog } from "./settings/UpdateInstallUnsavedDialog.tsx";
import type { AppSettings, AppInfo, AvailableModel, PiInstallStatus, PiUpdateCheckResult, PiCliUpdateResult } from "../../../../shared/types";

// ── 各 tab 内容 lazy 加载：首开只下载壳 + 当前 tab 的 chunk（qrcode/表格/日志查看器等
//    重依赖随各自 tab 拆包），切换到某 tab 时才加载其 chunk（本地文件，秒级以内）。──
const CommonTab = lazy(() => import("./settings/CommonTab").then((m) => ({ default: m.CommonTab })));
const AppearanceTab = lazy(() => import("./settings/AppearanceTab").then((m) => ({ default: m.AppearanceTab })));
const ProxyTab = lazy(() => import("./settings/ProxyTab").then((m) => ({ default: m.ProxyTab })));
const WebTab = lazy(() => import("./settings/WebTab").then((m) => ({ default: m.WebTab })));
const EditorsTab = lazy(() => import("./settings/EditorsTab").then((m) => ({ default: m.EditorsTab })));
const GitTab = lazy(() => import("./settings/GitTab").then((m) => ({ default: m.GitTab })));
const DevTab = lazy(() => import("./settings/DevTab").then((m) => ({ default: m.DevTab })));
const PetTab = lazy(() => import("./settings/PetTab").then((m) => ({ default: m.PetTab })));
const SoundTab = lazy(() => import("./settings/SoundTab").then((m) => ({ default: m.SoundTab })));
const ImTab = lazy(() => import("./settings/ImTab").then((m) => ({ default: m.ImTab })));
const StorageTab = lazy(() => import("./settings/SettingsStorageTab").then((m) => ({ default: m.StorageTab })));
const ProcessMetricsTab = lazy(() => import("./settings/ProcessMetricsTab").then((m) => ({ default: m.ProcessMetricsTab })));
const UsageStatsTab = lazy(() => import("./settings/UsageStatsTab").then((m) => ({ default: m.UsageStatsTab })));
const VisionBridgeSettingsTab = lazy(() => import("./settings/VisionBridgeSettingsTab").then((m) => ({ default: m.VisionBridgeSettingsTab })));
const ImageGenSettingsTab = lazy(() => import("./settings/ImageGenSettingsTab").then((m) => ({ default: m.ImageGenSettingsTab })));

// 配置管理分区（pi 配置文件管理）作为独立 chunk 懒加载：首开设置窗口不加载 ConfigModal 数组。
const ConfigPane = lazy(() =>
	import("../../ConfigModal").then((m) => ({ default: m.ConfigPane })),
);
import type { ConfigPaneHandle, ConfigPaneState } from "../../ConfigModal";

// DSH 配置（HOME / 审批 / 外部会话）只放配置管理，避免设置页再开一个重复 tab
// SettingsTabId 定义在 atoms，深链与侧栏共用同一套合法 tab；
// 展示顺序与分组分割线统一收敛在 settings/settingsTabLayout.ts。

/** localStorage 键：设置页上次打开的 tab（重开弹窗时恢复位置，跨应用重启保留）。 */
const SETTINGS_LAST_TAB_KEY = "pideck-settings-last-tab";

/** localStorage 键：设置窗口上次打开的顶层分区（系统设置/配置管理，重开时恢复位置）。 */
const SETTINGS_LAST_PANE_KEY = "pideck-settings-last-pane";

/**
 * 读取上次打开的设置 tab；localStorage 不可用、无记录或值已失效时回退默认值 "common"。
 * Radix Dialog 关闭会卸载内容，state 在每次打开时重建，因此需要从外部存储恢复。
 */
function loadLastSettingsTab(): SettingsTabId {
	try {
		const raw = localStorage.getItem(SETTINGS_LAST_TAB_KEY);
		if (raw && (SETTINGS_TAB_IDS as readonly string[]).includes(raw)) return raw as SettingsTabId;
	} catch {
		/* localStorage 不可用（隐私模式等）时静默失败 */
	}
	return "common";
}

/** 读取上次打开的顶层分区；无记录或值已失效时回退 "settings"。 */
function loadLastSettingsPane(): SettingsPaneId {
	try {
		const raw = localStorage.getItem(SETTINGS_LAST_PANE_KEY);
		if (raw === "config") return "config";
	} catch {
		/* localStorage 不可用（隐私模式等）时静默失败 */
	}
	return "settings";
}

type SettingsModalProps = {
	settings: AppSettings;
	piStatus: PiInstallStatus | null;
	piChecking: boolean;
	piProxyChecking: boolean;
	piProxyNotice: string;
	piProxyNoticeTone: "info" | "success" | "error";
	webServiceChanging: boolean;
	onRestartWebService: () => void;
	appInfo: AppInfo;
	customPiPath: string;
	customPathValidating: boolean;
	customPathResult: PiInstallStatus | null;
	updateChecking: boolean;
	piUpdating: boolean;
	piUpdateChecking: boolean;
	piUpdateCheck: PiUpdateCheckResult | null;
	piUpdateResult: PiCliUpdateResult | null;
	onCustomPathChange: (path: string) => void;
	onValidateCustomPath: () => void;
	onClearCustomPath: () => void;
	onCheckPi: () => void;
	onTestPiProxy: () => void;
	onCheckUpdate: () => void;
	/** 未自动下载时的手动下载（electron-updater downloadUpdate）。 */
	onDownloadUpdate: () => void;
	/** 重启并安装已下载的更新（electron-updater quitAndInstall）。 */
	onInstallUpdate: () => void;
	onCheckPiUpdate: () => void;
	onUpdatePi: () => void;
	onToggleDevTools: () => void;
	onRestartApp: () => void;
	onClearCheckFlag?: () => void;
	onOpenWebService: (port: string) => void;
	onClose: () => void;
	onChange: (patch: Partial<AppSettings>) => Promise<boolean>;
	/** 当前项目路径：有值时配置管理分区合并项目 `.mcp.json` / `.pi/mcp.json`（只读）。 */
	projectPath?: string;
};

/**
 * 设置弹框错误边界：渲染异常时保留可关闭的错误面板，避免整页白屏无法退出。
 */
// 小窗口保留外边距，避免设置页完全压住工作区；821px 以上恢复桌面弹框尺寸。
// DialogContent 默认带 sm:max-w-lg，必须显式覆盖它，否则小窗口会变成窄高条。
const settingsModalSizeClass = "w-[80vw] max-w-[80vw] h-[80vh] max-h-[80vh] sm:max-w-[min(1300px,80vw)]";

class SettingsModalErrorBoundary extends Component<
	{ onClose: () => void; children: ReactNode },
	{ error: Error | null }
> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override render() {
		if (!this.state.error) return this.props.children;
		// #115：错误兜底直接走 shadcn Dialog 外壳
		return (
			<Dialog open onOpenChange={(next) => !next && this.props.onClose()}>
			<DialogContent showCloseButton={false} className={cn("flex flex-col gap-0 overflow-hidden p-0", settingsModalSizeClass, "settings-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.loadFailed")}</DialogTitle>
					<DialogClose asChild>
						<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
							<X size={18} strokeWidth={2.2} aria-hidden="true" />
						</Button>
					</DialogClose>
				</DialogHeader>
				<div className="settings-layout">
					<div className="settings-content" style={{ padding: "var(--space-5)" }}>
						<div className="config-diagnostic-card">
							<div>
								<strong>{t("settings.renderCrashed")}</strong>
								<span>{this.state.error.message}</span>
								<small>{t("settings.renderCrashedHelp")}</small>
							</div>
							<pre>{this.state.error.stack ?? this.state.error.message}</pre>
						</div>
					</div>
				</div>
			</DialogContent>
			</Dialog>
		);
	}
}

/** tab chunk 加载占位：轻量居中提示，避免首次切到某 tab 时空白闪烁 */
function SettingsTabLoading() {
	return (
		<div className="settings-panel grid min-w-0 min-h-40 place-items-center text-caption text-text-tertiary">
			{t("common.loading")}
		</div>
	);
}

/**
 * 设置弹框。memo + SettingsFeatureRoot 内稳定 props：
 * App 根组件重渲染（如 agent 流式输出）不会连带重渲染整个设置页。
 */
export const SettingsModal = memo(function SettingsModal(props: SettingsModalProps) {
	return (
		<SettingsModalErrorBoundary onClose={props.onClose}>
			<SettingsModalContent {...props} />
		</SettingsModalErrorBoundary>
	);
});

/**
 * 各 tab 的图标与文案 key 元数据：label 渲染时经 t() 取当前语言文案（不能模块级求值，
 * 否则语言切换后不生效）；展示顺序与分割线由 SETTINGS_TAB_LAYOUT 决定（settingsTabLayout.ts）。
 */
const TAB_META: Record<SettingsTabId, { labelKey: TranslationKey; icon: ReactNode }> = {
	common: { labelKey: "settings.tabs.common", icon: <Settings2 size={16} /> },
	appearance: { labelKey: "settings.tabs.appearance", icon: <Brush size={16} /> },
	proxy: { labelKey: "settings.tabs.proxy", icon: <Network size={16} /> },
	web: { labelKey: "settings.tabs.web", icon: <Globe size={16} /> },
	editors: { labelKey: "settings.tabs.editors", icon: <FileCode2 size={16} /> },
	git: { labelKey: "settings.tabs.git", icon: <GitBranch size={16} /> },
	dev: { labelKey: "settings.tabs.dev", icon: <Wrench size={16} /> },
	im: { labelKey: "settings.tabs.im", icon: <MessageSquare size={16} /> },
	pet: { labelKey: "settings.tabs.pet", icon: <PawPrint size={16} /> },
	sound: { labelKey: "settings.tabs.sound", icon: <Volume2 size={16} /> },
	storage: { labelKey: "settings.tabs.storage", icon: <Trash2 size={16} /> },
	usage: { labelKey: "settings.tabs.usage", icon: <ChartColumnBig size={16} /> },
	process: { labelKey: "settings.tabs.process", icon: <Activity size={16} /> },
	vision: { labelKey: "settings.tabs.vision", icon: <Eye size={16} /> },
	imagegen: { labelKey: "settings.tabs.imagegen", icon: <ImageIcon size={16} /> },
};

/**
 * 设置弹框壳：只持有跨 tab 共享状态（草稿/脏标记/视觉桥/重置信号）与 Tabs 导航，
 * 各 tab 内容拆为独立 memo 组件（settings/*Tab.tsx），切换 tab 只挂载目标 tab。
 */
function SettingsModalContent(props: SettingsModalProps) {
	// 弹窗每次打开都会重新挂载（Radix Dialog 关闭即卸载内容）。
	// 深链（如 Git「去设置」）优先于上次记住的 tab，否则会停在外观/开发等其它页。
	const [activeTab, setActiveTab] = useState<SettingsTabId>(
		() => getDefaultStore().get(settingsFocusAtom)?.tab ?? loadLastSettingsTab(),
	);
	const persistTab = useCallback((tab: SettingsTabId) => {
		try {
			localStorage.setItem(SETTINGS_LAST_TAB_KEY, tab);
		} catch {
			/* localStorage 不可用时只影响本次记忆 */
		}
	}, []);
	const persistPane = useCallback((value: SettingsPaneId) => {
		try {
			localStorage.setItem(SETTINGS_LAST_PANE_KEY, value);
		} catch {
			/* localStorage 不可用时只影响本次记忆 */
		}
	}, []);
	// 顶层分区（系统设置 / 配置管理）：重开时恢复上次位置；深链（侧栏「配置管理」）优先
	const [pane, setPane] = useState<SettingsPaneId>(() => {
		const target = getDefaultStore().get(settingsFocusAtom);
		return target?.pane === "config" ? "config" : loadLastSettingsPane();
	});
	// 深链：窗口已在打开状态时点侧栏「配置管理」→ 切到配置管理分区。
	// 本 effect 定义在 useSettingsFocus 之前（其 effect 会消费并清空 focus），保证先读到带 pane 的焦点。
	const [focusPaneTarget] = useAtom(settingsFocusAtom);
	// 深链的配置分页/供应商定位：快照进本地 state（focus atom 随后会被 useSettingsFocus 清空，
	// 配置分区深链「圆球 → 去配置用量」需要在整个设置会话期间保持可投递给 ConfigPane）。
	const [configFocus, setConfigFocus] = useState<{ configTab?: "models" | "auth" | "settings" | "trust" | "mcp" | "raw"; provider?: string; backendPane?: "dsh" | "pi" } | null>(() => {
		const target = getDefaultStore().get(settingsFocusAtom);
		return target?.pane === "config" ? { configTab: target.configTab, provider: target.provider, backendPane: target.backendPane } : null;
	});
	useEffect(() => {
		if (focusPaneTarget?.pane === "config") {
			setPane("config");
			setConfigFocus({ configTab: focusPaneTarget.configTab, provider: focusPaneTarget.provider, backendPane: focusPaneTarget.backendPane });
		}
	}, [focusPaneTarget]);
	useSettingsFocus(activeTab, setActiveTab, persistTab);
	// ── 全局设置草稿：进入弹框时快照 props.settings，所有修改在 draft 上操作，保存时统一提交 ──
	const [draftSettings, setDraftSettings] = useState<AppSettings>(() => deepClone(props.settings));
	/** 打开弹框时的原始设置快照（磁盘基准），用于取消回退与脏检测对比。 */
	const baseSnapshotRef = useRef<AppSettings>(deepClone(props.settings));
	// baseSnapshotRef 是 ref（lint 规范不入 useMemo 依赖），saveAll 推进基准后 draftSettings
	// 引用不变，dirtyFields useMemo 会返回缓存的旧非空集合 → 保存后关闭仍误报"有未保存"。
	// baselineToken 在基准被推进时 bump，让 useMemo 重算为空集。
	const [baselineToken, setBaselineToken] = useState(0);
	/**
	 * 脏字段 = 草稿与基准快照的真实差异（deepEqual），不再用「touched 集合」记录。
	 * 好处：改回原值即自动摘掉脏标记，关闭确认 / 左侧黄点 / 保存按钮只反映真实未保存改动。
	 * 遍历键并集（computeDirtyFields）而非仅草稿键，避免漏掉「字段被删除」的差异。
	 */
	const dirtyFields = useMemo(
		() => computeDirtyFields(draftSettings as Record<string, unknown>, baseSnapshotRef.current as Record<string, unknown>),
		[draftSettings, baselineToken],
	);
	// ── 视觉桥草稿：独立于全局设置（写 pi-deck-vision.json，走独立 IPC），脏标记/保存/取消由弹框统一管理 ──
	const visionDraft = useVisionBridgeDraft();
	// ── 生图草稿：独立文件 userData/imagegen.json，不属于 pi/dsh，放在设置页统一管理 ──
	const imageGenRef = useRef<{ save: () => Promise<boolean> } | null>(null);
	const [imageGenDirty, setImageGenDirty] = useState(false);
	const handleImageGenDirtyChange = useCallback((dirty: boolean) => setImageGenDirty(dirty), []);
	// 左侧导航黄点来源：与关闭确认同一套字段目录，避免两处口径不一致
	const dirtyTabIds = useMemo(
		() => dirtySettingsTabIds({ dirtyFields, visionDirty: visionDraft.dirty, imageGenDirty }),
		[dirtyFields, visionDraft.dirty, imageGenDirty],
	);
	/** 各 tab 的局部编辑态（WSL 输入/Web 端口/宠物预览模式）在取消时通过递增信号重置 */
	const [devTabResetKey, setDevTabResetKey] = useState(0);
	const [webTabResetKey, setWebTabResetKey] = useState(0);
	const [petTabResetKey, setPetTabResetKey] = useState(0);

	/** 更新草稿；脏字段由 useMemo 按真实差异推导，无需手动登记（改回原值自动变干净）。 */
	const updateDraft = useCallback((patch: Partial<AppSettings>) => {
		setDraftSettings((prev) => ({ ...prev, ...patch }));
	}, []);

	// 外观实时预览：草稿中明暗/外观主题/主色变化时立即写入 <html> 的 data-* 属性，
	// 与 App.tsx 的持久化应用共用 applyAppearanceAttributes（见 themeAppearance.ts）。
	// 保存后由 App 的 settings effect 接管；取消时在 cancelAll 里回滚回 baseSnapshot。
	useEffect(() => {
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		applyAppearanceAttributes(
			document.documentElement,
			draftSettings as AppearanceSettings,
			Boolean(media?.matches),
		);
	}, [
		draftSettings.theme,
		draftSettings.themeScheduleLightStart,
		draftSettings.themeScheduleDarkStart,
		draftSettings.themeSkin,
		draftSettings.accent,
	]);

	/** 检查指定字段在草稿中是否已被修改（与基准快照真实差异比较）。 */
	const isDirty = useCallback((field: keyof AppSettings): boolean => {
		return dirtyFields.has(String(field));
	}, [dirtyFields]);

	/** 把 <html> 的 data-* 外观属性还原为打开弹窗时的快照（App 的 settings effect
	 *  只在 settings 实际变化时重跑，取消/放弃不触发，必须在这里显式恢复预览）。 */
	const restoreAppearanceFromSnapshot = useCallback(() => {
		const media = window.matchMedia?.("(prefers-color-scheme: dark)");
		applyAppearanceAttributes(
			document.documentElement,
			baseSnapshotRef.current as AppearanceSettings,
			Boolean(media?.matches),
		);
	}, []);

	/** 保存全部内容：全局设置差异提交（无差异也提交空 patch，触发「已保存」反馈）+ 视觉桥/生图草稿（若有改动）；返回是否全部成功 */
	const saveAll = async (): Promise<boolean> => {
		let ok = true;
		// 无修改也支持再次保存：始终提交当前草稿差异（无差异即空 patch），
		// updateSettings 会走 api.settings.update 并提示「设置已保存」，因此保存按钮无需因「无修改」禁用。
		const patch: Partial<AppSettings> = {};
		for (const key of dirtyFields) {
			(patch as Record<string, unknown>)[key] = (draftSettings as Record<string, unknown>)[key];
		}
		// 需要等持久化结果再推进基准；更新安装会马上退出，不能让异步写入被进程终止。
		const settingsOk = await props.onChange(patch).catch(() => false);
		ok = ok && settingsOk;
		if (settingsOk) {
			baseSnapshotRef.current = deepClone(draftSettings);
			// baseSnapshotRef 是 ref 不在 useMemo 依赖里：仅推进基准而不 bump token，
			// dirtyFields 会停在保存前的非空集合（draftSettings 引用未变），关闭弹框误报未保存。
			setBaselineToken((v) => v + 1);
		}
		if (visionDraft.dirty) {
			// 视觉桥保存失败（如 API Key 缺失/接口不可达）时保留脏标记，头部按钮可重试
			const visionOk = await visionDraft.save();
			ok = ok && visionOk;
		}
		if (imageGenDirty) {
			const imageGenOk = (await imageGenRef.current?.save()) ?? false;
			ok = ok && imageGenOk;
			// 保存成功后脏标记由子组件通过 onDirtyChange 自动清掉
		}
		return ok;
	};

	/** 取消全部修改：将草稿回退到初始快照，丢弃所有未保存变更（含视觉桥/生图草稿与各 tab 局部编辑态） */
	const cancelAll = () => {
		setDraftSettings(deepClone(baseSnapshotRef.current));
		restoreAppearanceFromSnapshot();
		visionDraft.reset();
		setPerAreaFontSize(
			baseSnapshotRef.current.uiFontSize !== null ||
				baseSnapshotRef.current.chatFontSize !== null ||
				baseSnapshotRef.current.inputFontSize !== null,
		);
		// tab 局部编辑态（WSL 输入、Web 端口、宠物预览）由各自 tab 监听信号重置
		setDevTabResetKey((k) => k + 1);
		setWebTabResetKey((k) => k + 1);
		setPetTabResetKey((k) => k + 1);
	};

	// ── 配置管理分区（ConfigPane）标题栏状态：保存禁用 / 黄点 / 确认清单由嵌入分区上报 ──
	const configPaneRef = useRef<ConfigPaneHandle>(null);
	const [configPaneState, setConfigPaneState] = useState<ConfigPaneState>({
		saving: false,
		hasDirty: false,
		unsaved: { totalCount: 0, items: [] },
	});
	const handleConfigPaneStateChange = useCallback(
		(state: ConfigPaneState) => setConfigPaneState(state),
		[],
	);
	/** 当前顶层分区是否为「配置管理」（标题栏按钮/关闭确认都按此切换）。 */
	const isConfigPane = pane === "config";

	// 生图 tab 的取消：脏标记由子组件内部管理，取消时不主动重置（下次打开重新加载）；
	// 若需强制重置可在子组件暴露 reset 方法，这里仅确保关闭流程不遗漏生图脏检查

	/** 关闭弹框：系统设置草稿与配置管理草稿任一有未保存变化都统一弹确认（不再按分区委托），
	 *  配置分区的脏状态由 ConfigPane 上报（onStateChange.hasDirty）；无任何脏直接关闭。 */
	const handleClose = () => {
		const settingsDirty = dirtyFields.size > 0 || visionDraft.dirty || imageGenDirty;
		if (settingsDirty || configPaneState.hasDirty) {
			setCloseConfirmOpen(true);
		} else {
			props.onClose();
		}
	};

	/** 保存关闭/安装前的全部脏来源；任一来源失败时保留弹窗和草稿供用户重试。 */
	const savePendingChanges = async (): Promise<boolean> => {
		const settingsDirty = dirtyFields.size > 0 || visionDraft.dirty || imageGenDirty;
		const settingsOk = settingsDirty ? await saveAll() : true;
		const configOk = configPaneState.hasDirty
			? ((await configPaneRef.current?.saveAllDirty()) ?? false)
			: true;
		return settingsOk && configOk;
	};

	/** 关闭确认弹框时选择保存并关闭：系统设置与配置管理的脏来源都保存成功才关闭。 */
	const handleSaveAndClose = async () => {
		setCloseConfirmOpen(false);
		if (await savePendingChanges()) props.onClose();
	};

	/** 放弃修改时，外观实时预览已写入 <html>，需显式回滚为快照值。 */
	const discardPendingChanges = () => {
		restoreAppearanceFromSnapshot();
	};

	/** 关闭确认弹框时选择放弃更改。 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		discardPendingChanges();
		props.onClose();
	};

	const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
	const [installConfirmOpen, setInstallConfirmOpen] = useState(false);

	/** 安装会终止进程；任何内存草稿都必须先由用户保存或明确放弃。 */
	const handleInstallUpdate = () => {
		const settingsDirty = dirtyFields.size > 0 || visionDraft.dirty || imageGenDirty;
		if (settingsDirty || configPaneState.hasDirty) {
			setInstallConfirmOpen(true);
			return;
		}
		props.onInstallUpdate();
	};

	const handleSaveAndInstall = async () => {
		setInstallConfirmOpen(false);
		if (!(await savePendingChanges())) return;
		props.onClose();
		props.onInstallUpdate();
	};

	const handleDiscardAndInstall = () => {
		setInstallConfirmOpen(false);
		discardPendingChanges();
		props.onClose();
		props.onInstallUpdate();
	};

	const [perAreaFontSize, setPerAreaFontSize] = useState(
		draftSettings.uiFontSize !== null ||
			draftSettings.chatFontSize !== null ||
			draftSettings.inputFontSize !== null,
	);

	// Git 摘要模型列表与会话 Command 选择器共用 pi --list-models 数据源。
	const { gitModels, report: gitModelsReport, refreshing: gitModelsRefreshing, reload: reloadGitModels, gitModelPickerOpen, openPicker: openGitModelPicker, closePicker: closeGitModelPicker } = useGitModels();

	/** 选择提交信息模型：写入草稿并关闭选择器 */
	const handlePickGitModel = useCallback((model: AvailableModel) => {
		updateDraft({
			gitCommitMessageProvider: model.provider,
			gitCommitMessageModel: model.id,
		});
		closeGitModelPicker();
	}, [updateDraft, closeGitModelPicker]);

	/** 收藏/取消收藏提交信息模型 */
	const handleToggleGitModelFavorite = useCallback((provider: string, modelId: string) => {
		const key = `${provider}/${modelId}`;
		const favorites = draftSettings.favoriteModels ?? [];
		updateDraft({
			favoriteModels: favorites.includes(key)
				? favorites.filter((item) => item !== key)
				: [...favorites, key],
		});
	}, [draftSettings.favoriteModels, updateDraft]);

	// 侧栏条目 = 布局模块定义的顺序/分组边界 + 上面的图标文案元数据
	const tabs = SETTINGS_TAB_LAYOUT.map((entry) => ({
		id: entry.id,
		dividerBefore: entry.dividerBefore ?? false,
		label: t(TAB_META[entry.id].labelKey),
		icon: TAB_META[entry.id].icon,
	}));

	const hasDirtyChanges = dirtyFields.size > 0;
	// 视觉桥/生图草稿有未保存改动时，头部保存/取消按钮同样点亮（与全局设置脏标记合并判定）
	const hasAnyDirtyChanges = hasDirtyChanges || visionDraft.dirty || imageGenDirty;
	// 关闭确认：列出全部变更项（不再只点第一条），多项按设置页 tab/字段顺序逐条展示。
	const unsavedSummary = useMemo(
		() =>
			summarizeSettingsUnsavedChanges({
				dirtyFields,
				visionDirty: visionDraft.dirty,
				imageGenDirty,
			}),
		[dirtyFields, visionDraft.dirty, imageGenDirty],
	);
	const unsavedCloseMessage = useMemo(
		() => formatSettingsUnsavedMessage(unsavedSummary, t),
		[unsavedSummary],
	);
	// 关闭确认清单 = 系统设置 + 配置管理两区未保存项合并（配置项由 ConfigPane 上报）
	const mergedUnsavedItems = useMemo(
		() => [...(unsavedSummary?.items ?? []), ...configPaneState.unsaved.items],
		[unsavedSummary, configPaneState.unsaved],
	);
	const mergedUnsavedCount =
		(unsavedSummary?.totalCount ?? 0) + configPaneState.unsaved.totalCount;

	return (
		<Dialog open onOpenChange={(next) => !next && handleClose()}>
			<DialogContent showCloseButton={false} stagger className={cn("flex flex-col gap-0 overflow-hidden p-0", settingsModalSizeClass, "settings-modal", "[--wallpaper-dialog-alpha:var(--wallpaper-panel-alpha,30%)]")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.title")}</DialogTitle>
					<div className="flex items-center gap-2">
						{isConfigPane ? (
							/* 配置管理分区：按钮与独立 ConfigModal 标题栏同源（ConfigPane ref 委托同一个 handler），
							   黄点/禁用态由配置页内部脏集合与保存状态上报 */
							<>
								<Button
									variant="default"
									size="sm"
									onClick={() => void configPaneRef.current?.saveCurrent()}
									disabled={configPaneState.saving}
									title={configPaneState.hasDirty ? t("config.dirtyTooltip") : undefined}
								>
									{configPaneState.hasDirty && (
										<span className="size-2 rounded-full bg-amber-400" aria-hidden="true" />
									)}
									{configPaneState.saving ? t("common.saving") : t("common.save")}
								</Button>
								<Button
									variant="outline"
									size="sm"
									onClick={() => configPaneRef.current?.exportConfig()}
								>
									{t("common.export")}
								</Button>
								{/* 导入与导出统一 outline 白底描边（与独立 ConfigModal 同款），避免一描边一填充的不一致 */}
								<Button
									variant="outline"
									size="sm"
									onClick={() => configPaneRef.current?.importConfig()}
								>
									{t("common.import")}
								</Button>
							</>
						) : (
							/* 应用设置分区：保存常驻且不因「无修改」禁用（无修改也允许再次保存）；
							   视觉桥保存中禁用防重复提交；有未保存变更时显示「放弃更改」 */
							<>
								<Button
									variant="default"
									size="sm"
									onClick={saveAll}
									disabled={visionDraft.saving || (visionDraft.dirty && visionDraft.modelMissing)}
									// 视觉桥开启但未选模型时禁用保存：悬停说明原因（对应 visionDraft 的 modelRequired 提示）
									title={
										visionDraft.dirty && visionDraft.modelMissing
											? t("settings.vision.modelRequired")
											: undefined
									}
								>
									{t("common.save")}
								</Button>
								{hasAnyDirtyChanges ? (
									/* 放弃更改用 outline（白底描边）而非灰底 secondary：与黑色主按钮形成
									   清晰的主次层级（shadcn dialog 的 confirm/cancel 惯例），避免一对按钮
									   都是灰色填充分不出哪个是提交。 */
									<Button variant="outline" size="sm" onClick={cancelAll}>
										{t("common.cancel")}
									</Button>
								) : undefined}
							</>
						)}
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
			{/* 顶层分区：系统设置 / 配置管理。样式对齐配置页 Pi/DSH 分页（config-backend-switch），
			    黄点 = 对应分区的未保存草稿；两个分区都保持挂载（forceMount + hidden）不丢草稿 */}
			<Tabs value={pane} onValueChange={(v) => {
				const next: SettingsPaneId = v === "config" ? "config" : "settings";
				setPane(next);
				persistPane(next);
			}} className="flex min-h-0 min-w-0 flex-1 flex-col">
				{/* 顶层分区 tab：直接用 shadcn Tabs 默认观感（bg-muted p-1 圆角条），与全局组件统一；
				    不再套自定义 tab 条样式，只做外边距/自定宽定位。 */}
				<TabsList className="mx-3 mt-2.5 w-auto justify-start gap-0.5 self-start" aria-label={t("settings.title")}>
					<TabsTrigger value="settings" className="h-8 gap-1.5 px-3 text-[13px]">
						<MonitorCog className="size-4" aria-hidden="true" />
						{t("settings.panes.system")}
						{/* 系统设置分区黄点：全局设置/视觉桥/生图草稿任一有未保存 */}
						{hasAnyDirtyChanges ? <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
					</TabsTrigger>
					<TabsTrigger value="config" className="h-8 gap-1.5 px-3 text-[13px]">
						<SlidersHorizontal className="size-4" aria-hidden="true" />
						{t("settings.panes.config")}
						{/* 配置管理分区黄点：由 ConfigPane 内部脏集合上报 */}
						{configPaneState.hasDirty ? <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
					</TabsTrigger>
				</TabsList>
				<TabsContent value="config" forceMount hidden={pane !== "config"} className="flex min-h-0 min-w-0 flex-1 flex-col">
					<Suspense fallback={<SettingsTabLoading />}>
						<ConfigPane
							ref={configPaneRef}
							onClose={props.onClose}
							projectPath={props.projectPath}
							focusConfigTab={configFocus?.configTab}
							focusProvider={configFocus?.provider}
							focusBackendPane={configFocus?.backendPane}
							onStateChange={handleConfigPaneStateChange}
							// 嵌套弹层（用量查询「让 AI 帮我查」）整窗关闭走统一关闭确认，
							// 不直连 onClose 裸关闭——系统设置/配置管理草稿都不能被静默丢弃。
							onRequestClose={handleClose}
						/>
					</Suspense>
				</TabsContent>
				<TabsContent value="settings" forceMount hidden={pane !== "settings"} className="flex min-h-0 min-w-0 flex-1 flex-col">
			<Tabs orientation="vertical" value={activeTab} onValueChange={(v) => { const match = tabs.find((t) => t.id === v); if (!match) return; setActiveTab(match.id); persistTab(match.id); }} className="settings-layout flex min-h-0 flex-1 flex-row gap-0 bg-transparent">
					<TabsList className="settings-tabs flex min-h-0 shrink-0 flex-col items-stretch gap-2.5 overflow-auto border-0 border-r border-border rounded-none bg-transparent p-2.5 data-[orientation=vertical]:w-[196px]" aria-label={t("settings.title")}>
						{tabs.map((tab) => (
							<Fragment key={tab.id}>
								{/* 分组分割线（纯视觉）：竖排侧栏为横线；≤820px 横排时变竖线，
								    与 surfaces.css 里 .settings-tabs 转横向布局的媒体查询同条件 */}
								{tab.dividerBefore ? (
									<div
										aria-hidden="true"
										className="my-1.5 h-px w-auto shrink-0 bg-border-subtle max-[820px]:mx-1 max-[820px]:my-0 max-[820px]:h-auto max-[820px]:w-px"
									/>
								) : null}
								<TabsTrigger value={tab.id} className="config-nav-btn h-8 justify-start gap-1.5 px-2.5 text-control font-medium">
									<span className="settings-tab-icon">{tab.icon}</span>
									<strong>{tab.label}</strong>
								{/* 未保存黄点：按字段目录归并到所属 tab，视觉桥草稿算 vision */}
								{dirtyTabIds.has(tab.id as SettingsUnsavedTabId) ? <span className="ml-auto size-1.5 rounded-full bg-amber-500" aria-hidden="true" /> : null}
								</TabsTrigger>
							</Fragment>
						))}
					</TabsList>
					{/* ── 常用设置 tab ── */}
					{activeTab === "common" && (
						<TabsContent value="common" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<CommonTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 外观设置 tab ── */}
					{activeTab === "appearance" && (
						<TabsContent value="appearance" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<AppearanceTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								perAreaFontSize={perAreaFontSize}
								setPerAreaFontSize={setPerAreaFontSize}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 代理设置 tab ── */}
					{activeTab === "proxy" && (
						<TabsContent value="proxy" className="settings-panel min-w-0 [overflow-anchor:none]">
							<Suspense fallback={<SettingsTabLoading />}>
							<ProxyTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								piProxyChecking={props.piProxyChecking}
								piProxyNotice={props.piProxyNotice}
								piProxyNoticeTone={props.piProxyNoticeTone}
								onTestPiProxy={props.onTestPiProxy}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 局域网 Web 服务 tab（原为开发设置内区块） ── */}
					{activeTab === "web" && (
						<TabsContent value="web" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<WebTab
								draft={draftSettings}
								updateDraft={updateDraft}
								webServiceChanging={props.webServiceChanging}
								onOpenWebService={props.onOpenWebService}
								onRestartWebService={props.onRestartWebService}
								resetKey={webTabResetKey}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 外部编辑器 tab（由 Pi 管理界面迁入，原为开发设置内区块） ── */}
					{activeTab === "editors" && (
						<TabsContent value="editors" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<EditorsTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── Git 设置 tab（原为常用设置内区块，由 Git 面板深链直达） ── */}
					{activeTab === "git" && (
						<TabsContent value="git" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<GitTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								gitModels={gitModels}
								gitModelsReport={gitModelsReport}
								gitModelsRefreshing={gitModelsRefreshing}
								onRefreshGitModels={() => reloadGitModels(true)}
								gitModelPickerOpen={gitModelPickerOpen}
								onOpenGitModelPicker={openGitModelPicker}
								onCloseGitModelPicker={closeGitModelPicker}
								onPickGitModel={handlePickGitModel}
								onToggleGitModelFavorite={handleToggleGitModelFavorite}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 开发设置 tab（环境/版本/运行/调试；Web 与外部编辑器已拆独立 tab） ── */}
					{activeTab === "dev" && (
						<TabsContent value="dev" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<DevTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								appInfo={props.appInfo}
								piStatus={props.piStatus}
								piChecking={props.piChecking}
								customPiPath={props.customPiPath}
								customPathValidating={props.customPathValidating}
								customPathResult={props.customPathResult}
								onCustomPathChange={props.onCustomPathChange}
								onValidateCustomPath={props.onValidateCustomPath}
								onClearCustomPath={props.onClearCustomPath}
								onCheckPi={props.onCheckPi}
								onClearCheckFlag={props.onClearCheckFlag}
								piUpdateChecking={props.piUpdateChecking}
								onCheckPiUpdate={props.onCheckPiUpdate}
								piUpdating={props.piUpdating}
								onUpdatePi={props.onUpdatePi}
								piUpdateCheck={props.piUpdateCheck}
								piUpdateResult={props.piUpdateResult}
								updateChecking={props.updateChecking}
								onCheckUpdate={props.onCheckUpdate}
								onDownloadUpdate={props.onDownloadUpdate}
								onInstallUpdate={handleInstallUpdate}
								onToggleDevTools={props.onToggleDevTools}
								onRestartApp={props.onRestartApp}
								resetKey={devTabResetKey}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 外部连接 tab（飞书机器人，由 Pi 管理界面迁入） ── */}
					{activeTab === "im" && (
						<TabsContent value="im" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<ImTab />
							</Suspense>
						</TabsContent>
					)}

					{/* ── 桌面宠物 tab ── */}
					{activeTab === "pet" && (
						<TabsContent value="pet" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<PetTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
								resetKey={petTabResetKey}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 声音提醒 tab ── */}
					{activeTab === "sound" && (
						<TabsContent value="sound" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<SoundTab
								draft={draftSettings}
								updateDraft={updateDraft}
								isDirty={isDirty}
							/>
							</Suspense>
						</TabsContent>
					)}

					{/* ── 进程监控 tab（由 Pi 管理界面迁入） ── */}
					{activeTab === "process" && (
						<TabsContent value="process" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<ProcessMetricsTab />
							</Suspense>
						</TabsContent>
					)}
					{/* ── 存储与日志 tab ── */}
					{activeTab === "storage" && (
						<TabsContent value="storage" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<StorageTab
								settings={draftSettings}
								onChange={updateDraft}
							/>
							</Suspense>
						</TabsContent>
					)}
					{/* ── 用量统计 tab ── */}
					{activeTab === "usage" && (
						<TabsContent value="usage" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<UsageStatsTab />
							</Suspense>
						</TabsContent>
					)}
					{/* ── 视觉桥 tab：草稿/脏标记/保存由弹框统一管理，本组件只呈现表单 */}
					{activeTab === "vision" && (
						<TabsContent value="vision" className="settings-panel min-w-0">
							<Suspense fallback={<SettingsTabLoading />}>
							<VisionBridgeSettingsTab
								draft={visionDraft.draft}
								saving={visionDraft.saving}
								configDir={visionDraft.configDir}
								notice={visionDraft.notice}
								onChange={visionDraft.updateDraft}
							/>
							</Suspense>
						</TabsContent>
					)}
					{/* ── 生图 tab：独立 imagegen.json，不属于 pi/dsh，放在设置页统一管理。
					    草稿保存在 ImageGenSection 内部，切换 tab 时保持挂载（hidden 而非卸载）以免丢失未保存修改。 */}
					<TabsContent value="imagegen" className="settings-panel min-w-0" hidden={activeTab !== "imagegen"}>
						<Suspense fallback={<SettingsTabLoading />}>
							<ImageGenSettingsTab ref={imageGenRef} onDirtyChange={handleImageGenDirtyChange} />
						</Suspense>
					</TabsContent>
				</Tabs>
				</TabsContent>
			</Tabs>
			{/* 未保存变更确认对话框 */}
			{closeConfirmOpen && (
				<AlertDialog open onOpenChange={(open) => { if (!open) setCloseConfirmOpen(false); }}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("settings.unsavedTitle")}</AlertDialogTitle>
							<AlertDialogDescription asChild>
								<div className="grid max-h-56 gap-1.5 overflow-auto text-left">
									{unsavedSummary && unsavedSummary.totalCount === 1 && !configPaneState.hasDirty ? (
										/* 单项且仅设置区：沿用带「是否在关闭前保存？」的单行提示，不需要列表 */
										<p>{unsavedCloseMessage}</p>
									) : (
										<>
											{/* 多项或跨分区：先给总数，再逐条列出两区变更项（footer 按钮承担保存/放弃语义） */}
											<p>{t("settings.unsavedListIntro", { count: mergedUnsavedCount })}</p>
											<ul className="grid gap-0.5 pl-4 list-disc">
												{mergedUnsavedItems.map((item) => (
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
								{t("settings.discardChanges")}
							</AlertDialogAction>
							<AlertDialogAction onClick={handleSaveAndClose}>
								{t("settings.saveAndClose")}
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			)}
			<UpdateInstallUnsavedDialog
				open={installConfirmOpen}
				items={mergedUnsavedItems}
				count={mergedUnsavedCount}
				onCancel={() => setInstallConfirmOpen(false)}
				onDiscardAndInstall={handleDiscardAndInstall}
				onSaveAndInstall={handleSaveAndInstall}
			/>
			</DialogContent>
		</Dialog>
	);
}
