// @ts-nocheck - extracted from AppParts, pre-existing type issues
import { Component, useState, useEffect, useRef, type ReactNode } from "react";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import {
	Settings2,
	Network,
	Wrench,
	PawPrint,
	Trash2,
	Brush,
	Minus,
	Plus,
} from "lucide-react";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import { ACCENT_PRESETS } from "../../themePresets";
import { Button } from "../ui-shadcn/button";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui-shadcn/select";
import { Switch } from "../ui-shadcn/switch";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "../ui-shadcn/dialog";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { buttonVariants } from "../ui-shadcn/button";
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
import { SettingsSection, StorageTab } from "./settings/SettingsStorageTab";
import { ModelPicker } from "../session/ComposerComponents";
import type { AppSettings, AppInfo, AvailableModel, PiInstallStatus, PiUpdateCheckResult, PiCliUpdateResult, PetManifest } from "../../../shared/types";
import { GRID_COLS, CELL_W, CELL_H, MODE_ROW, MODE_FRAMES } from "../../pet/PetSpriteSheet";
import { Label } from "../../components/ui-shadcn/label";

const ZOOM_FACTOR_MIN = 0.8;
const ZOOM_FACTOR_MAX = 1.5;
const ZOOM_FACTOR_STEP = 0.05;

type SettingsTabId = "common" | "appearance" | "proxy" | "dev" | "pet" | "storage";

/** 代理相关字段：用于判断代理 tab 是否有未保存变更。 */
const PROXY_FIELDS: (keyof AppSettings)[] = [
	"piProxyEnabled",
	"piProxyUrl",
	"piProxyBypass",
	"desktopProxyEnabled",
	"desktopProxyUrl",
	"desktopProxyBypass",
];

function SettingSwitch(props: {
	title: string;
	description?: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	// #115 U5：开关换 shadcn Switch（Radix），行布局与文案结构不变
	return (
		<Label className="setting-switch-row">
			<span>
				<strong>{props.title}</strong>
				{props.description && <small>{props.description}</small>}
			</span>
			<Switch
				checked={props.checked}
				disabled={props.disabled}
				onCheckedChange={props.onChange}
			/>
		</Label>
	);
}

/** 已修改但未保存的字段标记：在标签右侧显示一个黄色圆点 */
function SettingTextarea(props: {
	title: string;
	description?: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<div className="setting-field">
			<div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
				<strong style={{ color: "var(--color-text-primary)", fontSize: "var(--font-size-control)", fontWeight: 500 }}>
					{props.title}
				</strong>
				{props.description && (
					<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)", lineHeight: 1.4 }}>
						{props.description}
					</small>
				)}
			</div>
			<Textarea
				value={props.value}
				rows={8}
				onChange={(event) => props.onChange(event.target.value)}
				style={{
					width: "100%",
					fontFamily: "var(--font-family-mono)",
					fontSize: "var(--font-size-sm)",
					padding: "var(--space-2) var(--space-3)",
					border: "1px solid var(--color-border-subtle)",
					borderRadius: "var(--radius-sm)",
					background: "var(--color-bg-input)",
					color: "var(--color-text-primary)",
					resize: "vertical",
					lineHeight: "var(--line-height-body)",
				}}
			/>
		</div>
	);
}

function DirtyMarker(props: { dirty: boolean; label: string }) {
	if (!props.dirty) return null;
	return (
		<span
			className="setting-dirty-marker"
			title={t("settings.dirtyTooltip")}
			aria-label={props.label}
		/>
	);
}

type SettingsModalProps = {
	settings: AppSettings;
	piStatus: PiInstallStatus | null;
	piChecking: boolean;
	piProxyChecking: boolean;
	piProxyNotice: string;
	piProxyNoticeTone: "info" | "success" | "error";
	webServiceChanging: boolean;
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
	onCheckPiUpdate: () => void;
	onUpdatePi: () => void;
	onToggleDevTools: () => void;
	onRestartApp: () => void;
	onClearCheckFlag?: () => void;
	onOpenWebService: (port: string) => void;
	onClose: () => void;
	onChange: (patch: Partial<AppSettings>) => void;
};

/**
 * 设置弹框错误边界：渲染异常时保留可关闭的错误面板，避免整页白屏无法退出。
 */
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
			<DialogContent showCloseButton={false} size="xl" className={cn("flex flex-col gap-0 overflow-hidden p-0", "settings-modal")}>
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

/** 对外导出：包一层错误边界，内部渲染异常时仍可关闭弹框。 */
export function SettingsModal(props: SettingsModalProps) {
	return (
		<SettingsModalErrorBoundary onClose={props.onClose}>
			<SettingsModalContent {...props} />
		</SettingsModalErrorBoundary>
	);
}

function SettingsModalContent(props: SettingsModalProps) {
	const [activeTab, setActiveTab] = useState<SettingsTabId>("common");
	// ── 全局设置草稿：进入弹框时快照 props.settings，所有修改在 draft 上操作，保存时统一提交 ──
	const [draftSettings, setDraftSettings] = useState<AppSettings>(() => ({ ...props.settings }));
	const [dirtyFields, setDirtyFields] = useState<Set<string>>(new Set());
	/** 打开弹框时的原始设置快照，用于取消时回退 */
	const baseSnapshotRef = useRef<AppSettings>({ ...props.settings });
	/** 标记是否为首次挂载（跳过外部 props.settings 同步） */
	const initialMountRef = useRef(true);

	/** 更新草稿并标记对应字段为已修改。调用方传入的 patch 中的每个 key 都会追加到 dirtyFields。 */
	const updateDraft = (patch: Partial<AppSettings>) => {
		setDraftSettings((prev) => ({ ...prev, ...patch }));
		setDirtyFields((prev) => {
			const next = new Set(prev);
			for (const key of Object.keys(patch)) {
				next.add(key);
			}
			return next;
		});
	};

	/** 检查指定字段在草稿中是否已被修改（与初始快照比较） */
	const isDirty = (field: keyof AppSettings): boolean => {
		return dirtyFields.has(field);
	};

	/** 保存全部已修改的字段：计算差异后一次性提交 */
	const saveAll = () => {
		if (dirtyFields.size === 0) return;
		const patch: Partial<AppSettings> = {};
		for (const key of dirtyFields) {
			(patch as Record<string, unknown>)[key] = (draftSettings as Record<string, unknown>)[key];
		}
		props.onChange(patch);
		// 更新快照基准为当前草稿值，并清除修改标记
		baseSnapshotRef.current = { ...baseSnapshotRef.current, ...patch };
		setDirtyFields(new Set());
	};

	/** 取消全部修改：将草稿回退到初始快照，丢弃所有未保存变更 */
	const cancelAll = () => {
		setDraftSettings({ ...baseSnapshotRef.current });
		setDirtyFields(new Set());
		setPetPreviewMode("__auto");
		setWslValidation(null);
		setWslUserInput(baseSnapshotRef.current.wslUser);
		setPerAreaFontSize(
			baseSnapshotRef.current.uiFontSize !== null ||
				baseSnapshotRef.current.chatFontSize !== null ||
				baseSnapshotRef.current.inputFontSize !== null,
		);
		setWebPortDraft(String(baseSnapshotRef.current.webServicePort));
	};

	/** 关闭弹框：有未保存变更时弹出确认对话框，无变更时直接关闭 */
	const handleClose = () => {
		if (dirtyFields.size > 0) {
			setCloseConfirmOpen(true);
		} else {
			props.onClose();
		}
	};

	/** 关闭确认弹框时选择保存并关闭 */
	const handleSaveAndClose = () => {
		saveAll();
		setCloseConfirmOpen(false);
		props.onClose();
	};

	/** 关闭确认弹框时选择放弃更改 */
	const handleDiscardAndClose = () => {
		setCloseConfirmOpen(false);
		props.onClose();
	};

	const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

	const [perAreaFontSize, setPerAreaFontSize] = useState(
		draftSettings.uiFontSize !== null ||
			draftSettings.chatFontSize !== null ||
			draftSettings.inputFontSize !== null,
	);
	const [webPortDraft, setWebPortDraft] = useState(String(draftSettings.webServicePort));
	const piPath = props.settings.customPiPath || props.piStatus?.command || "";
	const changeZoomFactor = (delta: number) => {
		const next = Math.min(
			ZOOM_FACTOR_MAX,
			Math.max(
				ZOOM_FACTOR_MIN,
				Math.round((draftSettings.zoomFactor + delta) * 100) / 100,
			),
		);
		updateDraft({ zoomFactor: next });
	};
	const fontSizeOptions = [
		{ value: "compact", label: t("settings.fontSizeCompact") },
		{ value: "default", label: t("settings.fontSizeDefault") },
		{ value: "medium", label: t("settings.fontSizeMedium") },
		{ value: "large", label: t("settings.fontSizeLarge") },
		{ value: "xlarge", label: t("settings.fontSizeXlarge") },
	];
	const fontBaseOptions = [
		{ value: "system", label: t("settings.fontFamilyBaseSystem") },
		{ value: "lxgw-wenkai", label: t("settings.fontFamilyBaseLxgwWenKai") },
		{ value: "sans", label: t("settings.fontFamilyBaseSans") },
		{ value: "serif", label: t("settings.fontFamilyBaseSerif") },
		{ value: "custom", label: t("settings.fontCustomOption") },
	];
	const fontMonoOptions = [
		{ value: "commit-mono", label: t("settings.fontFamilyMonoCommitMono") },
		{ value: "system-mono", label: t("settings.fontFamilyMonoSystemMono") },
		{ value: "custom", label: t("settings.fontCustomOption") },
	];

	// ── WSL 相关状态 ──
	const [wslUserInput, setWslUserInput] = useState(draftSettings.wslUser);
	const [wslDistros, setWslDistros] = useState<string[]>([]);
	const [wslDistrosLoading, setWslDistrosLoading] = useState(false);
	const [wslDistrosAttempted, setWslDistrosAttempted] = useState(false);
	const [wslValidating, setWslValidating] = useState(false);
	const [wslValidation, setWslValidation] = useState<{
		ok: boolean;
		whoami: string;
		piVersion: string;
		error: string;
	} | null>(null);
	// WSL 发行版列表懒加载（仅 Windows + WSL 开启时拉取，无论成败只拉一次）
	useEffect(() => {
		const isWin = props.appInfo.platform === "win32";
		if (isWin && draftSettings.wslEnabled && !wslDistrosAttempted && !wslDistrosLoading && window.piDesktop.wsl) {
			setWslDistrosLoading(true);
			window.piDesktop.wsl
				.listDistros()
				.then((list) => { setWslDistros(list); setWslDistrosAttempted(true); })
				.catch(() => { setWslDistros([]); setWslDistrosAttempted(true); })
				.finally(() => setWslDistrosLoading(false));
		}
	}, [draftSettings.wslEnabled, wslDistrosAttempted, wslDistrosLoading, props.appInfo.platform]);

	const distroOptions = wslDistros.length > 0
		? wslDistros.map((d) => ({ value: d, label: d }))
		: [{ value: draftSettings.wslDistro, label: draftSettings.wslDistro }];

	const handleValidateWslUser = async () => {
		if (!window.piDesktop.wsl) {
			setWslValidation({ ok: false, whoami: "", piVersion: "", error: t("settings.wsl.apiUnavailable") });
			return;
		}
		setWslValidating(true);
		setWslValidation(null);
		try {
			const result = await window.piDesktop.wsl.validateConnection(draftSettings.wslDistro, wslUserInput);
			setWslValidation(result);
			if (result.ok) {
				// 验证通过后，将用户输入写入 draft
				updateDraft({ wslUser: wslUserInput });
			}
		} catch (err) {
			console.error("[Settings] WSL validation failed", err);
			setWslValidation({ ok: false, whoami: "", piVersion: "", error: t("settings.wsl.validationFailed") });
		} finally {
			setWslValidating(false);
		}
	};

	// Git 摘要模型列表与会话 Command 选择器共用 pi --list-models 数据源。
	const [gitModels, setGitModels] = useState<AvailableModel[]>([]);
	const [gitModelPickerOpen, setGitModelPickerOpen] = useState(false);
	useEffect(() => {
		let active = true;
		void desktopApi.projects.listModels()
			.then((models) => {
				if (active) setGitModels(models);
			})
			.catch(() => {
				if (active) setGitModels([]);
			});
		return () => {
			active = false;
		};
	}, []);

	// 宠物包列表
	const [petOptions, setPetOptions] = useState<{ value: string; label: string }[]>([]);
	const [petList, setPetList] = useState<PetManifest[]>([]);
	useEffect(() => {
		window.piDesktop.pet
			.list()
			.then((pets) => { setPetList(pets); setPetOptions(pets.map((p) => ({ value: p.id, label: p.displayName }))); })
			.catch(() => undefined);
	}, []);
	// 进入开发设置 tab 时，若 piStatus 为空则自动检测（避免每次需手动点击「检测环境」）
	useEffect(() => {
		if (activeTab === "dev" && props.piStatus === null && !props.piChecking) {
			props.onCheckPi();
		}
	}, [activeTab, props.piStatus, props.piChecking, props.onCheckPi]);
	const [petPreviewMode, setPetPreviewMode] = useState("__auto");

	const applyWebPortDraft = () => {
		const port = Number(webPortDraft);
		if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== draftSettings.webServicePort) {
			updateDraft({ webServicePort: port });
		} else {
			setWebPortDraft(String(draftSettings.webServicePort));
		}
	};

	const tabs: Array<{
		id: SettingsTabId;
		label: string;
		icon: ReactNode;
	}> = [
		{
			id: "common",
			label: t("settings.tabs.common"),
			icon: <Settings2 size={16} />,
		},
		{
			id: "appearance",
			label: t("settings.tabs.appearance"),
			icon: <Brush size={16} />,
		},
		{
			id: "proxy",
			label: t("settings.tabs.proxy"),
			icon: <Network size={16} />,
		},
		{
			id: "dev",
			label: t("settings.tabs.dev"),
			icon: <Wrench size={16} />,
		},
		{
			id: "pet",
			label: t("settings.tabs.pet"),
			icon: <PawPrint size={16} />,
		},
		{
			id: "storage",
			label: t("settings.tabs.storage"),
			icon: <Trash2 size={16} />,
		},
	];
	const themeOptions = [
		{ value: "system", label: t("settings.themeSystem") },
		{ value: "light", label: t("settings.themeLight") },
		{ value: "dark", label: t("settings.themeDark") },
	];
	// 主题色预设来自 themePresets.ts；新增自定义主题 = 扩展色板后这里自动出现
	const accentOptions = ACCENT_PRESETS.map((preset) => ({
		value: preset.id,
		label: t(preset.labelKey),
	}));
	const startupWindowModeOptions = [
		{ value: "last", label: t("settings.startupWindow.last") },
		{ value: "maximized", label: t("settings.startupWindow.maximized") },
		{ value: "normal-large", label: t("settings.startupWindow.large") },
		{ value: "normal-medium", label: t("settings.startupWindow.medium") },
		{ value: "normal-compact", label: t("settings.startupWindow.compact") },
		{ value: "fullscreen", label: t("settings.startupWindow.fullscreen") },
	];
	const languageOptions = [
		{ value: "system", label: t("settings.languageSystem") },
		{ value: "zh-CN", label: t("settings.languageZh") },
		{ value: "en-US", label: t("settings.languageEn") },
		{ value: "pseudo", label: t("settings.languagePseudo") },
	];
	const sendShortcutOptions = [
		{ value: "enter-send", label: t("settings.sendShortcut.enter") },
		{ value: "ctrl-enter-send", label: t("settings.sendShortcut.ctrl") },
		{ value: "shift-enter-send", label: t("settings.sendShortcut.shift") },
	];
	const linkOpenModeOptions = [
		{ value: "external", label: t("settings.linkOpenMode.external") },
		{ value: "internal", label: t("settings.linkOpenMode.internal") },
	];

	const hasDirtyChanges = dirtyFields.size > 0;
	// 代理 tab 仍展示未保存提示；实际保存/取消统一走全局草稿，避免旧 proxyDirty 局部状态残留。
	const proxyDirty = PROXY_FIELDS.some((field) => dirtyFields.has(field));

		return (
		<Dialog open onOpenChange={(next) => !next && handleClose()}>
			<DialogContent showCloseButton={false} size="xl" className={cn("flex flex-col gap-0 overflow-hidden p-0", "settings-modal")}>
				<DialogHeader className="flex-row items-center justify-between px-4 py-3">
					<DialogTitle>{t("settings.title")}</DialogTitle>
					<div className="flex items-center gap-2">
						{hasDirtyChanges ? (
							<>
								<Button variant="default" size="sm" onClick={saveAll}>
									{t("common.save")}
								</Button>
								{/* 放弃更改用 outline（白底描边）而非灰底 secondary：与黑色主按钮形成
								    清晰的主次层级（shadcn dialog 的 confirm/cancel 惯例），避免一对按钮
								    都是灰色填充分不出哪个是提交。 */}
								<Button variant="outline" size="sm" onClick={cancelAll}>
									{t("common.cancel")}
								</Button>
							</>
						) : undefined}
						<DialogClose asChild>
							<Button variant="ghost" size="icon" aria-label={t("common.close")} title={t("common.close")}>
								<X size={18} strokeWidth={2.2} aria-hidden="true" />
							</Button>
						</DialogClose>
					</div>
				</DialogHeader>
			<div className="settings-layout">
					<nav className="settings-tabs" aria-label={t("settings.title")}>
						{tabs.map((tab) => (
							<button
								key={tab.id}
								className={activeTab === tab.id ? "active" : ""}
								onClick={() => setActiveTab(tab.id)}
							>
								<span className="settings-tab-icon">{tab.icon}</span>
								<strong>{tab.label}</strong>
							</button>
						))}
					</nav>
					<div className="settings-panel">
						{/* ── 常用设置 tab ── */}
						{activeTab === "common" && (
							<>
								<SettingsSection title={t("settings.interface")}>
									<div className="setting-field">
										<span>
											{t("settings.language")}
											<DirtyMarker dirty={isDirty("language")} label={t("settings.language")} />
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.language} onValueChange={(value) =>
												updateDraft({ language: value as AppSettings["language"] })
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{languageOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									</div>
									<div className="setting-field setting-zoom-field">
										<span>
											{t("settings.zoomFactor")}
											<DirtyMarker dirty={isDirty("zoomFactor")} label={t("settings.zoomFactor")} />
										</span>
										<div className="setting-zoom-control">
											<Button variant="ghost" size="icon"
												className="icon-button setting-zoom-button"
												
												disabled={draftSettings.zoomFactor <= ZOOM_FACTOR_MIN}
												onClick={() => changeZoomFactor(-ZOOM_FACTOR_STEP)} aria-label={t("settings.zoomOut")} title={t("settings.zoomOut")}>
												<Minus size={16} strokeWidth={2.2} aria-hidden="true" />
											</Button>
											<output className="setting-zoom-value" aria-live="polite">
												{Math.round(draftSettings.zoomFactor * 100)}%
											</output>
											<Button variant="ghost" size="icon"
												className="icon-button setting-zoom-button"
												
												disabled={draftSettings.zoomFactor >= ZOOM_FACTOR_MAX}
																aria-label={t("settings.zoomIn")} title={t("settings.zoomIn")}
												onClick={() => changeZoomFactor(ZOOM_FACTOR_STEP)}
											>
												<Plus size={16} strokeWidth={2.2} aria-hidden="true" />
											</Button>
										</div>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.typography")}>
									<div className="setting-field">
										<span>
											{t("settings.fontSize")}
											<DirtyMarker dirty={isDirty("fontSize")} label={t("settings.fontSize")} />
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.fontSize} onValueChange={(value) =>
												updateDraft({ fontSize: value as AppSettings["fontSize"] })
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{fontSizeOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									</div>
									<SettingSwitch
										title={t("settings.fontSizePerArea")}
										description={t("settings.fontSizePerAreaDesc")}
										checked={perAreaFontSize}
										onChange={(checked) => {
											setPerAreaFontSize(checked);
											if (!checked) {
												updateDraft({ uiFontSize: null, chatFontSize: null, inputFontSize: null });
											}
										}}
									/>
									{perAreaFontSize && (
										<>
											<div className="setting-field">
												<span>
													{t("settings.uiFontSize")}
													<DirtyMarker dirty={isDirty("uiFontSize")} label={t("settings.uiFontSize")} />
												</span>
												<div className="grid gap-1.5">
	<Select value={draftSettings.uiFontSize ?? draftSettings.fontSize} onValueChange={(value) =>
														updateDraft({ uiFontSize: value as AppSettings["uiFontSize"] })
													}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{fontSizeOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
											</div>
											<div className="setting-field">
												<span>
													{t("settings.chatFontSize")}
													<DirtyMarker dirty={isDirty("chatFontSize")} label={t("settings.chatFontSize")} />
												</span>
												<div className="grid gap-1.5">
	<Select value={draftSettings.chatFontSize ?? draftSettings.fontSize} onValueChange={(value) =>
														updateDraft({ chatFontSize: value as AppSettings["chatFontSize"] })
													}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{fontSizeOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
											</div>
											<div className="setting-field">
												<span>
													{t("settings.inputFontSize")}
													<DirtyMarker dirty={isDirty("inputFontSize")} label={t("settings.inputFontSize")} />
												</span>
												<div className="grid gap-1.5">
	<Select value={draftSettings.inputFontSize ?? draftSettings.fontSize} onValueChange={(value) =>
														updateDraft({ inputFontSize: value as AppSettings["inputFontSize"] })
													}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{fontSizeOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
											</div>
										</>
									)}
									<hr className="setting-divider" />
									<div className="setting-field">
										<span>
											{t("settings.fontFamilyBase")}
											<DirtyMarker dirty={isDirty("fontFamilyBase")} label={t("settings.fontFamilyBase")} />
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.fontFamilyBase} onValueChange={(value) =>
												updateDraft({ fontFamilyBase: value as AppSettings["fontFamilyBase"] })
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{fontBaseOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									</div>
									{draftSettings.fontFamilyBase === "custom" && (
										<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.fontFamilyBaseCustomField")}</span>
	<Input type="text" value={draftSettings.fontFamilyBaseCustom} placeholder={t("settings.fontFamilyBaseCustomPlaceholder")} onChange={(event) => updateDraft({ fontFamilyBaseCustom: event.target.value })
											} />
</Label>
									)}
									<hr className="setting-divider" />
									<div className="setting-field">
										<span>
											{t("settings.fontFamilyMono")}
											<DirtyMarker dirty={isDirty("fontFamilyMono")} label={t("settings.fontFamilyMono")} />
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.fontFamilyMono} onValueChange={(value) =>
												updateDraft({ fontFamilyMono: value as AppSettings["fontFamilyMono"] })
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{fontMonoOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									</div>
									{draftSettings.fontFamilyMono === "custom" && (
										<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.fontFamilyMonoCustomField")}</span>
	<Input type="text" value={draftSettings.fontFamilyMonoCustom} placeholder={t("settings.fontFamilyMonoCustomPlaceholder")} onChange={(event) => updateDraft({ fontFamilyMonoCustom: event.target.value })
											} />
</Label>
									)}
								</SettingsSection>
								<SettingsSection title={t("settings.notificationSection")}>
									<div className="setting-field">
										<span>
											{t("settings.inputShortcut")}
											<DirtyMarker dirty={isDirty("sendShortcut")} label={t("settings.inputShortcut")} />
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.sendShortcut} onValueChange={(value) =>
												updateDraft({ sendShortcut: value as AppSettings["sendShortcut"] })
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{sendShortcutOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									</div>
									<div className="setting-field">
										<span>
											{t("settings.linkOpenMode")}
											<DirtyMarker dirty={isDirty("linkOpenMode")} label={t("settings.linkOpenMode")} />
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.linkOpenMode} onValueChange={(value) =>
												updateDraft({ linkOpenMode: value as AppSettings["linkOpenMode"] })
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{linkOpenModeOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									</div>
									<SettingSwitch
										title={t("settings.closeToTray")}
										checked={draftSettings.closeToTray}
										onChange={(checked) =>
											updateDraft({ closeToTray: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.singleInstance")}
										description={t("settings.singleInstanceDesc")}
										checked={draftSettings.singleInstance}
										onChange={(checked) =>
											updateDraft({ singleInstance: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.enableNotifications")}
										checked={draftSettings.enableNotifications}
										onChange={(checked) =>
											updateDraft({ enableNotifications: checked })
										}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.advanced")}>
									<div className="setting-field">
										<span>
											{t("settings.rpcTimeout")}
											<DirtyMarker dirty={isDirty("rpcTimeout")} label={t("settings.rpcTimeout")} />
										</span>
										<Input
											type="number"
											value={String(Math.round(draftSettings.rpcTimeout / 1000))}
											onChange={(e) => {
												const seconds = Math.max(600, parseInt(e.target.value) || 600);
												updateDraft({ rpcTimeout: seconds * 1000 });
											}}
										/>
										<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)" }}>
											{t("settings.rpcTimeoutDesc")}
										</small>
									</div>
									<div className="setting-field">
										<span>
											{t("settings.maxEditorFileSize")}
											<DirtyMarker dirty={isDirty("maxEditorFileSizeMB")} label={t("settings.maxEditorFileSize")} />
										</span>
										<Input
											type="number"
											value={String(draftSettings.maxEditorFileSizeMB)}
											onChange={(e) => {
												const mb = Math.max(1, parseInt(e.target.value) || 5);
												updateDraft({ maxEditorFileSizeMB: mb });
											}}
										/>
										<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)" }}>
											{t("settings.maxEditorFileSizeDesc")}
										</small>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.git")}>
									<SettingSwitch
										title={t("settings.gitManagement")}
										description={t("settings.gitManagementDesc")}
										checked={draftSettings.enableGitManagement}
										onChange={(checked) =>
											updateDraft({ enableGitManagement: checked })
										}
									/>
									{draftSettings.enableGitManagement && (
										<>
											<div className="setting-field">
												<span>
													{t("settings.gitCommitMessageModel")}
													<DirtyMarker dirty={isDirty("gitCommitMessageProvider") || isDirty("gitCommitMessageModel")} label={t("settings.gitCommitMessageModel")} />
												</span>
												<Button
													variant="outline"
													className="w-full justify-start font-mono text-xs"
													onClick={() => setGitModelPickerOpen(true)}
												>
													{draftSettings.gitCommitMessageProvider && draftSettings.gitCommitMessageModel
														? `${draftSettings.gitCommitMessageProvider}/${draftSettings.gitCommitMessageModel}`
														: t("settings.gitCommitMessageModelUnset")}
												</Button>
												<small>{t("settings.gitCommitMessageModelDesc")}</small>
											</div>
											<SettingTextarea
												title={t("settings.gitCommitMessagePrompt")}
												description={t("settings.gitCommitMessagePromptDesc")}
												value={draftSettings.gitCommitMessagePrompt}
												onChange={(value) => updateDraft({ gitCommitMessagePrompt: value })}
											/>
											{gitModelPickerOpen && (
												<ModelPicker
													models={gitModels}
													current={{
														provider: draftSettings.gitCommitMessageProvider,
														modelId: draftSettings.gitCommitMessageModel,
													}}
													favoriteModels={draftSettings.favoriteModels ?? []}
													onClose={() => setGitModelPickerOpen(false)}
													onPick={(model) => {
														updateDraft({
															gitCommitMessageProvider: model.provider,
															gitCommitMessageModel: model.id,
														});
														setGitModelPickerOpen(false);
													}}
													onToggleFavorite={(provider, modelId) => {
														const key = `${provider}/${modelId}`;
														const favorites = draftSettings.favoriteModels ?? [];
														updateDraft({
															favoriteModels: favorites.includes(key)
																? favorites.filter((item) => item !== key)
																: [...favorites, key],
														});
													}}
												/>
											)}
										</>
									)}
								</SettingsSection>
							</>
						)}
						{/* ── 外观设置 tab ── */}
						{activeTab === "appearance" && (
							<>
								<SettingsSection title={t("settings.interface")}>
									<div className="setting-field">
										<span>
											{t("settings.theme")}
											<DirtyMarker dirty={isDirty("theme")} label={t("settings.theme")} />
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.theme} onValueChange={(value) =>
												updateDraft({ theme: value as AppSettings["theme"] })
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{themeOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									</div>
									<div className="setting-field">
										<span>
											{t("settings.accent")}
											<DirtyMarker dirty={isDirty("accent")} label={t("settings.accent")} />
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.accent} onValueChange={(value) =>
												updateDraft({ accent: value as AppSettings["accent"] })
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{accentOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
										<small className="text-xs text-muted-foreground">{t("settings.accentDesc")}</small>
									</div>
									{/* 背景图片：pideck-bg:// 协议加载 userData/backgrounds/ 下文件 */}
									<div className="setting-field">
										<span>
											{t("settings.backgroundImage")}
											<DirtyMarker dirty={isDirty("backgroundImage") || isDirty("backgroundImageOpacity")} label={t("settings.backgroundImage")} />
										</span>
										<div className="flex items-center gap-2">
											{draftSettings.backgroundImage ? (
												<img
													src={`pideck-bg://local/${encodeURIComponent(draftSettings.backgroundImage)}`}
													alt=""
													className="h-12 w-20 shrink-0 rounded-sm border border-border object-cover"
												/>
											) : (
												<div className="flex h-12 w-20 shrink-0 items-center justify-center rounded-sm border border-dashed border-border text-[11px] text-muted-foreground">—</div>
											)}
											<Button
												variant="outline"
												size="sm"
												onClick={async () => {
													const name = await desktopApi.dialog.pickBackgroundImage();
													if (name) updateDraft({ backgroundImage: name });
												}}
											>
												{t("settings.backgroundImageChoose")}
											</Button>
											{draftSettings.backgroundImage ? (
												<Button
													variant="ghost"
													size="sm"
													onClick={() => {
														const name = draftSettings.backgroundImage;
														updateDraft({ backgroundImage: "" });
														if (name) void desktopApi.dialog.removeBackgroundImage(name);
													}}
												>
													{t("settings.backgroundImageClear")}
												</Button>
											) : null}
										</div>
										<div className="mt-1.5 flex items-center gap-2">
											<span className="w-24 shrink-0 text-xs text-muted-foreground">{t("settings.backgroundImageOpacity")}</span>
											<input
												type="range"
												min={0}
												max={100}
												// 滑块与存储同语义=图片可见度（100%=图全显，0%=全遮罩），不再反转
												value={Math.round((draftSettings.backgroundImageOpacity ?? 0.8) * 100)}
												onChange={(event) =>
													updateDraft({ backgroundImageOpacity: Number(event.target.value) / 100 })
												}
												className="m-0 h-4 flex-1 accent-[var(--color-accent)]"
												aria-label={t("settings.backgroundImageOpacity")}
											/>
											<span className="w-10 text-right font-mono text-xs tabular-nums text-muted-foreground">{Math.round((draftSettings.backgroundImageOpacity ?? 0.8) * 100)}%</span>
										</div>
										<small className="text-xs text-muted-foreground">{t("settings.backgroundImageDesc")}</small>
									</div>
									<div className="setting-field">
										<span>
											{t("settings.startupWindowMode")}
											<DirtyMarker
												dirty={isDirty("startupWindowMode")}
												label={t("settings.startupWindowMode")}
											/>
										</span>
										<div className="grid gap-1.5">
	<Select value={draftSettings.startupWindowMode} onValueChange={(value) =>
												updateDraft({
													startupWindowMode: value as AppSettings["startupWindowMode"],
												})
											}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{startupWindowModeOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
										<small style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)" }}>
											{t("settings.startupWindowModeDesc")}
										</small>
									</div>
									<SettingSwitch
										title={t("settings.nativeTitleBar")}
										checked={draftSettings.useNativeTitleBar}
										onChange={(checked) =>
											updateDraft({ useNativeTitleBar: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.nativeMenu")}
										checked={draftSettings.showNativeMenu}
										onChange={(checked) =>
											updateDraft({ showNativeMenu: checked })
										}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.contentMaxWidth")} description={t("settings.contentMaxWidthDesc")}>
									<div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", maxWidth: 480 }}>
										<input
											type="range"
											min="800"
											max="1800"
											step="25"
											value={draftSettings.contentMaxWidth}
											onChange={(event) => updateDraft({ contentMaxWidth: parseInt(event.target.value) })}
											style={{ flex: 1, accentColor: "var(--color-accent)", direction: "rtl" }}
										/>
										<span style={{
											fontFamily: "var(--font-family-business)",
											fontSize: "var(--font-size-sm)",
											color: "var(--color-text-muted)",
											minWidth: 80,
											textAlign: "right",
										}}>
											{draftSettings.contentMaxWidth === 1800
												? t("settings.contentMaxWidthUnlimited")
												: `${draftSettings.contentMaxWidth}px`}
										</span>
									</div>
								</SettingsSection>
							</>
						)}
						{/* ── 代理设置 tab ── */}
						{activeTab === "proxy" && (
							<>
								{/* 未保存更改的提示横幅 */}
								{proxyDirty && (
									<div className="setting-proxy-unsaved-bar">
										<span className="setting-proxy-unsaved-dot" />
										<span>{t("settings.proxyUnsaved")}</span>
										<small>{t("settings.proxyApplyHint")}</small>
									</div>
								)}
								<SettingsSection
									title={t("settings.piProxy")}
									description={t("settings.piProxyDesc")}
								>
									<SettingSwitch
										title={t("settings.enablePiProxy")}
										description={t("settings.settingTakesEffectAfterRestart")}
										checked={draftSettings.piProxyEnabled}
										onChange={(checked) =>
											updateDraft({ piProxyEnabled: checked })
										}
									/>
									{draftSettings.piProxyEnabled && (
										<div className="setting-proxy-panel">
											<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.proxyUrl")}</span>
	<Input type="text" value={draftSettings.piProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ piProxyUrl: event.target.value })
												} />
</Label>
											<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.proxyBypass")}</span>
	<Input type="text" value={draftSettings.piProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ piProxyBypass: event.target.value })
												} />
	<small className="text-xs text-muted-foreground">{t("settings.noProxyHint")}</small>
</Label>
											<div className="setting-row">
												<div>
													<strong>{t("settings.proxyTest")}</strong>
													<small>{t("settings.proxyNoApiKey")}</small>
													{props.piProxyNotice && (
														<small className={`setting-status ${props.piProxyNoticeTone}`}>
															{props.piProxyNotice}
														</small>
													)}
												</div>
												<Button variant="secondary"
													onClick={props.onTestPiProxy}
													disabled={props.piProxyChecking}
												>
													{props.piProxyChecking
														? t("settings.testingProxy")
														: t("settings.testProxy")}
												</Button>
											</div>
										</div>
									)}
								</SettingsSection>
								<SettingsSection
									title={t("settings.desktopProxy")}
									description={t("settings.desktopProxyDesc")}
								>
									<SettingSwitch
										title={t("settings.enableDesktopProxy")}
										description={t("settings.desktopProxyDesc")}
										checked={draftSettings.desktopProxyEnabled}
										onChange={(checked) =>
											updateDraft({ desktopProxyEnabled: checked })
										}
									/>
									{draftSettings.desktopProxyEnabled && (
										<div className="setting-proxy-panel">
											<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.proxyUrl")}</span>
	<Input type="text" value={draftSettings.desktopProxyUrl} placeholder={"http://127.0.0.1:7890"} onChange={(event) => updateDraft({ desktopProxyUrl: event.target.value })
												} />
</Label>
											<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.proxyBypass")}</span>
	<Input type="text" value={draftSettings.desktopProxyBypass} placeholder={"localhost,127.0.0.1,::1"} onChange={(event) => updateDraft({ desktopProxyBypass: event.target.value })
												} />
	<small className="text-xs text-muted-foreground">{t("settings.electronProxyHint")}</small>
</Label>
										</div>
									)}
								</SettingsSection>
								{/* 代理变更走全局草稿：顶部统一保存/取消，不再在 tab 底部重复放按钮 */}
							</>
						)}
						{/* ── 开发设置 tab（含 Web 服务） ── */}
						{activeTab === "dev" && (
							<>
								<SettingsSection title={t("settings.environment")}>
									{/* Pi CLI 状态：安装检测 + 路径信息 + 重新检测 */}
									<div className="setting-pi-status">
										<div className="setting-pi-status-indicator">
											<span
												className={"pi-status-dot " + (props.piStatus?.installed ? "online" : "offline")}
											/>
											<div className="setting-pi-status-text">
												<strong>Pi CLI</strong>
												<span>
													{props.piStatus
														? props.piStatus.installed
															? t("settings.foundPi", {
																	version: props.piStatus.version ?? "pi",
																})
															: t("settings.piMissing")
														: t("settings.piCliAvailable")}
												</span>
												{piPath && (
													<span className="setting-path">
														{piPath}
													</span>
												)}
												{props.piStatus && !props.piStatus.installed && props.piStatus.error && (
													<span className="setting-status error">
														{props.piStatus.error}
													</span>
												)}
											</div>
										</div>
										<div className="setting-inline-actions">
											<Button variant="secondary" onClick={props.onCheckPi} disabled={props.piChecking}>
												{props.piChecking
													? t("settings.detecting")
													: t("settings.detectEnvironment")}
											</Button>
											{props.onClearCheckFlag && (
												<Button variant="secondary"
													className="setting-btn-secondary"
													onClick={props.onClearCheckFlag}
												>
													{t("environment.clearCheckFlag")}
												</Button>
											)}
											<Button variant="secondary"
												onClick={props.onCheckPiUpdate}
												loading={props.piUpdateChecking}
												disabled={draftSettings.disableUpdateCheck}
											>
												{t("settings.checkPiUpdate")}
											</Button>
											<Button variant="secondary"
												onClick={props.onUpdatePi}
												loading={props.piUpdating}
												disabled={
													draftSettings.disableUpdateCheck ||
													!props.piUpdateCheck?.hasUpdate
												}
											>
												{t("settings.updatePi")}
											</Button>
										</div>
									</div>
									{props.piUpdateResult && (
										<pre className="setting-update-output">
											{props.piUpdateResult.command}
											{"\n"}
											{props.piUpdateResult.output}
										</pre>
									)}

									<hr className="setting-divider" />

									{/* Pi 来源：Windows 原生 / WSL（仅 Windows 可见） */}
									{props.appInfo.platform === "win32" && (
									<div className="setting-pi-source-block">
										<div className="setting-pi-source-row">
											<span>{t("settings.piSource.label")}</span>
											<div className="grid gap-1.5">
	<Select value={draftSettings.wslEnabled ? "wsl" : "windows"} onValueChange={(value) => {
													updateDraft({ wslEnabled: value === "wsl" });
													setWslValidation(null);
												}}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{[
													{ value: "windows", label: t("settings.piSource.windows") },
													{ value: "wsl", label: t("settings.piSource.wsl") },
												].map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
										</div>
										{draftSettings.wslEnabled && (
											<div className="setting-pi-wsl-config">
												<div className="setting-wsl-fields">
													{wslDistros.length > 0 ? (
														<div className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.wsl.distro")}</span>
	<Select value={draftSettings.wslDistro} onValueChange={(value) => {
																updateDraft({ wslDistro: value });
																setWslValidation(null);
															}}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{distroOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
													) : (
														<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.wsl.distro")}</span>
	<Input type="text" value={draftSettings.wslDistro} placeholder={"Ubuntu"} onChange={(event) => {
																updateDraft({ wslDistro: event.target.value });
																setWslValidation(null);
															}} />
</Label>
													)}
													{wslDistrosLoading && (
														<small className="setting-status info">{t("settings.wsl.detectingDistros")}</small>
													)}
													<div className="setting-wsl-user-row">
														<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.wsl.user")}</span>
	<Input type="text" value={wslUserInput} placeholder={"root"} onChange={(event) => {
																setWslUserInput(event.target.value);
																setWslValidation(null);
															}} />
</Label>
														<Button variant="secondary"
															size="sm"
															disabled={!wslUserInput.trim() || wslValidating}
															loading={wslValidating}
															onClick={handleValidateWslUser}
														>
															{t("settings.wsl.validateUser")}
														</Button>
													</div>
												</div>
												{wslValidation && (
													<div className={`setting-wsl-validation ${wslValidation.ok ? "success" : "error"}`}>
														{wslValidation.ok ? (
															<>
																<small className="setting-status success">
																	{t("settings.wsl.validationOk", {
																		user: wslValidation.whoami,
																		distro: draftSettings.wslDistro,
																	})}
																</small>
																{wslValidation.piVersion ? (
																	<small className="setting-status success">
																		{t("settings.wsl.piDetected", { version: wslValidation.piVersion })}
																	</small>
																) : (
																	<small className="setting-status warning">
																		{wslValidation.error || t("settings.wsl.piNotInstalled")}
																	</small>
																)}
															</>
														) : (
															<small className="setting-status error">{wslValidation.error}</small>
														)}
													</div>
												)}
											</div>
										)}
									</div>
									)}

									<hr className="setting-divider" />

									{/* 自定义 Pi 路径 */}
									<div className="setting-pi-path-panel">
										<Label className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.customPiPath")}</span>
	<Input type="text" value={props.customPiPath} placeholder={
												piPath ||
												"D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"
											} disabled={props.customPathValidating} onChange={(event) => props.onCustomPathChange(event.target.value)} />
	<small className="text-xs text-muted-foreground">{t("settings.customPiPathHint")}</small>
</Label>
										<div className="setting-pi-path-actions">
											<Button variant="secondary"
												onClick={props.onValidateCustomPath}
												disabled={!props.customPiPath.trim() || props.customPathValidating}
											>
												{props.customPathValidating
													? t("settings.validating")
													: t("settings.validatePiPath")}
											</Button>
											<Button variant="secondary"
												onClick={props.onClearCustomPath}
												disabled={!props.settings.customPiPath || props.customPathValidating}
											>
												{t("settings.clearCustomPiPath")}
											</Button>
										</div>
										{props.customPathResult && (
											<small className={`setting-status ${props.customPathResult.installed ? "success" : "error"}`}>
												{props.customPathResult.installed
													? t("settings.validatePassed", {
															value:
																props.customPathResult.command ??
																props.customPathResult.version ??
																"pi",
														})
													: t("settings.validateFailed", {
															error:
																props.customPathResult.error ??
																t("environment.unableToRun"),
														})}
											</small>
										)}
									</div>

									<hr className="setting-divider" />

									{/* 版本与更新 */}
									<div className="setting-row">
										<div>
											<strong>PiDeck</strong>
											<span style={{ color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)" }}>
												v{props.appInfo.version}
											</span>
										</div>
										<div className="setting-inline-actions">
											<Button variant="secondary"
												onClick={draftSettings.disableUpdateCheck ? undefined : props.onCheckUpdate}
												loading={props.updateChecking}
												disabled={draftSettings.disableUpdateCheck}
											>
												{draftSettings.disableUpdateCheck
													? t("settings.updateCheckDisabled")
													: t("settings.checkUpdate")}
											</Button>
										</div>
									</div>
									<hr className="setting-divider" />

									{/* 禁用版本检测 */}
									<SettingSwitch
										title={t("settings.disableUpdateCheck")}
										description={t("settings.disableUpdateCheckDesc")}
										checked={draftSettings.disableUpdateCheck}
										onChange={(checked) =>
											updateDraft({ disableUpdateCheck: checked })
										}
									/>
																	<SettingSwitch
										title={t("settings.electronSandbox")}
										description={t("settings.electronSandboxDesc")}
										checked={draftSettings.electronChromiumSandbox}
										onChange={(checked) =>
											updateDraft({ electronChromiumSandbox: checked })
										}
									/>
									<div className="setting-row setting-row--section-label">
										<div>
											<strong>{t("settings.piRpcStartup")}</strong>
											<small>{t("settings.piRpcStartupDesc")}</small>
										</div>
									</div>
									<SettingSwitch
										title={t("settings.piRpcOffline")}
										description={t("settings.piRpcOfflineDesc")}
										checked={draftSettings.piRpcOffline}
										onChange={(checked) => updateDraft({ piRpcOffline: checked })}
									/>
									<SettingSwitch
										title={t("settings.piRpcNoExtensions")}
										description={t("settings.piRpcNoExtensionsDesc")}
										checked={draftSettings.piRpcNoExtensions}
										onChange={(checked) => updateDraft({ piRpcNoExtensions: checked })}
									/>
									<SettingSwitch
										title={t("settings.piRpcNoSkills")}
										description={t("settings.piRpcNoSkillsDesc")}
										checked={draftSettings.piRpcNoSkills}
										onChange={(checked) => updateDraft({ piRpcNoSkills: checked })}
									/>
									<SettingSwitch
										title={t("settings.useWebContentsViewBrowser")}
										description={t("settings.useWebContentsViewBrowserDesc")}
										checked={Boolean(draftSettings.useWebContentsViewBrowser)}
										onChange={(checked) => updateDraft({ useWebContentsViewBrowser: checked })}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.debug")}>
									<div className="setting-row">
										<div>
											<strong>{t("settings.restartApp")}</strong>
											<small>{t("settings.restartAppDesc")}</small>
										</div>
										<Button variant="secondary" onClick={props.onRestartApp}>
											{t("settings.restartAppButton")}
										</Button>
									</div>
									<div className="setting-row">
										<div>
											<strong>{t("settings.devTools")}</strong>
											<small>{t("settings.devToolsDesc")}</small>
										</div>
										<Button variant="secondary" onClick={props.onToggleDevTools}>
											{t("settings.toggle")}
										</Button>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.webLocalService")} description={t("settings.webLocalServiceDesc")}>
									<SettingSwitch
										title={t("settings.enableWebService")}
										description={
											props.webServiceChanging
												? t("settings.webOpening")
												: t("settings.webOffDesc")
										}
										checked={draftSettings.webServiceEnabled}
										disabled={props.webServiceChanging}
										onChange={(checked) =>
											updateDraft({ webServiceEnabled: checked })
										}
									/>
									<div className="web-endpoint-panel">
										<div className="web-endpoint-grid">
											<div className="web-endpoint-metric">
												<span>{t("common.host")}</span>
												<code>{draftSettings.webServiceHost}</code>
											</div>
											<Label className="web-endpoint-metric editable">
												<span>{t("common.port")}</span>
												<Input
													type="number"
													min={1}
													max={65535}
													value={webPortDraft}
													disabled={props.webServiceChanging}
													onChange={(event) => setWebPortDraft(event.target.value)}
													onBlur={applyWebPortDraft}
													onKeyDown={(event) => {
														if (event.key === "Enter") {
															event.preventDefault();
															applyWebPortDraft();
															event.currentTarget.blur();
														}
													}}
												/>
											</Label>
										</div>
										<div className="web-endpoint-summary">
											<span className={draftSettings.webServiceEnabled ? "online" : ""} />
											<div>
												<strong>
													http://127.0.0.1:{webPortDraft || draftSettings.webServicePort}
												</strong>
												<small>{t("settings.localWebHint")}</small>
											</div>
											<Button variant="secondary"
												size="sm"
												disabled={!draftSettings.webServiceEnabled}
												onClick={() =>
													props.onOpenWebService(webPortDraft || String(draftSettings.webServicePort))
												}
											>
												{t("common.open")}
											</Button>
										</div>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.privacy")}>
									<SettingSwitch
										title={t("settings.telemetry")}
										description={t("settings.telemetryDesc")}
										checked={draftSettings.telemetryEnabled}
										onChange={(checked) =>
											updateDraft({ telemetryEnabled: checked })
										}
									/>
								</SettingsSection>
							</>
						)}
						{/* ── 桌面宠物 tab ── */}
						{activeTab === "pet" && (
							<>
								<SettingsSection title={t("settings.pet.title")} description={t("settings.pet.sectionDesc")}>
									<SettingSwitch
										title={t("settings.pet.enable")}
										description={t("settings.pet.enableDesc")}
										checked={draftSettings.petEnabled}
										onChange={(value) => updateDraft({ petEnabled: value })}
									/>
									<SettingSwitch
										title={t("settings.pet.alwaysOnTop")}
										description={t("settings.pet.alwaysOnTopDesc")}
										checked={draftSettings.petAlwaysOnTop}
										onChange={(value) => updateDraft({ petAlwaysOnTop: value })}
									/>
									<SettingSwitch
										title={t("settings.pet.patrol")}
										description={t("settings.pet.patrolDesc")}
										checked={draftSettings.petPatrolEnabled ?? true}
										onChange={(value) => updateDraft({ petPatrolEnabled: value })}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.pet.patrolPause")} description={t("settings.pet.patrolPauseDesc")}>
									<div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", maxWidth: 320 }}>
										<input
											type="range"
											min="1"
											max="30"
											step="1"
											value={draftSettings.petPatrolPauseMin ?? 5}
											onChange={(event) => updateDraft({ petPatrolPauseMin: parseInt(event.target.value) })}
											style={{ flex: 1, accentColor: "var(--color-accent)", direction: "rtl" }}
										/>
										<span style={{
											fontFamily: "var(--font-family-business)",
											fontSize: "var(--font-size-sm)",
											color: "var(--color-text-muted)",
											minWidth: 60,
											textAlign: "right",
										}}>
											{draftSettings.petPatrolPauseMin ?? 5} min
										</span>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.pet.choose")}>
									<div className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.pet.choose")}</span>
	<Select value={draftSettings.petId} onValueChange={(value) => {
											setPetPreviewMode("__auto");
											updateDraft({ petId: value });
										}}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{petOptions.map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									<small className="setting-status">{t("settings.pet.petdexHint")}</small>
									{(() => {
										const selected = petList.find((pet) => pet.id === draftSettings.petId);
										return (
											<>
												{selected && (
													<div className="pet-chooser-preview-row" style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", marginTop: 8 }}>
														<PetChooserPreview pet={selected} mode={petPreviewMode} />
														<div style={{ minWidth: 0, flex: 1 }}>
															<strong style={{ display: "block", fontSize: "var(--font-size-control)", color: "var(--color-text-primary)" }}>{selected.displayName}</strong>
															{selected.description && (
																<small className="setting-status" style={{ display: "block", marginTop: 2 }}>{selected.description}</small>
															)}
														</div>
													</div>
												)}
											</>
										);
									})()}
								</SettingsSection>
								<SettingsSection title={t("settings.pet.scale")} description={t("settings.pet.scaleDesc")}>
									<div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", maxWidth: 320 }}>
										<input
											type="range"
											min="0.3"
											max="2.0"
											step="0.05"
											value={draftSettings.petScale ?? 1}
											onChange={(event) => updateDraft({ petScale: parseFloat(event.target.value) })}
											style={{ flex: 1, accentColor: "var(--color-accent)", direction: "rtl" }}
										/>
										<span style={{
											fontFamily: "var(--font-family-business)",
											fontSize: "var(--font-size-sm)",
											color: "var(--color-text-muted)",
											minWidth: 36,
											textAlign: "right",
										}}>
											{((draftSettings.petScale ?? 1) * 100).toFixed(0)}%
										</span>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.pet.preview")} description={t("settings.pet.previewDesc")}>
									<div className="grid gap-1.5 setting-field">
	<span className="text-sm font-medium leading-none text-foreground">{t("settings.pet.previewMode")}</span>
	<Select value={petPreviewMode} onValueChange={(value) => {
											setPetPreviewMode(value);
											void window.piDesktop.pet.setPreviewMode(value === "__auto" ? "" : value);
										}}>
		<SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
		<SelectContent>
			{[
											{ value: "__auto", label: t("settings.pet.previewAuto") },
											{ value: "idle", label: "idle (row 0)" },
											{ value: "running", label: "running (row 7)" },
											{ value: "failed", label: "failed (row 5)" },
											{ value: "waiting", label: "waiting (row 6)" },
											{ value: "waving", label: "waving (row 3)" },
											{ value: "running-right", label: "running-right (row 1)" },
											{ value: "running-left", label: "running-left (row 2)" },
											{ value: "jumping", label: "jumping (row 4)" },
											{ value: "review", label: "review (row 8)" },
										].map((option) => (
				<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
					{option.label}
				</SelectItem>
			))}
		</SelectContent>
	</Select>
</div>
									<div className="setting-inline-actions pet-test-actions">
										<Button
											size="sm"
											variant="destructive"
											onClick={() => void window.piDesktop.pet.testNotify("error")}
										>
											{t("settings.pet.testError")}
										</Button>
										<Button variant="secondary"
											size="sm"
											onClick={() => void window.piDesktop.pet.testNotify("done")}
										>
											{t("settings.pet.testDone")}
										</Button>
									</div>
								</SettingsSection>
							</>
						)}
						{/* ── 存储与日志 tab ── */}
						{activeTab === "storage" && (
							<StorageTab
								settings={draftSettings}
								onChange={updateDraft}
							/>
						)}
					</div>
				</div>
			{/* 未保存变更确认对话框 */}
			{closeConfirmOpen && (
				<AlertDialog open onOpenChange={(open) => { if (!open) setCloseConfirmOpen(false); }}>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{t("settings.unsavedTitle")}</AlertDialogTitle>
							<AlertDialogDescription>{t("settings.unsavedMessage")}</AlertDialogDescription>
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
			</DialogContent>
		</Dialog>
	);
}

function PetChooserPreview(props: {
	pet?: PetManifest;
	mode?: string;
}) {
	const canvasRef = useRef<HTMLCanvasElement | null>(null);
	const imgRef = useRef<HTMLImageElement | null>(null);
	const rafRef = useRef<number | null>(null);

	useEffect(() => {
		const canvas = canvasRef.current;
		const pet = props.pet;
		if (!pet || !pet.spritesheetUrl || !canvas) {
			const ctx = canvas?.getContext("2d");
			if (canvas) ctx?.clearRect(0, 0, canvas.width, canvas.height);
			return;
		}

		const mode = props.mode && props.mode !== "__auto" ? props.mode : "idle";
		const row = MODE_ROW[mode] ?? 0;
		const frameCount = MODE_FRAMES[mode] ?? 6;
		const img = new Image();
		img.src = pet.spritesheetUrl;
		let disposed = false;

		const start = () => {
			if (disposed) return;
			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			const startedAt = performance.now();
			const draw = (now: number) => {
				if (disposed) return;
				const frame = Math.floor((now - startedAt) / 140) % frameCount;
				ctx.clearRect(0, 0, CELL_W, CELL_H);
				ctx.drawImage(
					img,
					(frame % GRID_COLS) * CELL_W,
					row * CELL_H,
					CELL_W,
					CELL_H,
					0,
					0,
					CELL_W,
					CELL_H,
				);
				rafRef.current = requestAnimationFrame(draw);
			};
			rafRef.current = requestAnimationFrame(draw);
		};

		img.onload = start;
		imgRef.current = img;
		return () => {
			disposed = true;
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
			imgRef.current = null;
		};
	}, [props.pet, props.mode]);

	return (
		<div className="pet-chooser-preview">
			<canvas ref={canvasRef} width={CELL_W} height={CELL_H} aria-hidden="true" />
		</div>
	);
}
