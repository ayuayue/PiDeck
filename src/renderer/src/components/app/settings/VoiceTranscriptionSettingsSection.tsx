import { useCallback, useEffect, useState } from "react";
import { useSetAtom } from "jotai";
import { DEFAULT_VOICE_TRANSCRIPTION_CONFIG } from "../../../../../shared/voiceTranscriptionConfig";
import type { VoiceTranscriptionPublicConfig } from "../../../../../shared/types/voiceTranscription";
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
 * 语音输入设置区：总开关 + 引擎（云端 / 本地 whisper.cpp）+ 各自配置项。
 *
 * 为什么本地运行时/模型的安装动作与「保存」解耦：下载是即时、耗时的副作用（进度走
 * onRuntimeProgress 事件），不该被一次表单保存绑定；用户点「下载」即刻开始，保存只落
 * 引擎选择、模型 id、设备、语言、自定义路径等纯配置。总开关（enabled）决定输入框是否
 * 出现麦克风按钮，因此也必须随保存写盘。
 */
export function VoiceTranscriptionSettingsSection() {
	const [config, setConfig] = useState<VoiceTranscriptionPublicConfig>(DEFAULT_CONFIG);
	const [apiKey, setApiKey] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [runtime, setRuntime] = useState<WhisperRuntimeStatus>(DEFAULT_RUNTIME_STATUS);
	const [devices, setDevices] = useState<RecordingDevice[]>([]);
	const [progress, setProgress] = useState<WhisperInstallProgress | null>(null);
	const [busyTarget, setBusyTarget] = useState<string | null>(null);
	// 任何配置/运行时变化都自增版本号，让已挂载的输入框即时重探按钮可见性（无需切会话/重启）。
	const bumpVoiceConfig = useSetAtom(voiceConfigRevisionAtom);

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
				if (next.phase === "error") showNotice(next.error || t("voice.settings.error.installFailed"), 5000);
				void refreshRuntime();
			}
		});
	}, [refreshRuntime]);

	const patch = (next: Partial<VoiceTranscriptionPublicConfig>) => setConfig((current) => ({ ...current, ...next }));

	const save = async (clearApiKey = false) => {
		if (saving) return;
		setSaving(true);
		try {
			const result = await desktopApi.voiceTranscription.saveConfig({
				enabled: config.enabled,
				engine: config.engine,
				baseUrl: config.baseUrl,
				model: config.model,
				language: config.language,
				inputDeviceId: config.inputDeviceId,
				localModelId: config.localModelId,
				cliPath: config.cliPath,
				...(!clearApiKey && apiKey.trim() ? { apiKey } : {}),
				...(clearApiKey ? { clearApiKey: true } : {}),
			});
			if (!result.ok) {
				showNotice(t(`voice.settings.error.${result.error}`), 4000);
				return;
			}
			setConfig(result.config);
			setApiKey("");
			bumpVoiceConfig((revision) => revision + 1);
			showNotice(t(clearApiKey ? "voice.settings.keyCleared" : "voice.settings.saved"), 3000);
		} catch {
			showNotice(t("voice.settings.error.saveFailed"), 4000);
		} finally {
			setSaving(false);
		}
	};

	const installRuntime = async () => {
		if (busyTarget) return;
		setBusyTarget("runtime");
		setProgress({ target: "runtime", phase: "downloading", percent: 0 });
		const result = await desktopApi.voiceTranscription.installRuntime().catch(() => ({ ok: false as const, error: "installFailed" }));
		if (!result.ok) {
			setBusyTarget(null);
			setProgress(null);
			showNotice(result.error || t("voice.settings.error.installFailed"), 5000);
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
			showNotice(result.error || t("voice.settings.error.installFailed"), 5000);
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
								{showProgress && progress?.target === "runtime" ? <span className="text-caption text-muted-foreground">{formatProgress(progress)}</span> : null}
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
							{showProgress && progress && progress.target !== "runtime" ? <span className="text-caption text-muted-foreground">{formatProgress(progress)}</span> : null}
						</div>
					</SettingRow>
					<SettingRow title={t("voice.settings.cliPath")} description={t("voice.settings.cliPathDescription")} alignEnd={false} stacked>
						<Input value={config.cliPath} disabled={busy} placeholder={t("voice.settings.cliPathPlaceholder")} onChange={(event) => patch({ cliPath: event.target.value })} />
					</SettingRow>
				</>
			) : (
				<>
					<SettingRow title={t("voice.settings.baseUrl")} alignEnd={false} stacked>
						<Input value={config.baseUrl} disabled={busy} onChange={(event) => patch({ baseUrl: event.target.value })} />
					</SettingRow>
					<SettingRow title={t("voice.settings.apiKey")} alignEnd={false} stacked>
						<Input type="password" value={apiKey} disabled={busy} placeholder={config.hasApiKey ? t("voice.settings.apiKeyConfigured") : t("voice.settings.apiKeyMissing")} autoComplete="off" onChange={(event) => setApiKey(event.target.value)} />
					</SettingRow>
					<SettingRow title={t("voice.settings.model")} alignEnd={false} stacked>
						<Input value={config.model} disabled={busy} onChange={(event) => patch({ model: event.target.value })} />
					</SettingRow>
				</>
			)}

			<SettingRow title={t("voice.settings.language")} description={t("voice.settings.languageDescription")} alignEnd={false} stacked>
				<Input value={config.language} disabled={busy} placeholder={t("voice.settings.languagePlaceholder")} onChange={(event) => patch({ language: event.target.value })} />
			</SettingRow>
			<SettingRow title={t("voice.settings.actions")}>
				<div className="flex items-center gap-2">
					{!isLocal && config.hasApiKey ? (
						<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void save(true)}>
							{t("voice.settings.clearKey")}
						</Button>
					) : null}
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
