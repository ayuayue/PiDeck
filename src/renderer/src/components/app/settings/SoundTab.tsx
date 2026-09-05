import { memo, useEffect, useState } from "react";
import { Play, Upload, Trash2 } from "lucide-react";
import {
	createDefaultSoundAlertSettings,
	DEFAULT_SOUND_BY_KIND,
	SOUND_ALERT_PRESETS,
	parseSoundAlertRef,
	type AppSettings,
	type CustomSoundInfo,
	type SoundAlertKind,
	type SoundAlertSettings,
} from "../../../../../shared/types";
import { t } from "../../../i18n";
import { desktopApi } from "../../../desktopApi";
import { resolveSoundUrl } from "../../../utils/soundUrls";
import { Button } from "../../ui-shadcn/button";
import { Switch } from "../../ui-shadcn/switch";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "../../ui-shadcn/select";
import { SettingsSection } from "./SettingsStorageTab";
import { DirtyMarker, SettingBox, SettingRow, SettingSwitchRow } from "./SettingRows";

type SoundTabProps = {
	draft: AppSettings;
	updateDraft: (patch: Partial<AppSettings>) => void;
	/** 字段级脏检查（与其它 tab 同一 isDirty 回调），驱动标题旁黄点。 */
	isDirty?: (field: keyof AppSettings) => boolean;
};

/** 事件行：启用开关 + 音效下拉 + 试听。 */
function SoundEventRow(props: {
	kind: SoundAlertKind;
	settings: SoundAlertSettings;
	customSounds: CustomSoundInfo[];
	isDirty: (field: keyof AppSettings) => boolean;
	onChange: (config: SoundAlertSettings[SoundAlertKind]) => void;
}) {
	const { kind, settings } = props;
	const config = settings[kind];
	const isDirty = props.isDirty;
	const onChange = props.onChange;
	// 预设 + 自定义合成一个下拉：值分别为 preset id / custom:<file>
	const presetOptions = SOUND_ALERT_PRESETS.map((preset) => ({
		value: preset.id,
		label: t(preset.labelKey as Parameters<typeof t>[0]),
	}));
	const customOptions = props.customSounds.map((sound) => ({
		value: `custom:${sound.name}`,
		label: t("settings.sound.customOption", { name: sound.name }),
	}));
	const preview = () => {
		const url = resolveSoundUrl(config.sound);
		if (!url) return;
		try {
			const audio = new Audio(url);
			audio.volume = Math.min(1, Math.max(0, settings.volume));
			void audio.play().catch(() => undefined);
		} catch {
			// 试听失败（文件被删等）静默
		}
	};
	return (
		<SettingRow
			title={
				<span className="inline-flex items-center gap-1.5">
					<DirtyMarker dirty={isDirty("soundAlert")} label={t(`settings.sound.${kind}`)} />
					{t(`settings.sound.${kind}`)}
				</span>
			}
			description={t(`settings.sound.${kind}Desc`)}
			alignEnd={false}
		>
			<div className="flex w-full items-center gap-2">
				<Switch
					checked={config.enabled}
					disabled={!settings.enabled}
					aria-label={t(`settings.sound.${kind}Enable`)}
					onCheckedChange={(value) => onChange({ ...config, enabled: value })}
				/>
				<Select
					value={config.sound}
					disabled={!settings.enabled || !config.enabled}
					onValueChange={(value) => onChange({ ...config, sound: value })}
				>
					<SelectTrigger className="h-9 min-w-0 flex-1" aria-label={t(`settings.sound.${kind}`)}>
						<SelectValue placeholder={t("settings.sound.choose")} />
					</SelectTrigger>
					<SelectContent>
						<SelectGroup>
							<SelectLabel>{t("settings.sound.presetGroup")}</SelectLabel>
							{presetOptions.map((option) => (
								<SelectItem key={option.value} value={option.value}>
									{option.label}
								</SelectItem>
							))}
						</SelectGroup>
						{customOptions.length > 0 && (
							<SelectGroup>
								<SelectLabel>{t("settings.sound.customGroup")}</SelectLabel>
								{customOptions.map((option) => (
									<SelectItem key={option.value} value={option.value}>
										{option.label}
									</SelectItem>
								))}
							</SelectGroup>
						)}
					</SelectContent>
				</Select>
				<Button
					variant="outline"
					size="icon-sm"
					title={t("settings.sound.preview")}
					aria-label={t("settings.sound.preview")}
					onClick={preview}
				>
					<Play className="size-4" />
				</Button>
			</div>
		</SettingRow>
	);
}

/**
 * 设置弹框「声音提醒」tab：总开关 / 音量 / 三事件（完成/出错/等待输入）各自
 * 选音效（预设 + 自定义导入）+ 试听；自定义音频独立管理（导入/删除）。
 * 音效引用格式（预设 id / custom:<file>）与 shared/types/soundAlert.ts 一致。
 */
export const SoundTab = memo(function SoundTab(props: SoundTabProps) {
	const { draft, updateDraft } = props;
	const isDirty = props.isDirty ?? (() => false);
	// 防御：旧缓存 settings 可能缺 soundAlert（主进程加载时会归一化，渲染层草稿兜底）
	const settings: SoundAlertSettings = draft.soundAlert ?? createDefaultSoundAlertSettings();
	const [customSounds, setCustomSounds] = useState<CustomSoundInfo[]>([]);
	const [importing, setImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);

	// 进入本 tab 拉取自定义音频列表
	useEffect(() => {
		let alive = true;
		void desktopApi.sounds.listCustom().then((list) => {
			if (alive) setCustomSounds(list);
		}).catch(() => undefined);
		return () => { alive = false; };
	}, []);

	const updateSound = (patch: Partial<SoundAlertSettings>) =>
		updateDraft({ soundAlert: { ...settings, ...patch } });

	const updateEvent = (kind: SoundAlertKind, config: SoundAlertSettings[SoundAlertKind]) =>
		updateSound({ [kind]: config });

	const onImport = async () => {
		setImporting(true);
		setImportError(null);
		try {
			const result = await desktopApi.sounds.importCustom();
			if (result.ok) {
				setCustomSounds((prev) => [...prev, result.info].sort((a, b) => a.name.localeCompare(b.name)));
			} else if (result.error !== "canceled") {
				setImportError(t(`settings.sound.importError.${result.error}` as Parameters<typeof t>[0]));
			}
		} finally {
			setImporting(false);
		}
	};

	const onRemove = async (name: string) => {
		const removed = await desktopApi.sounds.removeCustom(name).catch(() => false);
		if (!removed) return;
		setCustomSounds((prev) => prev.filter((sound) => sound.name !== name));
		// 正在使用被删文件的事件回落到默认预设，避免下次播放 404
		const next: SoundAlertSettings = { ...settings };
		for (const kind of ["done", "error", "waiting"] as const) {
			const ref = parseSoundAlertRef(next[kind].sound);
			if (ref?.kind === "custom" && ref.file === name) {
				// 回落到该事件的默认预设（不是空串：下拉 value 必须是合法选项，空串会失去选中态）
				next[kind] = { ...next[kind], sound: DEFAULT_SOUND_BY_KIND[kind] };
			}
		}
		updateSound(next);
	};

	return (
		<>
			<SettingsSection title={t("settings.sound.title")} description={t("settings.sound.sectionDesc")}>
				<SettingSwitchRow
					title={t("settings.sound.enabled")}
					description={t("settings.sound.enabledDesc")}
					checked={settings.enabled}
					dirty={isDirty("soundAlert")}
					onChange={(value) => updateSound({ enabled: value })}
				/>
				<SettingRow
					title={
						<span className="inline-flex items-center gap-1.5">
							<DirtyMarker dirty={isDirty("soundAlert")} label={t("settings.sound.volume")} />
							{t("settings.sound.volume")}
						</span>
					}
					description={t("settings.sound.volumeDesc")}
				>
					<div className="flex w-full items-center gap-3">
						<input
							type="range"
							min="0"
							max="100"
							step="1"
							value={Math.round(settings.volume * 100)}
							onChange={(event) => updateSound({ volume: Number(event.target.value) / 100 })}
							className="min-w-0 flex-1 accent-[var(--color-accent)]"
							aria-label={t("settings.sound.volume")}
						/>
						<span className="min-w-12 shrink-0 text-right font-brand text-sm text-muted-foreground tabular-nums">
							{Math.round(settings.volume * 100)}%
						</span>
					</div>
				</SettingRow>
			</SettingsSection>

			<SettingsSection title={t("settings.sound.eventsTitle")} description={t("settings.sound.eventsDesc")}>
				<SettingBox>
					{(["done", "error", "waiting"] as const).map((kind) => (
						<SoundEventRow
							key={kind}
							kind={kind}
							settings={settings}
							customSounds={customSounds}
							isDirty={isDirty}
							onChange={(config) => updateEvent(kind, config)}
						/>
					))}
				</SettingBox>
			</SettingsSection>

			<SettingsSection title={t("settings.sound.customTitle")} description={t("settings.sound.customDesc")}>
				<SettingRow
					title={t("settings.sound.import")}
					description={t("settings.sound.importDesc")}
				>
					<div className="flex items-center gap-2">
						{importError && (
							<span className="text-xs text-destructive">{importError}</span>
						)}
						<Button
							variant="outline"
							size="sm"
							disabled={importing}
							onClick={() => void onImport()}
						>
							<Upload className="size-4" />
							{importing ? t("settings.sound.importing") : t("settings.sound.import")}
						</Button>
					</div>
				</SettingRow>
				{customSounds.map((sound) => (
					<SettingRow
						key={sound.name}
						title={<span className="font-mono text-[13px]">{sound.name}</span>}
						description={`${(sound.size / 1024).toFixed(0)} KB`}
					>
						<Button
							variant="ghost"
							size="icon-sm"
							title={t("settings.sound.remove")}
							aria-label={t("settings.sound.remove")}
							onClick={() => void onRemove(sound.name)}
						>
							<Trash2 className="size-4" />
						</Button>
					</SettingRow>
				))}
				{customSounds.length === 0 && (
					<SettingRow title={t("settings.sound.noCustom")} description={t("settings.sound.noCustomDesc")}>
						<span />
					</SettingRow>
				)}
			</SettingsSection>
		</>
	);
});
