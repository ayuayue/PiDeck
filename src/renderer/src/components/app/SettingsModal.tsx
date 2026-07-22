// @ts-nocheck - extracted from AppParts, pre-existing type issues
import { useState, useEffect, useRef, useMemo, type ReactNode } from "react";
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
import { Button } from "../ui/Button";
import { CloseIconButton, IconButton } from "../ui/IconButton";
import { SelectField } from "../ui/SelectField";
import { TextField } from "../ui/TextField";
import type { AppSettings, AppInfo, PiInstallStatus, PiUpdateCheckResult, PiCliUpdateResult, PetManifest } from "../../../shared/types";
import { GRID_COLS, CELL_W, CELL_H, MODE_ROW, MODE_FRAMES } from "../../pet/PetSpriteSheet";

const ZOOM_FACTOR_MIN = 0.8;
const ZOOM_FACTOR_MAX = 1.5;
const ZOOM_FACTOR_STEP = 0.05;

type SettingsTabId = "common" | "appearance" | "proxy" | "dev" | "pet" | "storage";

function SettingsSection(props: {
	title: string;
	description?: string;
	children: ReactNode;
}) {
	return (
		<section className="settings-section">
			<div className="settings-section-header">
				<strong>{props.title}</strong>
				{props.description && <small>{props.description}</small>}
			</div>
			<div className="settings-section-body">{props.children}</div>
		</section>
	);
}

function SettingSwitch(props: {
	title: string;
	description?: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<label className="setting-switch-row">
			<span>
				<strong>{props.title}</strong>
				{props.description && <small>{props.description}</small>}
			</span>
			<input
				type="checkbox"
				checked={props.checked}
				disabled={props.disabled}
				onChange={(event) => props.onChange(event.target.checked)}
			/>
		</label>
	);
}

/** 已修改但未保存的字段标记：在标签右侧显示一个黄色圆点 */
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

export function SettingsModal(props: {
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
}) {
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
			setWslValidation({ ok: false, whoami: "", piVersion: "", error: "WSL API 未就绪，请重启应用后再试" });
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
			setWslValidation({ ok: false, whoami: "", piVersion: "", error: String(err) });
		} finally {
			setWslValidating(false);
		}
	};

	// 宠物包列表
	const [petOptions, setPetOptions] = useState<{ value: string; label: string }[]>([]);
	const [petList, setPetList] = useState<PetManifest[]>([]);
	useEffect(() => {
		window.piDesktop.pet
			.list()
			.then((pets) => { setPetList(pets); setPetOptions(pets.map((p) => ({ value: p.id, label: p.displayName }))); })
			.catch(() => undefined);
	}, []);
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
	const lightBackgroundOptions = [
		{ value: "white", label: t("settings.lightBackgroundWhite") },
		{ value: "warm", label: t("settings.lightBackgroundWarm") },
		{ value: "paper", label: t("settings.lightBackgroundPaper") },
		{ value: "blue", label: t("settings.lightBackgroundBlue") },
		{ value: "green", label: t("settings.lightBackgroundGreen") },
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
	const lightBackgroundDisabled = draftSettings.theme === "dark";

	const hasDirtyChanges = dirtyFields.size > 0;

	return (
		<div className="modal-backdrop" onClick={handleClose}>
			<div
				className="settings-modal"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="modal-header">
					<strong>{t("settings.title")}</strong>
					<div className="modal-header-actions" style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
						{/* 全局保存/取消按钮：仅在存在未保存变更时显示，样式与配置弹框的导入/导出按钮一致 */}
						{hasDirtyChanges && (
							<>
								<button className="config-btn primary" onClick={saveAll}>
									{t("common.save")}
								</button>
								<button className="config-btn" onClick={cancelAll}>
									{t("common.cancel")}
								</button>
							</>
						)}
						<CloseIconButton
							label={t("common.close")}
							onClick={handleClose}
						/>
					</div>
				</div>
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
											{t("settings.theme")}
											<DirtyMarker dirty={isDirty("theme")} label={t("settings.theme")} />
										</span>
										<SelectField
											value={draftSettings.theme}
											options={themeOptions}
											onChange={(value) =>
												updateDraft({ theme: value as AppSettings["theme"] })
											}
										/>
									</div>
									<div className="setting-field">
										<span>
											{t("settings.language")}
											<DirtyMarker dirty={isDirty("language")} label={t("settings.language")} />
										</span>
										<SelectField
											value={draftSettings.language}
											options={languageOptions}
											onChange={(value) =>
												updateDraft({ language: value as AppSettings["language"] })
											}
										/>
									</div>
									<div className="setting-field setting-zoom-field">
										<span>
											{t("settings.zoomFactor")}
											<DirtyMarker dirty={isDirty("zoomFactor")} label={t("settings.zoomFactor")} />
										</span>
										<div className="setting-zoom-control">
											<IconButton
												className="icon-button setting-zoom-button"
												label={t("settings.zoomOut")}
												disabled={draftSettings.zoomFactor <= ZOOM_FACTOR_MIN}
												onClick={() => changeZoomFactor(-ZOOM_FACTOR_STEP)}
											>
												<Minus size={16} strokeWidth={2.2} aria-hidden="true" />
											</IconButton>
											<output className="setting-zoom-value" aria-live="polite">
												{Math.round(draftSettings.zoomFactor * 100)}%
											</output>
											<IconButton
												className="icon-button setting-zoom-button"
												label={t("settings.zoomIn")}
												disabled={draftSettings.zoomFactor >= ZOOM_FACTOR_MAX}
												onClick={() => changeZoomFactor(ZOOM_FACTOR_STEP)}
											>
												<Plus size={16} strokeWidth={2.2} aria-hidden="true" />
											</IconButton>
										</div>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.typography")}>
									<div className="setting-field">
										<span>
											{t("settings.fontSize")}
											<DirtyMarker dirty={isDirty("fontSize")} label={t("settings.fontSize")} />
										</span>
										<SelectField
											value={draftSettings.fontSize}
											options={fontSizeOptions}
											onChange={(value) =>
												updateDraft({ fontSize: value as AppSettings["fontSize"] })
											}
										/>
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
												<SelectField
													value={draftSettings.uiFontSize ?? draftSettings.fontSize}
													options={fontSizeOptions}
													onChange={(value) =>
														updateDraft({ uiFontSize: value as AppSettings["uiFontSize"] })
													}
												/>
											</div>
											<div className="setting-field">
												<span>
													{t("settings.chatFontSize")}
													<DirtyMarker dirty={isDirty("chatFontSize")} label={t("settings.chatFontSize")} />
												</span>
												<SelectField
													value={draftSettings.chatFontSize ?? draftSettings.fontSize}
													options={fontSizeOptions}
													onChange={(value) =>
														updateDraft({ chatFontSize: value as AppSettings["chatFontSize"] })
													}
												/>
											</div>
											<div className="setting-field">
												<span>
													{t("settings.inputFontSize")}
													<DirtyMarker dirty={isDirty("inputFontSize")} label={t("settings.inputFontSize")} />
												</span>
												<SelectField
													value={draftSettings.inputFontSize ?? draftSettings.fontSize}
													options={fontSizeOptions}
													onChange={(value) =>
														updateDraft({ inputFontSize: value as AppSettings["inputFontSize"] })
													}
												/>
											</div>
										</>
									)}
									<hr className="setting-divider" />
									<div className="setting-field">
										<span>
											{t("settings.fontFamilyBase")}
											<DirtyMarker dirty={isDirty("fontFamilyBase")} label={t("settings.fontFamilyBase")} />
										</span>
										<SelectField
											value={draftSettings.fontFamilyBase}
											options={fontBaseOptions}
											onChange={(value) =>
												updateDraft({ fontFamilyBase: value as AppSettings["fontFamilyBase"] })
											}
										/>
									</div>
									{draftSettings.fontFamilyBase === "custom" && (
										<TextField
											className="setting-field"
											label={t("settings.fontFamilyBaseCustomField")}
											value={draftSettings.fontFamilyBaseCustom}
											placeholder={t("settings.fontFamilyBaseCustomPlaceholder")}
											onChange={(value) =>
												updateDraft({ fontFamilyBaseCustom: value })
											}
										/>
									)}
									<hr className="setting-divider" />
									<div className="setting-field">
										<span>
											{t("settings.fontFamilyMono")}
											<DirtyMarker dirty={isDirty("fontFamilyMono")} label={t("settings.fontFamilyMono")} />
										</span>
										<SelectField
											value={draftSettings.fontFamilyMono}
											options={fontMonoOptions}
											onChange={(value) =>
												updateDraft({ fontFamilyMono: value as AppSettings["fontFamilyMono"] })
											}
										/>
									</div>
									{draftSettings.fontFamilyMono === "custom" && (
										<TextField
											className="setting-field"
											label={t("settings.fontFamilyMonoCustomField")}
											value={draftSettings.fontFamilyMonoCustom}
											placeholder={t("settings.fontFamilyMonoCustomPlaceholder")}
											onChange={(value) =>
												updateDraft({ fontFamilyMonoCustom: value })
											}
										/>
									)}
								</SettingsSection>
								<SettingsSection title={t("settings.notificationSection")}>
									<div className="setting-field">
										<span>
											{t("settings.inputShortcut")}
											<DirtyMarker dirty={isDirty("sendShortcut")} label={t("settings.inputShortcut")} />
										</span>
										<SelectField
											value={draftSettings.sendShortcut}
											options={sendShortcutOptions}
											onChange={(value) =>
												updateDraft({ sendShortcut: value as AppSettings["sendShortcut"] })
											}
										/>
									</div>
									<div className="setting-field">
										<span>
											{t("settings.linkOpenMode")}
											<DirtyMarker dirty={isDirty("linkOpenMode")} label={t("settings.linkOpenMode")} />
										</span>
										<SelectField
											value={draftSettings.linkOpenMode}
											options={linkOpenModeOptions}
											onChange={(value) =>
												updateDraft({ linkOpenMode: value as AppSettings["linkOpenMode"] })
											}
										/>
									</div>
									<SettingSwitch
										title={t("settings.closeToTray")}
										checked={draftSettings.closeToTray}
										onChange={(checked) =>
											updateDraft({ closeToTray: checked })
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
							</>
						)}
						{/* ── 外观设置 tab ── */}
						{activeTab === "appearance" && (
							<>
								<SettingsSection title={t("settings.interface")}>
									<div className="setting-field">
										<span>
											{t("settings.lightBackground")}
											<DirtyMarker dirty={isDirty("lightBackground")} label={t("settings.lightBackground")} />
										</span>
										<SelectField
											disabled={lightBackgroundDisabled}
											value={draftSettings.lightBackground}
											options={lightBackgroundOptions}
											onChange={(value) =>
												updateDraft({ lightBackground: value as AppSettings["lightBackground"] })
											}
										/>
									</div>
									<SettingSwitch
										title={t("settings.gitManagement")}
										description={t("settings.gitManagementDesc")}
										checked={draftSettings.enableGitManagement}
										onChange={(checked) =>
											updateDraft({ enableGitManagement: checked })
										}
									/>
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
											max="1400"
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
											{draftSettings.contentMaxWidth === 1400
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
											<TextField
												className="setting-field"
												label={t("settings.proxyUrl")}
												value={draftSettings.piProxyUrl}
												placeholder="http://127.0.0.1:7890"
												onChange={(value) =>
													updateDraft({ piProxyUrl: value })
												}
											/>
											<TextField
												className="setting-field"
												label={t("settings.proxyBypass")}
												value={draftSettings.piProxyBypass}
												placeholder="localhost,127.0.0.1,::1"
												description={t("settings.noProxyHint")}
												onChange={(value) =>
													updateDraft({ piProxyBypass: value })
												}
											/>
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
												<Button
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
											<TextField
												className="setting-field"
												label={t("settings.proxyUrl")}
												value={draftSettings.desktopProxyUrl}
												placeholder="http://127.0.0.1:7890"
												onChange={(value) =>
													updateDraft({ desktopProxyUrl: value })
												}
											/>
											<TextField
												className="setting-field"
												label={t("settings.proxyBypass")}
												value={draftSettings.desktopProxyBypass}
												placeholder="localhost,127.0.0.1,::1"
												description={t("settings.electronProxyHint")}
												onChange={(value) =>
													updateDraft({ desktopProxyBypass: value })
												}
											/>
										</div>
									)}
								</SettingsSection>
							</>
						)}
						{/* ── 开发设置 tab（含 Web 服务） ── */}
						{activeTab === "dev" && (
							<>
								<SettingsSection title={t("settings.environment")}>
									<div className="setting-row">
										<div>
											<strong>{t("settings.piEnvironment")}</strong>
											<small>
												{props.piStatus
													? props.piStatus.installed
														? t("settings.foundPi", {
																version: props.piStatus.version ?? "pi",
															})
														: t("settings.piMissing")
													: t("settings.piCliAvailable")}
											</small>
											{piPath && (
												<small className="setting-path">
													{t("settings.currentPath", { path: piPath })}
												</small>
											)}
											{props.piStatus && !props.piStatus.installed && props.piStatus.error && (
												<small className="setting-status error setting-error-detail">
													{t("settings.detectFailed", {
														error: props.piStatus.error,
													})}
												</small>
											)}
										</div>
										<div className="setting-inline-actions">
											<Button onClick={props.onCheckPi} disabled={props.piChecking}>
												{props.piChecking
													? t("settings.detecting")
													: t("settings.detectEnvironment")}
											</Button>
											{props.onClearCheckFlag && (
												<Button
													className="setting-btn-secondary"
													onClick={props.onClearCheckFlag}
												>
													{t("environment.clearCheckFlag")}
												</Button>
											)}
										</div>
									</div>
									<div className="setting-pi-path-panel">
										<TextField
											className="setting-field"
											label={t("settings.customPiPath")}
											value={props.customPiPath}
											placeholder={
												piPath ||
												"D:\\mise-data\\installs\\node\\24 13 0\\pi.cmd"
											}
											description={t("settings.customPiPathHint")}
											disabled={props.customPathValidating}
											onChange={props.onCustomPathChange}
										/>
										<div className="setting-pi-path-actions">
											<Button
												onClick={props.onValidateCustomPath}
												disabled={!props.customPiPath.trim() || props.customPathValidating}
											>
												{props.customPathValidating
													? t("settings.validating")
													: t("settings.validatePiPath")}
											</Button>
											<Button
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
								{/* WSL pi 来源配置：仅 Windows 可见，使用全局 draft */}
								{props.appInfo.platform === "win32" && (
								<div className="setting-pi-wsl-panel">
									<SelectField
										className="setting-field"
										label={t("settings.piSource.label")}
										description={t("settings.piSource.desc")}
										value={draftSettings.wslEnabled ? "wsl" : "windows"}
										options={[
											{ value: "windows", label: t("settings.piSource.windows") },
											{ value: "wsl", label: t("settings.piSource.wsl") },
										]}
										onChange={(value) => {
											updateDraft({ wslEnabled: value === "wsl" });
											setWslValidation(null);
										}}
									/>
									{draftSettings.wslEnabled && (
										<>
											<div className="setting-wsl-fields">
												{wslDistros.length > 0 ? (
													<SelectField
														className="setting-field"
														label={t("settings.wsl.distro")}
														value={draftSettings.wslDistro}
														options={distroOptions}
														onChange={(value) => {
															updateDraft({ wslDistro: value });
															setWslValidation(null);
														}}
													/>
												) : (
													<TextField
														className="setting-field"
														label={t("settings.wsl.distro")}
														value={draftSettings.wslDistro}
														onChange={(value) => {
															updateDraft({ wslDistro: value });
															setWslValidation(null);
														}}
														placeholder="Ubuntu"
													/>
												)}
												{wslDistrosLoading && (
													<small className="setting-status info">{t("settings.wsl.detectingDistros")}</small>
												)}
												<div className="setting-wsl-user-row">
													<TextField
														className="setting-field"
														label={t("settings.wsl.user")}
														value={wslUserInput}
														onChange={(value) => {
															setWslUserInput(value);
															setWslValidation(null);
														}}
														placeholder="root"
													/>
													<Button
														buttonSize="sm"
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
										</>
									)}
								</div>
								)}
								<div className="setting-field">
									<span>
										{t("settings.rpcTimeout")}
										<DirtyMarker dirty={isDirty("rpcTimeout")} label={t("settings.rpcTimeout")} />
									</span>
									<input
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
									<input
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
								<SettingSwitch
									title={t("settings.disableUpdateCheck")}
									description={t("settings.disableUpdateCheckDesc")}
									checked={draftSettings.disableUpdateCheck}
									onChange={(checked) =>
										updateDraft({ disableUpdateCheck: checked })
									}
								/>
								<div className="setting-row">
									<div>
										<strong>{t("settings.piUpdate")}</strong>
										<span style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", color: "var(--color-text-tertiary)", fontSize: "var(--font-size-caption)" }}>
											<span>v{props.appInfo.version}</span>
											{props.piUpdateCheck?.currentVersion || props.piStatus?.version ? (
												<span>
													{t("settings.piUpdateVersions", {
														current: props.piUpdateCheck?.currentVersion ?? props.piStatus?.version ?? "-",
														latest: props.piUpdateCheck?.latestVersion ?? "-",
													})}
												</span>
											) : (
												<span>{t("settings.piUpdateDesc")}</span>
											)}
										</span>
									</div>
									<div className="setting-inline-actions">
										<Button
											onClick={draftSettings.disableUpdateCheck ? undefined : props.onCheckUpdate}
											loading={props.updateChecking}
											disabled={draftSettings.disableUpdateCheck}
										>
											{draftSettings.disableUpdateCheck
												? t("settings.updateCheckDisabled")
												: t("settings.checkUpdate")}
										</Button>
										<Button
											onClick={props.onCheckPiUpdate}
											loading={props.piUpdateChecking}
											disabled={draftSettings.disableUpdateCheck}
										>
											{t("settings.checkPiUpdate")}
										</Button>
										<Button
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
											<label className="web-endpoint-metric editable">
												<span>{t("common.port")}</span>
												<input
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
											</label>
										</div>
										<div className="web-endpoint-summary">
											<span className={draftSettings.webServiceEnabled ? "online" : ""} />
											<div>
												<strong>
													http://127.0.0.1:{webPortDraft || draftSettings.webServicePort}
												</strong>
												<small>{t("settings.localWebHint")}</small>
											</div>
											<Button
												buttonSize="sm"
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
								<SettingsSection title={t("settings.debug")}>
									<div className="setting-row">
										<div>
											<strong>{t("settings.restartApp")}</strong>
											<small>{t("settings.restartAppDesc")}</small>
										</div>
										<Button onClick={props.onRestartApp}>
											{t("settings.restartAppButton")}
										</Button>
									</div>
									<div className="setting-row">
										<div>
											<strong>{t("settings.devTools")}</strong>
											<small>{t("settings.devToolsDesc")}</small>
										</div>
										<Button onClick={props.onToggleDevTools}>
											{t("settings.toggle")}
										</Button>
									</div>
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
									<SelectField
										className="setting-field"
										label={t("settings.pet.choose")}
										value={draftSettings.petId}
										options={petOptions}
										onChange={(value) => {
											setPetPreviewMode("__auto");
											updateDraft({ petId: value });
										}}
									/>
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
									<SelectField
										className="setting-field"
										label={t("settings.pet.previewMode")}
										value={petPreviewMode}
										options={[
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
										]}
										onChange={(value) => {
											setPetPreviewMode(value);
											void window.piDesktop.pet.setPreviewMode(value === "__auto" ? "" : value);
										}}
									/>
									<div className="setting-inline-actions pet-test-actions">
										<Button
											buttonSize="sm"
											variant="danger"
											onClick={() => void window.piDesktop.pet.testNotify("error")}
										>
											{t("settings.pet.testError")}
										</Button>
										<Button
											buttonSize="sm"
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
					<div className="config-modal-overlay" onClick={() => setCloseConfirmOpen(false)}>
						<div className="config-modal-dialog" onClick={(e) => e.stopPropagation()}>
							<strong>{t("settings.unsavedTitle")}</strong>
							<p>{t("settings.unsavedMessage")}</p>
							<div className="config-modal-actions">
								<button className="config-btn" onClick={() => setCloseConfirmOpen(false)}>
									{t("common.cancel")}
								</button>
								<button className="config-btn danger" onClick={handleDiscardAndClose}>
									{t("settings.discardChanges")}
								</button>
								<button className="config-btn primary" onClick={handleSaveAndClose}>
									{t("settings.saveAndClose")}
								</button>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
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

/** 存储管理子标签页 */
function StorageTab(props: {
	settings: AppSettings;
	onChange: (patch: Partial<AppSettings>) => void;
}) {
	const [logsSize, setLogsSize] = useState<string>("");
	const [rpcLogsSize, setRpcLogsSize] = useState<string>("");
	const [clearing, setClearing] = useState<string | null>(null);
	const [feedback, setFeedback] = useState("");
	const [confirmDialog, setConfirmDialog] = useState<{
		title: string;
		message: string;
		onConfirm: () => void;
	} | null>(null);

	// 每 5 秒刷新一次日志大小; 切换到此 tab 时立即刷新（activeTab 由父组件管理,当前存储 tab 自身 mount 时刷新）
	useEffect(() => {
		let mounted = true;
		const refresh = () => {
			void window.piDesktop.logs.getSize().then((bytes) => {
				if (mounted) setLogsSize(formatBytes(bytes));
			});
		};
		refresh();
		const timer = setInterval(refresh, 5000);
		return () => { mounted = false; clearInterval(timer); };
	}, []);

	useEffect(() => {
		let mounted = true;
		const refresh = () => {
			void window.piDesktop.rpcLogs.getSize().then((bytes) => {
				if (mounted) setRpcLogsSize(formatBytes(bytes));
			});
		};
		refresh();
		const timer = setInterval(refresh, 5000);
		return () => { mounted = false; clearInterval(timer); };
	}, []);

	const doClear = async (target: string) => {
		setClearing(target);
		setFeedback("");
		try {
			if (target === "app") {
				await window.piDesktop.logs.clear();
			} else if (target === "rpc") {
				await window.piDesktop.rpcLogs.clear();
			} else {
				await window.piDesktop.logs.clear();
				await window.piDesktop.rpcLogs.clear();
			}
			setFeedback(t("settings.storage.clearSuccess"));
		} catch (e) {
			setFeedback(`${t("common.error")}: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setClearing(null);
		}
	};

	const confirmClear = (target: string, label: string) => {
		setConfirmDialog({
			title: t("app.confirm"),
			message: t("settings.storage.clearConfirm", { label }),
			onConfirm: () => { doClear(target); setConfirmDialog(null); },
		});
	};

	const handleOpenFolder = async () => {
		try {
			await window.piDesktop.logs.openFolder();
		} catch (e) {
			setFeedback(`${t("common.error")}: ${e instanceof Error ? e.message : String(e)}`);
		}
	};

	return (
		<>
			{confirmDialog && (
				<div className="config-modal-overlay" onClick={() => setConfirmDialog(null)}>
					<div className="config-modal-dialog" onClick={(e) => e.stopPropagation()}>
						<strong>{confirmDialog.title}</strong>
						<p>{confirmDialog.message}</p>
						<div className="config-modal-actions">
							<button className="config-btn" onClick={() => setConfirmDialog(null)}>
								{t("common.cancel")}
							</button>
							<button
								className="config-btn danger"
								onClick={confirmDialog.onConfirm}
							>
								{t("common.confirm")}
							</button>
						</div>
					</div>
				</div>
			)}
			<SettingsSection title={t("settings.storage.appLogs")}>
				<div className="setting-row">
					<div>
						<strong>{t("settings.storage.appLogsSize")}</strong>
						<small>{logsSize || t("common.loading")}</small>
					</div>
					<Button
						loading={clearing === "app" || clearing === "all"}
						disabled={clearing !== null}
						onClick={() => confirmClear("app", t("settings.storage.appLogs"))}
					>
						{t("common.delete")}
					</Button>
				</div>
			</SettingsSection>
			<SettingsSection title={t("settings.storage.rpcLogs")}>
				<div className="setting-row">
					<div>
						<strong>{t("settings.storage.rpcLogsSize")}</strong>
						<small>{rpcLogsSize || t("common.loading")}</small>
					</div>
					<Button
						loading={clearing === "rpc" || clearing === "all"}
						disabled={clearing !== null}
						onClick={() => confirmClear("rpc", t("settings.storage.rpcLogs"))}
					>
						{t("common.delete")}
					</Button>
				</div>
				{feedback && (
					<small className={`setting-status ${feedback.includes(t("common.error")) ? "error" : "success"}`}>
						{feedback}
					</small>
				)}
			</SettingsSection>
			<SettingsSection title={t("settings.storage.actions")}>
				<div className="setting-row">
					<div>
						<strong>{t("settings.storage.clearAll")}</strong>
						<small>{t("settings.storage.clearAllDesc")}</small>
					</div>
					<Button
						variant="danger"
						loading={clearing === "all"}
						disabled={clearing !== null}
						onClick={() => confirmClear("all", `${t("settings.storage.appLogs")} + ${t("settings.storage.rpcLogs")}`)}
					>
						{t("settings.storage.clearAllButton")}
					</Button>
				</div>
				<div className="setting-row">
					<div>
						<strong>{t("settings.storage.openFolder")}</strong>
						<small>{t("settings.storage.openFolderDesc")}</small>
					</div>
					<Button onClick={handleOpenFolder}>
						{t("common.open")}
					</Button>
				</div>
			</SettingsSection>
		</>
	);
}

function formatBytes(value: number) {
	if (value === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	return `${(value / 1024 ** index).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
}
