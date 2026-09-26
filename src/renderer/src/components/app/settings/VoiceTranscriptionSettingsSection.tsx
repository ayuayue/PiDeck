import { useCallback, useEffect, useRef, useState } from "react";
import { useSetAtom } from "jotai";
import { DEFAULT_VOICE_TRANSCRIPTION_CONFIG, VOLC_ENGINE_DEFAULT_RESOURCE_ID, VOLC_SUPPORTED_RESOURCE_IDS } from "../../../../../shared/voiceTranscriptionConfig";
import { formatBytes } from "../../../../../shared/formatBytes";
import type { VoiceTranscriptionPublicConfig, VoiceTranscriptionTestResult } from "../../../../../shared/types/voiceTranscription";
import { getWhisperModelDef, WHISPER_MODEL_CATALOG, type WhisperInstallProgress, type WhisperRuntimeStatus } from "../../../../../shared/types/whisperRuntime";
import { voiceConfigRevisionAtom } from "../../../atoms";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { showNotice } from "../../../utils/notice";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { SettingRow, SettingSwitchRow } from "./SettingRows";

const DEFAULT_CONFIG: VoiceTranscriptionPublicConfig = {
	...DEFAULT_VOICE_TRANSCRIPTION_CONFIG,
	hasApiKey: false,
	hasVolcAppId: false,
	hasVolcAccessToken: false,
	runtimeReady: false,
};

const DEFAULT_RUNTIME_STATUS: WhisperRuntimeStatus = {
	autoRuntimeSupported: false,
	cliReady: false,
	cliSource: "none",
	cliPath: null,
	runtimeVersion: null,
	models: [],
};

type RecordingDevice = { deviceId: string; label: string };

/**
 * 资源 ID → 展示名。清单来自 shared（只有客户端真正实现了的协议才出现在这里），
 * 设置页因此不再给自由文本：填错一个字符就是服务端 45000001「参数无效」，用户完全无从下手。
 */
const VOLC_RESOURCE_ID_LABELS: Record<(typeof VOLC_SUPPORTED_RESOURCE_IDS)[number], "voice.settings.cloudResourceIdTurbo"> = {
	[VOLC_ENGINE_DEFAULT_RESOURCE_ID]: "voice.settings.cloudResourceIdTurbo",
};

/** 三个密钥输入框的名字：与主进程 saveConfig 的密钥字段同名，提交即清空对应草稿。 */
type SecretField = "apiKey" | "volcAppId" | "volcAccessToken";

/** 自动保存防抖：够短，用户感觉是「立刻存了」；够长，一次下拉/连续输入只写一次盘。 */
const AUTO_SAVE_DELAY_MS = 400;

/**
 * 安装失败码的展示文案：中止 / 并发这类已知码走 i18n，未知码原样带出
 * （size-mismatch、sha256-mismatch 这类信息对定位镜像问题是线索，不要翻译成空泛提示）。
 */
function installErrorCopy(error?: string): string {
	if (error === "cancelled") return t("voice.settings.error.cancelled");
	if (error === "already-installing") return t("voice.settings.error.alreadyInstalling");
	return error || t("voice.settings.error.installFailed");
}

/** 检测结果的文案：错误码复用录音失败那套话术，豆包的业务码追加在后面。 */
function testCopy(result: VoiceTranscriptionTestResult | null): string {
	if (!result) return t("voice.settings.test.unexpected");
	if (result.ok) return t("voice.settings.test.ok");
	const base = t(`voice.error.${result.error}`);
	const statusCode = result.detail?.statusCode;
	if (!statusCode) return base;
	// 「未开通极速版 / 额度用尽」官方没有专用码，只会落到 http 或参数无效，故补一句排查方向。
	const hint = result.error === "http" || result.error === "invalidRequest" ? ` ${t("voice.settings.test.volcHint")}` : "";
	return `${base}（${statusCode}）${hint}`;
}

/** 下载中止入口：只在有安装任务在跑时出现（主进程 abortInstall 中止当前那一个）。 */
function InstallCancelButton() {
	return (
		<Button type="button" variant="outline" size="sm" onClick={() => void desktopApi.voiceTranscription.abortInstall().catch(() => undefined)}>
			{t("voice.settings.installCancel")}
		</Button>
	);
}

/**
 * 未完成下载的提示：断点字节数由主进程 stat 得到，所以关掉设置页、甚至重启应用之后
 * 用户仍然看得到「已经下了多少」，而不是以为一切归零。
 */
function PartialDownloadHint({ status }: { status?: WhisperRuntimeStatus["models"][number] }) {
	const partial = status && !status.installed ? (status.partialBytes ?? 0) : 0;
	if (partial <= 0) return null;
	return <span className="text-caption text-muted-foreground">{t("voice.settings.modelPartial", { size: formatBytes(partial) })}</span>;
}

/**
 * 语音输入设置区：总开关 + 引擎（云端 / 本地 whisper.cpp）+ 各自配置项。
 *
 * 配置项改动即自动保存（防抖），不依赖用户记得点「保存」：这个分区嵌在通用设置里，
 * 切换标签会卸载本组件，手动保存模式下用户改完切走就静默丢失。
 *
 * 为什么本地运行时/模型的安装动作仍与保存解耦：下载是即时、耗时的副作用（进度走
 * onRuntimeProgress 事件），不该被一次表单保存绑定；用户点「下载」即刻开始。
 */
export function VoiceTranscriptionSettingsSection() {
	const [config, setConfig] = useState<VoiceTranscriptionPublicConfig>(DEFAULT_CONFIG);
	const [apiKey, setApiKey] = useState("");
	const [volcAppId, setVolcAppId] = useState("");
	const [volcAccessToken, setVolcAccessToken] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [testing, setTesting] = useState(false);
	const [runtime, setRuntime] = useState<WhisperRuntimeStatus>(DEFAULT_RUNTIME_STATUS);
	const [devices, setDevices] = useState<RecordingDevice[]>([]);
	const [progress, setProgress] = useState<WhisperInstallProgress | null>(null);
	const [busyTarget, setBusyTarget] = useState<string | null>(null);
	// 任何配置/运行时变化都自增版本号，让已挂载的输入框即时重探按钮可见性（无需切会话/重启）。
	const bumpVoiceConfig = useSetAtom(voiceConfigRevisionAtom);
	// 自动保存：设置页的每一项改动都必须落盘，否则切换标签/关闭弹框就把用户改的一堆选项丢了
	// （历史上这里只有手动「保存」，切走即丢）。configRef 供定时器与卸载 flush 取最新快照。
	const configRef = useRef(config);
	const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		configRef.current = config;
	}, [config]);

	const refreshRuntime = useCallback(() => {
		return desktopApi.voiceTranscription
			.runtimeStatus()
			.then((status) => {
				setRuntime(status);
				bumpVoiceConfig((revision) => revision + 1);
			})
			.catch(() => undefined);
	}, [bumpVoiceConfig]);

	useEffect(() => {
		let active = true;
		void desktopApi.voiceTranscription
			.getConfig()
			.then((next) => {
				if (active) setConfig(next);
			})
			.catch(() => {
				if (active) showNotice(t("voice.settings.loadFailed"), 4000);
			})
			.finally(() => {
				if (active) setLoading(false);
			});
		refreshRuntime();
		return () => {
			active = false;
		};
	}, [refreshRuntime]);

	// 枚举录音设备：labels 在授予麦克风权限前可能为空，用 deviceId 兜底显示。
	// devicechange 让插拔耳机/麦克风后无需重开设置即可刷新。
	useEffect(() => {
		let active = true;
		const mediaDevices = navigator.mediaDevices;
		const list = () => {
			if (!mediaDevices?.enumerateDevices) return;
			void mediaDevices
				.enumerateDevices()
				.then((infos) => {
					if (!active) return;
					const inputs = infos.filter((info) => info.kind === "audioinput").map((info, index) => ({ deviceId: info.deviceId, label: info.label || `${t("voice.settings.device")} ${index + 1}` }));
					setDevices(inputs);
				})
				.catch(() => undefined);
		};
		list();
		mediaDevices?.addEventListener?.("devicechange", list);
		return () => {
			active = false;
			mediaDevices?.removeEventListener?.("devicechange", list);
		};
	}, []);

	// 安装进度：runtime 与 model 共用一条推送通道，卸载即退订。
	useEffect(() => {
		return desktopApi.voiceTranscription.onRuntimeProgress((next) => {
			setProgress(next);
			if (next.phase === "done" || next.phase === "error") {
				setBusyTarget(null);
				if (next.phase === "error") showNotice(installErrorCopy(next.error), 5000);
				void refreshRuntime();
			}
		});
	}, [refreshRuntime]);

	const patch = (next: Partial<VoiceTranscriptionPublicConfig>) => {
		setConfig((current) => ({ ...current, ...next }));
		scheduleAutoSave();
	};

	/**
	 * 落一次盘。自动保存与显式保存共用同一条路径，区别只在是否置 `saving`（自动保存不该
	 * 让整页控件瞬间禁用）与是否弹「已保存」。密钥草稿只在失焦/点保存时提交，
	 * 提交成功即清空对应输入框——密文不回显，占位符「已配置」是它唯一的可见反馈。
	 */
	const persist = useCallback(
		async (next: VoiceTranscriptionPublicConfig, secrets: Partial<Record<SecretField, string>> = {}, clearApiKey = false): Promise<boolean> => {
			const trimmed: Partial<Record<SecretField, string>> = {};
			for (const [field, value] of Object.entries(secrets)) {
				if (value?.trim()) trimmed[field as SecretField] = value;
			}
			const result = await desktopApi.voiceTranscription
				.saveConfig({
					enabled: next.enabled,
					engine: next.engine,
					cloudProvider: next.cloudProvider,
					baseUrl: next.baseUrl,
					model: next.model,
					language: next.language,
					inputDeviceId: next.inputDeviceId,
					localModelId: next.localModelId,
					cliPath: next.cliPath,
					cloudResourceId: next.cloudResourceId,
					...trimmed,
					...(clearApiKey ? { clearApiKey: true } : {}),
				})
				.catch(() => null);
			if (!result || !result.ok) {
				showNotice(result ? t(`voice.settings.error.${result.error}`) : t("voice.settings.error.saveFailed"), 4000);
				return false;
			}
			// 期间用户又改了别的项：以本地为准，等下一次防抖保存，不要用旧响应覆盖新输入。
			if (configRef.current === next) setConfig(result.config);
			const setters: Record<SecretField, (value: string) => void> = { apiKey: setApiKey, volcAppId: setVolcAppId, volcAccessToken: setVolcAccessToken };
			for (const field of Object.keys(trimmed) as SecretField[]) setters[field]("");
			if (clearApiKey) Object.values(setters).forEach((setter) => setter(""));
			bumpVoiceConfig((revision) => revision + 1);
			return true;
		},
		[bumpVoiceConfig],
	);

	const scheduleAutoSave = () => {
		if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
		autoSaveTimer.current = setTimeout(() => {
			autoSaveTimer.current = null;
			void persist(configRef.current);
		}, AUTO_SAVE_DELAY_MS);
	};

	/** 当前服务商的密钥草稿；另一家的输入框即使还留着字也不该顺手写盘。 */
	const currentSecretDrafts = (): Partial<Record<SecretField, string>> => (configRef.current.engine === "local" ? {} : configRef.current.cloudProvider === "volcengine" ? { volcAppId, volcAccessToken } : { apiKey });

	const save = async (clearApiKey = false) => {
		if (saving) return;
		if (autoSaveTimer.current) {
			clearTimeout(autoSaveTimer.current);
			autoSaveTimer.current = null;
		}
		setSaving(true);
		try {
			const ok = await persist(configRef.current, clearApiKey ? {} : currentSecretDrafts(), clearApiKey);
			if (ok) showNotice(t(clearApiKey ? "voice.settings.keyCleared" : "voice.settings.saved"), 3000);
		} finally {
			setSaving(false);
		}
	};

	/**
	 * 检测连通性：先把待提交的密钥草稿与配置落盘（否则检测的是磁盘上的旧值），再让主进程
	 * 用一段静音走一遍真实链路。判据是「服务受理了音频」，所以空结果也算通过。
	 */
	const runTest = async () => {
		if (testing) return;
		if (autoSaveTimer.current) {
			clearTimeout(autoSaveTimer.current);
			autoSaveTimer.current = null;
		}
		setTesting(true);
		try {
			// 保存失败（例如地址/模型不合法）时不要再去探测：那时磁盘上的配置还是旧的。
			if (!(await persist(configRef.current, currentSecretDrafts()))) return;
			const result: VoiceTranscriptionTestResult | null = await desktopApi.voiceTranscription.test().catch(() => null);
			showNotice(testCopy(result), 5000);
		} finally {
			setTesting(false);
		}
	};

	// 卸载（切换设置标签、关闭弹框）时把还在防抖里的最后一次改动立刻写盘，
	// 否则「刚改完就切走」还是会丢——这正是这次要根治的体验问题。
	useEffect(
		() => () => {
			if (!autoSaveTimer.current) return;
			clearTimeout(autoSaveTimer.current);
			autoSaveTimer.current = null;
			void persist(configRef.current);
		},
		[persist],
	);

	const installRuntime = async () => {
		if (busyTarget) return;
		setBusyTarget("runtime");
		setProgress({ target: "runtime", phase: "downloading", percent: 0 });
		const result = await desktopApi.voiceTranscription.installRuntime().catch(() => ({ ok: false as const, error: "installFailed" }));
		if (!result.ok) {
			setBusyTarget(null);
			setProgress(null);
			// 中止的播报已经来自进度推送，这里再弹一次会变成两条相同 toast。
			if (result.error !== "cancelled") showNotice(installErrorCopy(result.error), 5000);
			return;
		}
		void refreshRuntime();
	};

	const installModel = async (modelId: string) => {
		if (busyTarget) return;
		setBusyTarget(modelId);
		setProgress({ target: modelId as WhisperInstallProgress["target"], phase: "downloading", percent: 0 });
		const result = await desktopApi.voiceTranscription.installModel(modelId).catch(() => ({ ok: false as const, error: "installFailed" }));
		if (!result.ok) {
			setBusyTarget(null);
			setProgress(null);
			// 中止的播报已经来自进度推送，这里再弹一次会变成两条相同 toast。
			if (result.error !== "cancelled") showNotice(installErrorCopy(result.error), 5000);
			return;
		}
		void refreshRuntime();
	};

	const deleteModel = async (modelId: string) => {
		if (busyTarget) return;
		setBusyTarget(modelId);
		const result = await desktopApi.voiceTranscription.deleteModel(modelId).catch(() => ({ ok: false as const, error: "installFailed" }));
		setBusyTarget(null);
		if (!result.ok) {
			showNotice(result.error || t("voice.settings.error.installFailed"), 5000);
			return;
		}
		void refreshRuntime();
	};

	const isLocal = config.engine === "local";
	const isVolc = config.cloudProvider === "volcengine";
	const hasCloudKey = isVolc ? config.hasVolcAppId || config.hasVolcAccessToken : config.hasApiKey;
	const selectedModel = getWhisperModelDef(config.localModelId);
	const selectedModelStatus = runtime.models.find((model) => model.id === config.localModelId);
	const busy = loading || saving;
	const showProgress = progress && (busyTarget === progress.target || (progress.target === "runtime" && busyTarget === "runtime"));

	return (
		<SettingsSection title={t("voice.settings.title")} description={t("voice.settings.description")}>
			<SettingSwitchRow title={t("voice.settings.enabled")} description={t("voice.settings.enabledDescription")} checked={config.enabled} disabled={busy} onChange={(checked) => patch({ enabled: checked })} />
			<SettingRow title={t("voice.settings.engine")} alignEnd={false}>
				<Select value={config.engine} disabled={busy} onValueChange={(value) => patch({ engine: value === "local" ? "local" : "cloud" })}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="cloud">{t("voice.settings.engineCloud")}</SelectItem>
						<SelectItem value="local">{t("voice.settings.engineLocal")}</SelectItem>
					</SelectContent>
				</Select>
			</SettingRow>
			<SettingRow title={t("voice.settings.device")} description={t("voice.settings.deviceDescription")} alignEnd={false}>
				<Select value={config.inputDeviceId || "__default__"} disabled={busy} onValueChange={(value) => patch({ inputDeviceId: value === "__default__" ? "" : value })}>
					<SelectTrigger className="w-full">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="__default__">{t("voice.settings.deviceDefault")}</SelectItem>
						{devices.map((device) => (
							<SelectItem key={device.deviceId} value={device.deviceId}>
								{device.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SettingRow>

			{isLocal ? (
				<>
					<SettingRow title={t("voice.settings.runtime")} description={runtime.cliReady ? t("voice.settings.runtimeReady") : t("voice.settings.runtimeMissing")} alignEnd={false}>
						{runtime.cliReady ? (
							<span className="text-caption text-muted-foreground">{runtime.cliSource === "custom" ? t("voice.settings.runtimeSourceCustom") : `${t("voice.settings.runtimeSourceAuto")} · ${runtime.runtimeVersion ?? ""}`}</span>
						) : runtime.autoRuntimeSupported ? (
							<div className="flex w-full items-center gap-2">
								<Button type="button" size="sm" loading={busyTarget === "runtime"} disabled={busy || Boolean(busyTarget)} onClick={() => void installRuntime()}>
									{t("voice.settings.runtimeDownload")}
								</Button>
								{showProgress && progress?.target === "runtime" ? (
									<div className="flex items-center gap-2">
										<span className="text-caption text-muted-foreground">{formatProgress(progress)}</span>
										<InstallCancelButton />
									</div>
								) : null}
							</div>
						) : (
							<span className="text-caption text-muted-foreground">{t("voice.settings.runtimeUnsupported")}</span>
						)}
					</SettingRow>
					<SettingRow title={t("voice.settings.model")} description={t("voice.settings.modelDescription")} alignEnd={false}>
						<Select value={config.localModelId} disabled={busy} onValueChange={(value) => patch({ localModelId: value as VoiceTranscriptionPublicConfig["localModelId"] })}>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{WHISPER_MODEL_CATALOG.map((model) => (
									<SelectItem key={model.id} value={model.id}>
										{model.label}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					</SettingRow>
					<SettingRow title={selectedModel ? t("voice.settings.modelFile", { model: selectedModel.label }) : t("voice.settings.model")} alignEnd={false}>
						<div className="flex items-center gap-2">
							{selectedModelStatus?.installed ? (
								<>
									<span className="text-caption text-muted-foreground">{t("voice.settings.modelInstalled")}</span>
									<Button type="button" variant="outline" size="sm" disabled={busy || Boolean(busyTarget)} onClick={() => void deleteModel(config.localModelId)}>
										{t("voice.settings.modelDelete")}
									</Button>
								</>
							) : (
								<Button type="button" size="sm" loading={busyTarget === config.localModelId} disabled={busy || Boolean(busyTarget)} onClick={() => void installModel(config.localModelId)}>
									{t("voice.settings.modelDownload")}
								</Button>
							)}
							{showProgress && progress && progress.target !== "runtime" ? (
								<div className="flex items-center gap-2">
									<span className="text-caption text-muted-foreground">{formatProgress(progress)}</span>
									<InstallCancelButton />
								</div>
							) : (
								<PartialDownloadHint status={selectedModelStatus} />
							)}
						</div>
					</SettingRow>
					<SettingRow title={t("voice.settings.cliPath")} description={t("voice.settings.cliPathDescription")} alignEnd={false} stacked>
						<Input value={config.cliPath} disabled={busy} placeholder={t("voice.settings.cliPathPlaceholder")} onChange={(event) => patch({ cliPath: event.target.value })} />
					</SettingRow>
				</>
			) : (
				<>
					<SettingRow title={t("voice.settings.cloudProvider")} description={t("voice.settings.cloudProviderDescription")} alignEnd={false}>
						<Select value={config.cloudProvider} disabled={busy} onValueChange={(value) => patch({ cloudProvider: value === "volcengine" ? "volcengine" : "openai" })}>
							<SelectTrigger className="w-full">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="openai">{t("voice.settings.cloudProviderOpenai")}</SelectItem>
								<SelectItem value="volcengine">{t("voice.settings.cloudProviderVolc")}</SelectItem>
							</SelectContent>
						</Select>
					</SettingRow>
					{isVolc ? (
						<>
							<SettingRow title={t("voice.settings.volcAppId")} description={t("voice.settings.volcAppIdDescription")} alignEnd={false} stacked>
								<Input
									type="password"
									value={volcAppId}
									disabled={busy}
									placeholder={config.hasVolcAppId ? t("voice.settings.apiKeyConfigured") : t("voice.settings.apiKeyMissing")}
									autoComplete="off"
									onChange={(event) => setVolcAppId(event.target.value)}
									// 密钥不跟着每次按键落盘（半截 key 写进配置更难排查），失焦才提交。
									onBlur={() => {
										if (volcAppId.trim()) void persist(configRef.current, { volcAppId });
									}}
								/>
							</SettingRow>
							<SettingRow title={t("voice.settings.volcAccessToken")} description={t("voice.settings.volcAccessTokenDescription")} alignEnd={false} stacked>
								<Input
									type="password"
									value={volcAccessToken}
									disabled={busy}
									placeholder={config.hasVolcAccessToken ? t("voice.settings.apiKeyConfigured") : t("voice.settings.apiKeyMissing")}
									autoComplete="off"
									onChange={(event) => setVolcAccessToken(event.target.value)}
									onBlur={() => {
										if (volcAccessToken.trim()) void persist(configRef.current, { volcAccessToken });
									}}
								/>
							</SettingRow>
							<SettingRow title={t("voice.settings.cloudResourceId")} description={t("voice.settings.cloudResourceIdDescription")} alignEnd={false}>
								<Select value={config.cloudResourceId} disabled={busy} onValueChange={(value) => patch({ cloudResourceId: value })}>
									<SelectTrigger className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{VOLC_SUPPORTED_RESOURCE_IDS.map((resourceId) => (
											<SelectItem key={resourceId} value={resourceId}>
												{t(VOLC_RESOURCE_ID_LABELS[resourceId])} · {resourceId}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</SettingRow>
						</>
					) : (
						<>
							<SettingRow title={t("voice.settings.baseUrl")} alignEnd={false} stacked>
								<Input value={config.baseUrl} disabled={busy} onChange={(event) => patch({ baseUrl: event.target.value })} />
							</SettingRow>
							<SettingRow title={t("voice.settings.apiKey")} description={t("voice.settings.apiKeyAutoSaveHint")} alignEnd={false} stacked>
								<Input
									type="password"
									value={apiKey}
									disabled={busy}
									placeholder={config.hasApiKey ? t("voice.settings.apiKeyConfigured") : t("voice.settings.apiKeyMissing")}
									autoComplete="off"
									onChange={(event) => setApiKey(event.target.value)}
									onBlur={() => {
										if (apiKey.trim()) void persist(configRef.current, { apiKey });
									}}
								/>
							</SettingRow>
							<SettingRow title={t("voice.settings.model")} alignEnd={false} stacked>
								<Input value={config.model} disabled={busy} onChange={(event) => patch({ model: event.target.value })} />
							</SettingRow>
						</>
					)}
				</>
			)}

			<SettingRow title={t("voice.settings.language")} description={t("voice.settings.languageDescription")} alignEnd={false} stacked>
				<Input value={config.language} disabled={busy} placeholder={t("voice.settings.languagePlaceholder")} onChange={(event) => patch({ language: event.target.value })} />
			</SettingRow>
			<SettingRow title={t("voice.settings.actions")} description={t("voice.settings.autoSaveHint")}>
				<div className="flex items-center gap-2">
					{!isLocal && hasCloudKey ? (
						<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void save(true)}>
							{t("voice.settings.clearKey")}
						</Button>
					) : null}
					{/* 检测会发一次真实请求（约 0.4 秒静音）；凭据不全时主进程直接回 notConfigured，不浪费额度。 */}
					<Button type="button" variant="outline" size="sm" loading={testing} disabled={busy || saving} onClick={() => void runTest()}>
						{t("voice.settings.test")}
					</Button>
					<Button type="button" size="sm" loading={saving} disabled={busy} onClick={() => void save(false)}>
						{t("voice.settings.save")}
					</Button>
				</div>
			</SettingRow>
		</SettingsSection>
	);
}

/** 安装进度文案：下载中显示百分比与阶段，校验/安装阶段只显阶段。 */
function formatProgress(progress: WhisperInstallProgress): string {
	if (progress.phase === "downloading") return `${Math.round(progress.percent)}%`;
	return t(`voice.settings.phase.${progress.phase}`);
}
