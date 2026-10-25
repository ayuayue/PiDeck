import { memo, useEffect, useRef, useState } from "react";
import type { AppInfo, AppSettings, DataEnvInfo, PiCliUpdateResult, PiInstallation, PiInstallStatus, PiUpdateCheckResult, WslConnectionValidation } from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { useAtomValue } from "jotai";
import { updateStatusAtom } from "../../../atoms/update-atoms";
import { updateChannelInfoAtom } from "../../../atoms/channelSwitchAtoms";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { AppUpdateCard } from "./AppUpdateCard";
import { DirtyMarker, SettingRow, SettingSwitchRow } from "./SettingRows";
import { UpdateSourceSetting } from "./UpdateSourceSetting";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import { CatalogSection } from "./CatalogSection";
import { DshRunnerNodeRow } from "./DshRunnerNodeRow";
import { PiCommandSourcePanel } from "../PiCommandSourcePanel";
import { PiChangelogDialog } from "./PiChangelogDialog";

type DevTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	isDirty: (field: keyof AppSettings) => boolean;
	/** 检测环境/校验自定义路径前把 WSL 草稿差异先落盘；主进程读的是持久化设置，
	 * 草稿未提交时会拿旧的 wslEnabled/distro/user 执行（Linux 路径被当 Windows 文件 → ENOENT）。
	 * 返回 false（持久化失败）时调用方应中止操作，避免用旧配置出误导性结果。 */
	onEnsureWslSettingsSaved: () => Promise<boolean>;
	appInfo: AppInfo;
	piStatus: PiInstallStatus | null;
	piChecking: boolean;
	/** 检测到的全部 pi 安装（含官方 managed 安装）；空数组 = 不展示选择区 */
	piInstallations: PiInstallation[];
	/** 从安装列表里选定一份（校验通过后写入 settings.customPiPath） */
	onChoosePiInstallation: (path: string) => void;
	/** 反查交互式登录 shell 再找一次（zsh/自定义 PATH 场景） */
	onShellProbePiInstallations: () => void;
	shellProbingPiInstallations: boolean;
	/** 正在校验的安装路径（列表行内 loading） */
	applyingPiInstallationPath: string | null;
	/** 进入本 tab 时拉一次安装列表（用户可能从不点「检测环境」） */
	onRequestPiInstallations: () => void;
	/** 系统文件选择器挑 pi 可执行文件（稀有/自定义安装） */
	onBrowsePiPath: () => void;
	browsingPiPath: boolean;
	/** 检测环境（并入命令来源面板头部；面板自己会保证 WSL 草稿先落盘） */
	onCheckPi: () => void;
	/** 添加/编辑/移除用户自加的候选路径 */
	onAddPiCustomPath: (path: string) => Promise<void> | void;
	onUpdatePiCustomPath: (previousPath: string, nextPath: string) => Promise<void> | void;
	onRemovePiCustomPath: (path: string) => Promise<void> | void;
	onClearCheckFlag?: () => void;
	piUpdateChecking: boolean;
	onCheckPiUpdate: () => void;
	piUpdating: boolean;
	onUpdatePi: () => void;
	piUpdateCheck: PiUpdateCheckResult | null;
	piUpdateResult: PiCliUpdateResult | null;
	updateChecking: boolean;
	onCheckUpdate: () => void;
	/** 手动下载（自动下载关闭时显示「立即下载」）。 */
	onDownloadUpdate: () => void;
	/** 重启并安装（下载完成后显示）。 */
	onInstallUpdate: () => void;
	onToggleDevTools: () => void;
	onRestartApp: () => void;
	/** 壳层「取消」递增；本 tab 借此重置 WSL / Web 端口等局部状态 */
	resetKey: number;
};

/** 下拉选项：disabled 可选（SelectItem 透传） */
type SelectOption = { value: string; label: string; disabled?: boolean };

/**
 * 设置弹框「开发设置」tab：环境/版本更新/运行参数/调试/隐私。
 * 独立组件 + memo：WSL 等局部状态自持，只有进入本 tab 才加载；
 * Web 本地服务与外部编辑器已拆为独立 tab（settings/WebTab.tsx、settings/EditorsTab.tsx）。
 */
export const DevTab = memo(function DevTab(props: DevTabProps) {
	const { draft, updateDraft, isDirty } = props;
	// 当前使用的 pi 命令：以检测结果为准（自定义路径切换后主进程会把 customPiPath 写进 piStatus.command）
	const piPath = props.piStatus?.command ?? "";

	// 进本 tab 就拉一次安装列表（主进程 10s 内缓存，不会重复 spawn）：
	// 用户可能从来不会点「检测环境」，但多份 pi 时必须看得到选择入口。
	// 用 ref 拿最新回调，避免把这个一次性副作用挂到 props 变化上反复触发。
	const requestInstallationsRef = useRef(props.onRequestPiInstallations);
	requestInstallationsRef.current = props.onRequestPiInstallations;
	useEffect(() => {
		requestInstallationsRef.current();
	}, []);
	// 后台检查发现可提示的 PiDeck 新版本（未跳过）时高亮设置页更新分区。
	const updateStatus = useAtomValue(updateStatusAtom);
	// 当前更新通道（useChannelSwitchWatch 初拉）：AppUpdateCard 徽章与切换方向依据；
	// 初拉未返回前按 stable 兜底（多数用户为正式包，getChannel 返回后立即校正）。
	const channelInfo = useAtomValue(updateChannelInfoAtom);
	const piCliStatus = updateStatus?.piCli ?? null;
	// 手动检查的结果比定时后台快照更新，统一决定提示内容和更新按钮是否可用。
	const piUpdateStatus = props.piUpdateCheck ?? piCliStatus;
	const piUpdateAvailable = Boolean(piUpdateStatus?.hasUpdate);
	const piUpdateNotice = piUpdateAvailable && piUpdateStatus?.latestVersion ? piUpdateStatus : null;
	// 「更新详情」弹窗：只在有更新时出现入口，打开时才拉取 changelog。
	const [piChangelogOpen, setPiChangelogOpen] = useState(false);

	// ── 数据环境（仅 dev 包显示）：当前模式 + 切换入口（改模式需重启生效，规格 §6 设置页修改入口）──
	const isDevChannel = channelInfo?.channel === "dev";
	const [dataEnvInfo, setDataEnvInfo] = useState<DataEnvInfo | null>(null);
	const [dataEnvConfirmOpen, setDataEnvConfirmOpen] = useState(false);
	const [dataEnvSwitchFailed, setDataEnvSwitchFailed] = useState(false);
	useEffect(() => {
		if (!isDevChannel) return;
		let disposed = false;
		void desktopApi.dataEnv
			.getInfo()
			.then((info) => {
				if (!disposed) setDataEnvInfo(info);
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
		};
	}, [isDevChannel]);

	/** 切换到反向数据模式：写决策指针后立即重启（setPath 于下次 ready 前分流生效）。 */
	const handleSwitchDataMode = () => {
		setDataEnvConfirmOpen(false);
		const target = dataEnvInfo?.dataMode === "channel-dev" ? "shared" : "channel-dev";
		void desktopApi.dataEnv
			.chooseMode(target)
			.then((result) => {
				if ("error" in result) {
					setDataEnvSwitchFailed(true);
					return;
				}
				void desktopApi.dataEnv.restart();
			})
			.catch(() => setDataEnvSwitchFailed(true));
	};

	// ── WSL 相关状态（仅 Windows + WSL 开启时拉取）──
	const [wslUserInput, setWslUserInput] = useState(draft.wslUser);
	const [wslDistros, setWslDistros] = useState<string[]>([]);
	const [wslDistrosLoading, setWslDistrosLoading] = useState(false);
	const [wslDistrosAttempted, setWslDistrosAttempted] = useState(false);
	const [wslValidating, setWslValidating] = useState(false);
	const [wslValidation, setWslValidation] = useState<WslConnectionValidation | null>(null);
	// WSL 发行版列表懒加载（仅 Windows + WSL 开启时拉取，无论成败只拉一次）
	useEffect(() => {
		const isWin = props.appInfo.platform === "win32";
		if (isWin && draft.wslEnabled && !wslDistrosAttempted && !wslDistrosLoading && window.piDesktop.wsl) {
			setWslDistrosLoading(true);
			window.piDesktop.wsl
				.listDistros()
				.then((list) => {
					setWslDistros(list);
					setWslDistrosAttempted(true);
				})
				.catch(() => {
					setWslDistros([]);
					setWslDistrosAttempted(true);
				})
				.finally(() => setWslDistrosLoading(false));
		}
	}, [draft.wslEnabled, wslDistrosAttempted, wslDistrosLoading, props.appInfo.platform]);

	const distroOptions: SelectOption[] = wslDistros.length > 0 ? wslDistros.map((d) => ({ value: d, label: d })) : [{ value: draft.wslDistro, label: draft.wslDistro }];

	const handleValidateWslUser = async () => {
		if (!window.piDesktop.wsl) {
			setWslValidation({ ok: false, whoami: "", piVersion: "", piPath: "", error: t("settings.wsl.apiUnavailable") });
			return;
		}
		setWslValidating(true);
		setWslValidation(null);
		try {
			const result = await window.piDesktop.wsl.validateConnection(draft.wslDistro, wslUserInput);
			setWslValidation(result);
			if (result.ok) {
				// 验证通过后，将用户输入写入 draft
				updateDraft({ wslUser: wslUserInput });
			}
		} catch (err) {
			console.error("[Settings] WSL validation failed", err);
			setWslValidation({ ok: false, whoami: "", piVersion: "", piPath: "", error: t("settings.wsl.validationFailed") });
		} finally {
			setWslValidating(false);
		}
	};

	// 壳层「取消」：重置本 tab 局部编辑态（WSL 输入）
	useEffect(() => {
		setWslValidation(null);
		setWslUserInput(draft.wslUser);
	}, [props.resetKey]); // eslint-disable-line react-hooks/exhaustive-deps

	const piSourceOptions: SelectOption[] = [
		{ value: "windows", label: t("settings.piSource.windows") },
		{ value: "wsl", label: t("settings.piSource.wsl") },
	];

	/**
	 * 重新检测：先把 WSL 草稿（来源/发行版/用户名）落盘，否则主进程拿旧配置检测；
	 * 失败（持久化失败）则中止，避免用旧配置给出误导性结果。
	 */
	const handleCheckEnvironment = () => {
		void (async () => {
			if (!(await props.onEnsureWslSettingsSaved())) return;
			props.onCheckPi();
		})();
	};

	return (
		<>
			{/* 环境 */}
			{/* 开发设置 tab 不自动检测 pi：检测结果缓存在 settings.piInstall（打开时直接显示），
          只有用户手动点「检测环境」才重新 spawn 探测（曾因自动检测在打开设置时触发双弹窗）。 */}
			<SettingsSection id="settings-section-dev-environment" title={t("settings.environment")}>
				{/* Pi CLI 状态：安装检测 + 路径信息 + 重新检测 */}
				<div className="setting-pi-status">
					<div className="setting-pi-status-indicator">
						<span className={"pi-status-dot " + (props.piStatus?.installed ? "online" : "offline")} />
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
							{piPath && <span className="setting-path">{piPath}</span>}
							{props.piStatus && !props.piStatus.installed && props.piStatus.error && <span className="setting-status error">{props.piStatus.error}</span>}
						</div>
					</div>
					{/* 检测/重置标记已并入下方「命令来源」面板的头部（同一件事不再有两个入口） */}
					<div className="setting-inline-actions">
						<Button variant="secondary" onClick={props.onCheckPiUpdate} loading={props.piUpdateChecking}>
							{t("settings.checkPiUpdate")}
						</Button>
						<Button variant="secondary" onClick={props.onUpdatePi} loading={props.piUpdating} disabled={!piUpdateAvailable}>
							{t("settings.updatePi")}
						</Button>
					</div>
				</div>
				{/* 后台检查发现的 Pi CLI 更新必须靠近操作按钮，避免提示与入口分属不同分区。 */}
				{piUpdateNotice && (
					<div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-3 py-2 text-caption text-text-primary">
						<span>
							{t("settings.piUpdateAvailableDetail", {
								current: piUpdateNotice.currentVersion ?? t("common.unknown"),
								latest: piUpdateNotice.latestVersion,
							})}
						</span>
						<Button variant="ghost" size="sm" className="shrink-0" onClick={() => setPiChangelogOpen(true)}>
							{t("settings.piUpdateDetails")}
						</Button>
					</div>
				)}
				{piUpdateNotice?.latestVersion && <PiChangelogDialog open={piChangelogOpen} onOpenChange={setPiChangelogOpen} currentVersion={piUpdateNotice.currentVersion} latestVersion={piUpdateNotice.latestVersion} />}
				{props.piUpdateResult && (
					<pre className="setting-update-output">
						{props.piUpdateResult.command}
						{"\n"}
						{props.piUpdateResult.output}
					</pre>
				)}

				{/* Pi 来源：Windows 原生 / WSL（仅 Windows 可见）。
				    分隔线由本块自己带（mt/pt + border-t）：写成独立元素的话，
				    非 Windows 平台会凭空多出一条什么都没有的画线。 */}
				{props.appInfo.platform === "win32" && (
					<div id="settings-section-dev-pi-source" className="setting-pi-source-block mt-3 border-0 border-t border-border-subtle pt-3">
						<div className="setting-pi-source-row">
							<span>{t("settings.piSource.label")}</span>
							<div className="grid gap-1.5">
								<Select
									value={draft.wslEnabled ? "wsl" : "windows"}
									onValueChange={(value) => {
										updateDraft({ wslEnabled: value === "wsl" });
										setWslValidation(null);
									}}
								>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{piSourceOptions.map((option) => (
											<SelectItem key={option.value} value={option.value} disabled={option.disabled}>
												{option.label}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
						{draft.wslEnabled && (
							<div id="settings-section-dev-wsl-config" className="setting-pi-wsl-config">
								<div className="setting-wsl-fields">
									{wslDistros.length > 0 ? (
										<div className="grid min-w-[160px] flex-1 gap-1.5">
											<span className="text-control font-medium text-foreground">{t("settings.wsl.distro")}</span>
											<Select
												value={draft.wslDistro}
												onValueChange={(value) => {
													updateDraft({ wslDistro: value });
													setWslValidation(null);
												}}
											>
												<SelectTrigger className="w-full">
													<SelectValue />
												</SelectTrigger>
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
										<div className="grid min-w-[160px] flex-1 gap-1.5">
											<span className="text-control font-medium text-foreground">{t("settings.wsl.distro")}</span>
											<Input
												type="text"
												value={draft.wslDistro}
												placeholder={"Ubuntu"}
												onChange={(event) => {
													updateDraft({ wslDistro: event.target.value });
													setWslValidation(null);
												}}
											/>
										</div>
									)}
									{wslDistrosLoading && <small className="setting-status info">{t("settings.wsl.detectingDistros")}</small>}
									<div className="setting-wsl-user-row">
										<div className="grid min-w-[160px] flex-1 gap-1.5">
											<span className="text-control font-medium text-foreground">{t("settings.wsl.user")}</span>
											<Input
												type="text"
												value={wslUserInput}
												placeholder={"root"}
												onChange={(event) => {
													setWslUserInput(event.target.value);
													setWslValidation(null);
												}}
											/>
										</div>
										<Button variant="secondary" size="sm" disabled={!wslUserInput.trim() || wslValidating} loading={wslValidating} onClick={handleValidateWslUser}>
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
														distro: draft.wslDistro,
													})}
												</small>
												{wslValidation.piVersion ? (
													<>
														<small className="setting-status success">{t("settings.wsl.piDetected", { version: wslValidation.piVersion })}</small>
														{/* 展示解析到的 Linux 绝对路径：nvm/fnm 场景下用户需要能核对版本目录 */}
														{wslValidation.piPath && <small className="setting-status info">{t("settings.wsl.piPath", { path: wslValidation.piPath })}</small>}
													</>
												) : (
													<small className="setting-status warning">{wslValidation.error || t("settings.wsl.piNotInstalled")}</small>
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

				{/* pi 命令来源：自动检测到的安装 + 用户自己添加的路径，合并成一块（来源只是标签） */}
				<div id="settings-section-dev-pi-installations" className="flex flex-col gap-2 py-2">
					{/* 标题/说明：两块旧设置的职责（选哪个 pi + 手动配路径）现在全在这一块里 */}
					<div className="flex flex-col gap-1">
						<strong className="text-text-primary text-control">{t("settings.piCommandSourceTitle")}</strong>
						<small className="text-text-secondary text-caption leading-relaxed">{t("settings.piCommandSourceDesc")}</small>
					</div>
					<PiCommandSourcePanel
						variant="settings"
						installations={props.piInstallations}
						applyingPath={props.applyingPiInstallationPath}
						onChoose={props.onChoosePiInstallation}
						onAddCustomPath={props.onAddPiCustomPath}
						onUpdateCustomPath={props.onUpdatePiCustomPath}
						onRemoveCustomPath={props.onRemovePiCustomPath}
						onBrowse={props.onBrowsePiPath}
						browsing={props.browsingPiPath}
						onRecheck={handleCheckEnvironment}
						rechecking={props.piChecking}
						onShellProbe={props.onShellProbePiInstallations}
						shellProbing={props.shellProbingPiInstallations}
					/>
				</div>
				{props.appInfo.platform === "win32" && <DshRunnerNodeRow draft={draft} updateDraft={updateDraft} isDirty={isDirty} />}
			</SettingsSection>

			{/* 版本与更新（electron-updater 快照驱动：检测/下载/安装状态一览，语义对齐 Netcatty 设置卡片） */}
			<SettingsSection id="settings-section-dev-updates" title={t("settings.sectionUpdates")}>
				<AppUpdateCard
					appVersion={props.appInfo.version}
					platform={props.appInfo.platform}
					releasesUrl={props.appInfo.releasesUrl}
					channel={channelInfo?.channel ?? "stable"}
					installationType={draft.installationType}
					updateSource={draft.updateSource}
					checking={props.updateChecking}
					onCheckUpdate={props.onCheckUpdate}
					onDownloadUpdate={props.onDownloadUpdate}
					onInstallUpdate={props.onInstallUpdate}
				/>
				{props.appInfo.platform === "darwin" ? (
					<p className="px-0.5 text-caption text-muted-foreground">{t("settings.macManualUpdateDesc")}</p>
				) : updateStatus?.deliveryMode === "manual" ? (
					<p className="px-0.5 text-caption text-muted-foreground">{t(updateStatus.deliveryReason === "linux-arm64" ? "settings.linuxArm64ManualUpdateDesc" : props.appInfo.platform === "linux" ? "settings.linuxPackageManualUpdateDesc" : "settings.manualUpdateDesc")}</p>
				) : (
					<SettingSwitchRow anchor="dev-auto-download-updates" title={t("settings.autoDownloadUpdates")} description={t("settings.autoDownloadUpdatesDesc")} checked={draft.autoDownloadUpdates !== false} onChange={(checked) => updateDraft({ autoDownloadUpdates: checked })} />
				)}
				<UpdateSourceSetting draft={draft} updateDraft={updateDraft} />
			</SettingsSection>

			{/* 数据环境（仅 dev 包）：当前数据模式 + 切换入口（改模式提示需重启） */}
			{isDevChannel && dataEnvInfo && (
				<SettingsSection id="settings-section-dev-data-env" title={t("settings.dataEnvSectionTitle")}>
					<SettingRow
						anchor="dev-data-env-mode"
						title={<span>{t("settings.dataEnvCurrentMode")}</span>}
						// 无决策指针按 shared 语义展示（与主进程「无标记视为 shared」一致）
						description={dataEnvInfo.dataMode === "channel-dev" ? t("dataMode.channelDevTitle") : t("dataMode.sharedTitle")}
					>
						<Button variant="secondary" onClick={() => setDataEnvConfirmOpen(true)}>
							{t("settings.dataEnvSwitchButton")}
						</Button>
					</SettingRow>
					{dataEnvSwitchFailed && <p className="px-0.5 text-caption text-destructive">{t("dataMode.modeChangeFailed")}</p>}
					{dataEnvConfirmOpen && <ConfirmDialog title={t("settings.dataEnvSwitchButton")} message={t("settings.dataEnvSwitchConfirmDesc")} onConfirm={handleSwitchDataMode} onCancel={() => setDataEnvConfirmOpen(false)} />}
				</SettingsSection>
			)}

			{/* 模型目录：内置随版本发布，可从 GitHub 拉取最新覆盖 */}
			<CatalogSection updateSource={draft.updateSource} customUpdateSourceUrl={draft.customUpdateSourceUrl} autoUpdate={draft.catalogAutoUpdate} autoUpdateDirty={isDirty("catalogAutoUpdate")} onAutoUpdateChange={(checked) => updateDraft({ catalogAutoUpdate: checked })} />

			{/* 运行 */}
			<SettingsSection id="settings-section-dev-runtime" title={t("settings.sectionRuntime")}>
				<SettingRow
					anchor="dev-rpc-timeout"
					title={
						<>
							<span>{t("settings.rpcTimeout")}</span>
							<DirtyMarker dirty={isDirty("rpcTimeout")} label={t("settings.rpcTimeout")} />
						</>
					}
					description={t("settings.rpcTimeoutDesc")}
					stacked
				>
					<Input
						type="number"
						className="max-w-80"
						value={String(Math.round(draft.rpcTimeout / 1000))}
						onChange={(e) => {
							const seconds = Math.max(600, parseInt(e.target.value) || 600);
							updateDraft({ rpcTimeout: seconds * 1000 });
						}}
					/>
				</SettingRow>
				<SettingRow
					anchor="dev-max-editor-file-size"
					title={
						<>
							<span>{t("settings.maxEditorFileSize")}</span>
							<DirtyMarker dirty={isDirty("maxEditorFileSizeMB")} label={t("settings.maxEditorFileSize")} />
						</>
					}
					description={t("settings.maxEditorFileSizeDesc")}
					stacked
				>
					<Input
						type="number"
						className="max-w-80"
						value={String(draft.maxEditorFileSizeMB)}
						onChange={(e) => {
							const mb = Math.max(1, parseInt(e.target.value) || 5);
							updateDraft({ maxEditorFileSizeMB: mb });
						}}
					/>
				</SettingRow>
				<SettingSwitchRow anchor="dev-electron-sandbox" title={t("settings.electronSandbox")} description={t("settings.electronSandboxDesc")} checked={draft.electronChromiumSandbox} onChange={(checked) => updateDraft({ electronChromiumSandbox: checked })} />
				{/* id 用于深链：扩展被禁用启动的提示可直达本组启动参数（见 useSettingsFocus） */}
				<div id="settings-section-dev-pi-rpc" className="px-0.5 pb-1 pt-3">
					<span className="text-caption font-semibold tracking-[0.06em] text-muted-foreground">{t("settings.piRpcStartup")}</span>
					<p className="mt-0.5 text-caption text-muted-foreground">{t("settings.piRpcStartupDesc")}</p>
				</div>
				<SettingSwitchRow anchor="dev-pi-rpc-offline" title={t("settings.piRpcOffline")} description={t("settings.piRpcOfflineDesc")} checked={draft.piRpcOffline} onChange={(checked) => updateDraft({ piRpcOffline: checked })} />
				<SettingSwitchRow anchor="dev-pi-rpc-no-extensions" title={t("settings.piRpcNoExtensions")} description={t("settings.piRpcNoExtensionsDesc")} checked={draft.piRpcNoExtensions} onChange={(checked) => updateDraft({ piRpcNoExtensions: checked })} />
				<SettingSwitchRow anchor="dev-pi-rpc-no-skills" title={t("settings.piRpcNoSkills")} description={t("settings.piRpcNoSkillsDesc")} checked={draft.piRpcNoSkills} onChange={(checked) => updateDraft({ piRpcNoSkills: checked })} />
				<SettingSwitchRow anchor="dev-standby-runtime" title={t("settings.standbyRuntimeEnabled")} description={t("settings.standbyRuntimeEnabledDesc")} checked={draft.standbyRuntimeEnabled !== false} onChange={(checked) => updateDraft({ standbyRuntimeEnabled: checked })} />
			</SettingsSection>

			{/* 调试 */}
			<SettingsSection id="settings-section-dev-debug" title={t("settings.debug")}>
				<SettingRow anchor="dev-restart-app" title={<span>{t("settings.restartApp")}</span>} description={t("settings.restartAppDesc")}>
					<Button variant="secondary" onClick={props.onRestartApp}>
						{t("settings.restartAppButton")}
					</Button>
				</SettingRow>
				{/* 「重置检测标记」原在 pi 命令来源面板里，和「重新检测」并排会被当成同一类操作；
				    它实际只影响“下次启动是否重跑一遍首启检测”（一次性开关），所以归到调试区。 */}
				{props.onClearCheckFlag && (
					<SettingRow anchor="dev-clear-pi-check-flag" title={<span>{t("environment.clearCheckFlag")}</span>} description={t("environment.clearCheckFlagHint")}>
						<Button variant="secondary" onClick={props.onClearCheckFlag}>
							{t("settings.toggle")}
						</Button>
					</SettingRow>
				)}
				<SettingRow anchor="dev-devtools" title={<span>{t("settings.devTools")}</span>} description={t("settings.devToolsDesc")}>
					<Button variant="secondary" onClick={props.onToggleDevTools}>
						{t("settings.toggle")}
					</Button>
				</SettingRow>
				<SettingRow
					anchor="dev-open-data-dir"
					title={<span>{t("settings.openDataDir")}</span>}
					description={
						props.appInfo.userDataDir ? (
							// 路径放左列描述位，truncate + tooltip：长路径不换行挤行，hover 可看完整路径
							<code className="block truncate font-mono text-caption text-muted-foreground" title={props.appInfo.userDataDir}>
								{props.appInfo.userDataDir}
							</code>
						) : undefined
					}
				>
					<Button variant="secondary" onClick={() => void desktopApi.app.openDataDir()}>
						{t("settings.openDataDirButton")}
					</Button>
				</SettingRow>
				<DiagnosticsPanel enabled={draft.developerDiagnostics} onChange={(checked) => updateDraft({ developerDiagnostics: checked })} />
			</SettingsSection>

			{/* 隐私 */}
			<SettingsSection id="settings-section-dev-privacy" title={t("settings.privacy")}>
				<SettingSwitchRow anchor="dev-telemetry" title={t("settings.telemetry")} description={t("settings.telemetryDesc")} checked={draft.telemetryEnabled} onChange={(checked) => updateDraft({ telemetryEnabled: checked })} />
			</SettingsSection>
		</>
	);
});
