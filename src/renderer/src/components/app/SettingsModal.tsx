// @ts-nocheck - extracted from AppParts, pre-existing type issues
import { useState, useEffect, useRef, type ReactNode } from "react";
import {
	Settings2,
	Network,
	Globe2,
	Wrench,
	PawPrint,
	Trash2,
	RefreshCw,
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

type SettingsTabId = "base" | "proxy" | "web" | "dev" | "pet" | "storage";

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
	const [activeTab, setActiveTab] = useState<SettingsTabId>("base");
	const [perAreaFontSize, setPerAreaFontSize] = useState(
		props.settings.uiFontSize !== null ||
			props.settings.chatFontSize !== null ||
			props.settings.inputFontSize !== null,
	);
	const [webPortDraft, setWebPortDraft] = useState(String(props.settings.webServicePort));
	const piPath = props.settings.customPiPath || props.piStatus?.command || "";
	const changeZoomFactor = (delta: number) => {
		const next = Math.min(
			ZOOM_FACTOR_MAX,
			Math.max(
				ZOOM_FACTOR_MIN,
				Math.round((props.settings.zoomFactor + delta) * 100) / 100,
			),
		);
		props.onChange({ zoomFactor: next });
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
	useEffect(() => {
		setWebPortDraft(String(props.settings.webServicePort));
	}, [props.settings.webServicePort]);

	// 宠物包列表：异步加载内置 + petdex 社区包，供选择下拉使用
	const [petOptions, setPetOptions] = useState<{ value: string; label: string }[]>([]);
	// 完整宠物清单（含 spritesheetUrl / 描述），用于选择预览：仅靠 id 无法加载图，需清单里的 url。
	const [petList, setPetList] = useState<PetManifest[]>([]);
	useEffect(() => {
		window.piDesktop.pet
			.list()
			.then((pets) => { setPetList(pets); setPetOptions(pets.map((p) => ({ value: p.id, label: p.displayName }))); })
			.catch(() => undefined);
	}, []);
	// 宠物动画预览模式：下拉选中值需受控，避免选完弹回"自动"
	const [petPreviewMode, setPetPreviewMode] = useState("__auto");
	const applyWebPortDraft = () => {
		const port = Number(webPortDraft);
		if (Number.isInteger(port) && port >= 1 && port <= 65535 && port !== props.settings.webServicePort) {
			props.onChange({ webServicePort: port });
		} else {
			setWebPortDraft(String(props.settings.webServicePort));
		}
	};
	const tabs: Array<{
		id: SettingsTabId;
		label: string;
		icon: ReactNode;
	}> = [
		{
			id: "base",
			label: t("settings.tabs.base"),
			icon: <Settings2 size={16} />,
		},
		{
			id: "proxy",
			label: t("settings.tabs.proxy"),
			icon: <Network size={16} />,
		},
		{
			id: "web",
			label: t("settings.tabs.web"),
			icon: <Globe2 size={16} />,
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
	const lightBackgroundDisabled = props.settings.theme === "dark";

	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<div
				className="settings-modal"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="modal-header">
					<strong>{t("settings.title")}</strong>
					<CloseIconButton
						label={t("common.close")}
						onClick={props.onClose}
					/>
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
						{activeTab === "base" && (
							<>
								<SettingsSection title={t("settings.interface")}>
									<SelectField
										className="setting-field"
										label={t("settings.theme")}
										value={props.settings.theme}
										options={themeOptions}
										onChange={(value) =>
											props.onChange({
												theme: value as AppSettings["theme"],
											})
										}
									/>
									<SelectField
										className="setting-field"
										label={t("settings.lightBackground")}
										description={
											lightBackgroundDisabled
												? t("settings.lightBackgroundDisabledDesc")
												: t("settings.lightBackgroundDesc")
										}
										disabled={lightBackgroundDisabled}
										value={props.settings.lightBackground}
										options={lightBackgroundOptions}
										onChange={(value) =>
											props.onChange({
												lightBackground: value as AppSettings["lightBackground"],
											})
										}
									/>
									<SelectField
										className="setting-field"
										label={t("settings.language")}
										value={props.settings.language}
										options={languageOptions}
										onChange={(value) =>
											props.onChange({
												language: value as AppSettings["language"],
											})
										}
									/>
									<SettingSwitch
										title={t("settings.gitManagement")}
										description={t("settings.gitManagementDesc")}
										checked={props.settings.enableGitManagement}
										onChange={(checked) =>
											props.onChange({ enableGitManagement: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.nativeTitleBar")}
										checked={props.settings.useNativeTitleBar}
										onChange={(checked) =>
											props.onChange({ useNativeTitleBar: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.nativeMenu")}
										checked={props.settings.showNativeMenu}
										onChange={(checked) =>
											props.onChange({ showNativeMenu: checked })
										}
									/>
									<div className="setting-field setting-zoom-field">
										<span>{t("settings.zoomFactor")}</span>
										<div className="setting-zoom-control">
											<IconButton
												className="icon-button setting-zoom-button"
												label={t("settings.zoomOut")}
												disabled={props.settings.zoomFactor <= ZOOM_FACTOR_MIN}
												onClick={() => changeZoomFactor(-ZOOM_FACTOR_STEP)}
											>
												<Minus size={16} strokeWidth={2.2} aria-hidden="true" />
											</IconButton>
											<output className="setting-zoom-value" aria-live="polite">
												{Math.round(props.settings.zoomFactor * 100)}%
											</output>
											<IconButton
												className="icon-button setting-zoom-button"
												label={t("settings.zoomIn")}
												disabled={props.settings.zoomFactor >= ZOOM_FACTOR_MAX}
												onClick={() => changeZoomFactor(ZOOM_FACTOR_STEP)}
											>
												<Plus size={16} strokeWidth={2.2} aria-hidden="true" />
											</IconButton>
										</div>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.typography")}>
									<SelectField
										className="setting-field"
										label={t("settings.fontSize")}
										value={props.settings.fontSize}
										options={fontSizeOptions}
										onChange={(value) =>
											props.onChange({
												fontSize: value as AppSettings["fontSize"],
											})
										}
									/>
									<SettingSwitch
										title={t("settings.fontSizePerArea")}
										description={t("settings.fontSizePerAreaDesc")}
										checked={perAreaFontSize}
										onChange={(checked) => {
											setPerAreaFontSize(checked);
											if (!checked) {
												props.onChange({
													uiFontSize: null,
													chatFontSize: null,
													inputFontSize: null,
												});
											}
										}}
									/>
									{perAreaFontSize && (
										<>
											<SelectField
												className="setting-field"
												label={t("settings.uiFontSize")}
												value={props.settings.uiFontSize ?? props.settings.fontSize}
												options={fontSizeOptions}
												onChange={(value) =>
													props.onChange({
														uiFontSize: value as AppSettings["uiFontSize"],
													})
												}
											/>
											<SelectField
												className="setting-field"
												label={t("settings.chatFontSize")}
												value={props.settings.chatFontSize ?? props.settings.fontSize}
												options={fontSizeOptions}
												onChange={(value) =>
													props.onChange({
														chatFontSize: value as AppSettings["chatFontSize"],
													})
												}
											/>
											<SelectField
												className="setting-field"
												label={t("settings.inputFontSize")}
												value={props.settings.inputFontSize ?? props.settings.fontSize}
												options={fontSizeOptions}
												onChange={(value) =>
													props.onChange({
														inputFontSize: value as AppSettings["inputFontSize"],
													})
												}
											/>
										</>
									)}
									<hr className="setting-divider" />
									<SelectField
										className="setting-field"
										label={t("settings.fontFamilyBase")}
										description={t("settings.fontFamilyBaseDesc")}
										value={props.settings.fontFamilyBase}
										options={fontBaseOptions}
										onChange={(value) =>
											props.onChange({
												fontFamilyBase: value as AppSettings["fontFamilyBase"],
											})
										}
									/>
									{props.settings.fontFamilyBase === "custom" && (
										<TextField
											className="setting-field"
											label={t("settings.fontFamilyBaseCustomField")}
											value={props.settings.fontFamilyBaseCustom}
											placeholder={t("settings.fontFamilyBaseCustomPlaceholder")}
											onChange={(value) =>
												props.onChange({ fontFamilyBaseCustom: value })
											}
										/>
									)}
									<hr className="setting-divider" />
									<SelectField
										className="setting-field"
										label={t("settings.fontFamilyMono")}
										description={t("settings.fontFamilyMonoDesc")}
										value={props.settings.fontFamilyMono}
										options={fontMonoOptions}
										onChange={(value) =>
											props.onChange({
												fontFamilyMono: value as AppSettings["fontFamilyMono"],
											})
										}
									/>
									{props.settings.fontFamilyMono === "custom" && (
										<TextField
											className="setting-field"
											label={t("settings.fontFamilyMonoCustomField")}
											value={props.settings.fontFamilyMonoCustom}
											placeholder={t("settings.fontFamilyMonoCustomPlaceholder")}
											onChange={(value) =>
												props.onChange({ fontFamilyMonoCustom: value })
											}
										/>
									)}
								</SettingsSection>
								<SettingsSection title={t("settings.contentMaxWidth")} description={t("settings.contentMaxWidthDesc")}>
									<div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", maxWidth: 480 }}>
										<input
											type="range"
											min="800"
											max="1400"
											step="25"
											value={props.settings.contentMaxWidth}
											onChange={(event) => props.onChange({ contentMaxWidth: parseInt(event.target.value) })}
											style={{ flex: 1, accentColor: "var(--color-accent)", direction: "rtl" }}
										/>
										<span style={{
											fontFamily: "var(--font-family-business)",
											fontSize: "var(--font-size-sm)",
											color: "var(--color-text-muted)",
											minWidth: 80,
											textAlign: "right",
										}}>
											{props.settings.contentMaxWidth === 1400
												? t("settings.contentMaxWidthUnlimited")
												: `${props.settings.contentMaxWidth}px`}
										</span>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.notificationSection")}>
									<SettingSwitch
										title={t("settings.closeToTray")}
										checked={props.settings.closeToTray}
										onChange={(checked) =>
											props.onChange({ closeToTray: checked })
										}
									/>
									<SettingSwitch
										title={t("settings.enableNotifications")}
										checked={props.settings.enableNotifications}
										onChange={(checked) =>
											props.onChange({ enableNotifications: checked })
										}
									/>

									<SelectField
										className="setting-field"
										label={t("settings.inputShortcut")}
										value={props.settings.sendShortcut}
										options={sendShortcutOptions}
										onChange={(value) =>
											props.onChange({
												sendShortcut:
													value as AppSettings["sendShortcut"],
											})
										}
									/>
									<TextField
										className="setting-field"
										label={t("settings.rpcTimeout")}
										type="number"
										value={String(Math.round(props.settings.rpcTimeout / 1000))}
										description={t("settings.rpcTimeoutDesc")}
										onChange={(value) => {
											// 防止用户设置过小的超时导致 RPC 调用频繁超时，最低 600 秒
											const seconds = Math.max(600, parseInt(value) || 600);
											props.onChange({ rpcTimeout: seconds * 1000 });
										}}
									/>
									<SelectField
										className="setting-field"
										label={t("settings.linkOpenMode")}
										description={t("settings.linkOpenModeDesc")}
										value={props.settings.linkOpenMode}
										options={linkOpenModeOptions}
										onChange={(value) =>
											props.onChange({
												linkOpenMode: value as AppSettings["linkOpenMode"],
											})
										}
									/>
									<TextField
										className="setting-field"
										label={t("settings.maxEditorFileSize")}
										description={t("settings.maxEditorFileSizeDesc")}
										type="number"
										value={String(props.settings.maxEditorFileSizeMB)}
										onChange={(value) => {
											const mb = Math.max(1, parseInt(value) || 5);
											props.onChange({ maxEditorFileSizeMB: mb });
										}}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.privacy")}>
									<SettingSwitch
										title={t("settings.telemetry")}
										description={t("settings.telemetryDesc")}
										checked={props.settings.telemetryEnabled}
										onChange={(checked) =>
											props.onChange({ telemetryEnabled: checked })
										}
									/>
								</SettingsSection>
							</>
						)}
						{activeTab === "proxy" && (
							<>
								<SettingsSection
									title={t("settings.piProxy")}
									description={t("settings.piProxyDesc")}
								>
									<SettingSwitch
										title={t("settings.enablePiProxy")}
										description={t("settings.settingTakesEffectAfterRestart")}
										checked={props.settings.piProxyEnabled}
										onChange={(checked) =>
											props.onChange({ piProxyEnabled: checked })
										}
									/>
									{props.settings.piProxyEnabled && (
										<div className="setting-proxy-panel">
											<TextField
												className="setting-field"
												label={t("settings.proxyUrl")}
												value={props.settings.piProxyUrl}
												placeholder="http://127.0.0.1:7890"
												onChange={(value) =>
													props.onChange({ piProxyUrl: value })
												}
											/>
											<TextField
												className="setting-field"
												label={t("settings.proxyBypass")}
												value={props.settings.piProxyBypass}
												placeholder="localhost,127.0.0.1,::1"
												description={t("settings.noProxyHint")}
												onChange={(value) =>
													props.onChange({ piProxyBypass: value })
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
										checked={props.settings.desktopProxyEnabled}
										onChange={(checked) =>
											props.onChange({ desktopProxyEnabled: checked })
										}
									/>
									{props.settings.desktopProxyEnabled && (
										<div className="setting-proxy-panel">
											<TextField
												className="setting-field"
												label={t("settings.proxyUrl")}
												value={props.settings.desktopProxyUrl}
												placeholder="http://127.0.0.1:7890"
												onChange={(value) =>
													props.onChange({ desktopProxyUrl: value })
												}
											/>
											<TextField
												className="setting-field"
												label={t("settings.proxyBypass")}
												value={props.settings.desktopProxyBypass}
												placeholder="localhost,127.0.0.1,::1"
												description={t("settings.electronProxyHint")}
												onChange={(value) =>
													props.onChange({ desktopProxyBypass: value })
												}
											/>
										</div>
									)}
								</SettingsSection>
							</>
						)}
						{activeTab === "web" && (
							<SettingsSection
								title={t("settings.webLocalService")}
								description={t("settings.webLocalServiceDesc")}
							>
								<SettingSwitch
									title={t("settings.enableWebService")}
									description={
										props.webServiceChanging
											? t("settings.webOpening")
											: t("settings.webOffDesc")
									}
									checked={props.settings.webServiceEnabled}
									disabled={props.webServiceChanging}
									onChange={(checked) =>
										props.onChange({ webServiceEnabled: checked })
									}
								/>
								<div className="web-endpoint-panel">
									<div className="web-endpoint-grid">
										<div className="web-endpoint-metric">
											<span>{t("common.host")}</span>
											<code>{props.settings.webServiceHost}</code>
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
										<span className={props.settings.webServiceEnabled ? "online" : ""} />
										<div>
											<strong>
												http://127.0.0.1:{webPortDraft || props.settings.webServicePort}
											</strong>
											<small>{t("settings.localWebHint")}</small>
										</div>
										<Button
											buttonSize="sm"
											disabled={!props.settings.webServiceEnabled}
											onClick={() =>
												props.onOpenWebService(webPortDraft || String(props.settings.webServicePort))
											}
										>
											{t("common.open")}
										</Button>
									</div>
								</div>
							</SettingsSection>
						)}
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
								<div className="setting-pi-wsl-panel">
									<SelectField
										className="setting-field"
										label={t("settings.piSource.label")}
										description={t("settings.piSource.desc")}
										value={props.settings.wslEnabled ? "wsl" : "windows"}
										options={[
											{ value: "windows", label: t("settings.piSource.windows") },
											{ value: "wsl", label: t("settings.piSource.wsl") },
										]}
										onChange={(value) => props.onChange({ wslEnabled: value === "wsl" })}
									/>
									{props.settings.wslEnabled && (
										<>
											<div className="setting-wsl-fields">
												<TextField
													className="setting-field"
													label={t("settings.wsl.distro")}
													value={props.settings.wslDistro}
													onChange={(value) => props.onChange({ wslDistro: value })}
													placeholder="Ubuntu"
												/>
												<TextField
													className="setting-field"
													label={t("settings.wsl.user")}
													value={props.settings.wslUser}
													onChange={(value) => props.onChange({ wslUser: value })}
													placeholder="root"
												/>
											</div>
											<small className="setting-status info">
												{t("settings.wsl.detectHint")}
											</small>
											<div className="setting-wsl-hints">
												<div className="setting-wsl-hint">
													<strong>{t("settings.wsl.howToGetDistro")}</strong>
													<code>wsl -l -v</code>
												</div>
												<div className="setting-wsl-hint">
													<strong>{t("settings.wsl.howToGetUser")}</strong>
													<code>wsl -d {props.settings.wslDistro || "Ubuntu"} -u {props.settings.wslUser || "root"} whoami</code>
												</div>
											</div>
											<small className="setting-status warning">
												{t("settings.wsl.warning")}
											</small>
										</>
									)}
								</div>
								<div className="setting-row">
										<div>
											<strong>{t("settings.currentVersion")}</strong>
											<small>v{props.appInfo.version}</small>
										</div>
										<Button onClick={props.onCheckUpdate} loading={props.updateChecking}>
											{t("settings.checkUpdate")}
										</Button>
									</div>
									<div className="setting-row">
										<div>
											<strong>{t("settings.piUpdate")}</strong>
											<small>{t("settings.piUpdateDesc")}</small>
											<small className="setting-status info">
												{t("settings.piUpdateVersions", {
													current:
														props.piUpdateCheck?.currentVersion ??
														props.piStatus?.version ??
														"-",
													latest: props.piUpdateCheck?.latestVersion ?? "-",
												})}
											</small>
										</div>
										<div className="setting-inline-actions">
											<Button
												onClick={props.onCheckPiUpdate}
												loading={props.piUpdateChecking}
											>
												{t("settings.checkPiUpdate")}
											</Button>
											<Button
												onClick={props.onUpdatePi}
												loading={props.piUpdating}
												disabled={!props.piUpdateCheck?.hasUpdate}
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
						{activeTab === "pet" && (
							<>
								<SettingsSection title={t("settings.pet.title")} description={t("settings.pet.sectionDesc")}>
									<SettingSwitch
										title={t("settings.pet.enable")}
										description={t("settings.pet.enableDesc")}
										checked={props.settings.petEnabled}
										onChange={(value) => props.onChange({ petEnabled: value })}
									/>
									<SettingSwitch
										title={t("settings.pet.alwaysOnTop")}
										description={t("settings.pet.alwaysOnTopDesc")}
										checked={props.settings.petAlwaysOnTop}
										onChange={(value) => props.onChange({ petAlwaysOnTop: value })}
									/>
									<SettingSwitch
										title={t("settings.pet.patrol")}
										description={t("settings.pet.patrolDesc")}
										checked={props.settings.petPatrolEnabled ?? true}
										onChange={(value) => props.onChange({ petPatrolEnabled: value })}
									/>
								</SettingsSection>
								<SettingsSection title={t("settings.pet.patrolPause")} description={t("settings.pet.patrolPauseDesc")}>
									<div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", maxWidth: 320 }}>
										<input
											type="range"
											min="1"
											max="30"
											step="1"
											value={props.settings.petPatrolPauseMin ?? 5}
											onChange={(event) => props.onChange({ petPatrolPauseMin: parseInt(event.target.value) })}
											style={{ flex: 1, accentColor: "var(--color-accent)", direction: "rtl" }}
										/>
										<span style={{
											fontFamily: "var(--font-family-business)",
											fontSize: "var(--font-size-sm)",
											color: "var(--color-text-muted)",
											minWidth: 60,
											textAlign: "right",
										}}>
											{props.settings.petPatrolPauseMin ?? 5} min
										</span>
									</div>
								</SettingsSection>
								<SettingsSection title={t("settings.pet.choose")}>
									<SelectField
										className="setting-field"
										label={t("settings.pet.choose")}
										value={props.settings.petId}
										options={petOptions}
										onChange={(value) => {
											setPetPreviewMode("__auto");
											props.onChange({ petId: value });
										}}
									/>
									<small className="setting-status">{t("settings.pet.petdexHint")}</small>
									{(() => {
										const selected = petList.find((pet) => pet.id === props.settings.petId);
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
											value={props.settings.petScale ?? 1}
											onChange={(event) => props.onChange({ petScale: parseFloat(event.target.value) })}
											style={{ flex: 1, accentColor: "var(--color-accent)", direction: "rtl" }}
										/>
										<span style={{
											fontFamily: "var(--font-family-business)",
											fontSize: "var(--font-size-sm)",
											color: "var(--color-text-muted)",
											minWidth: 36,
											textAlign: "right",
										}}>
											{((props.settings.petScale ?? 1) * 100).toFixed(0)}%
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
						{activeTab === "storage" && (
							<StorageTab
								settings={props.settings}
								onChange={props.onChange}
							/>
						)}
					</div>
				</div>
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
