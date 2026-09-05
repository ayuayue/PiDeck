/**
 * 声音提醒（Sound Alert）共享契约。
 *
 * 触发链路：主进程 SoundAlertService 根据 Agent 状态边沿（完成/出错/等待输入）产生事件，
 * 经 `sounds:play` 推送给渲染层播放；本文件只定义事件形状、设置结构与预设目录，
 * 不含任何 Electron / Node 依赖（设置归一化与引用解析可被单测直接加载）。
 */

/** 提醒事件类别：done=会话完成、error=会话异常、waiting=Agent 等待用户输入。 */
export type SoundAlertKind = "done" | "error" | "waiting";

/** 内置预设音效 id（文件名与之一一对应，见 scripts/gen-sound-presets.mjs）。 */
export type SoundAlertPresetId =
	| "done-chime"
	| "done-bell"
	| "done-pop"
	| "error-buzz"
	| "error-alert"
	| "waiting-ping"
	| "waiting-knock";

/** 单个事件的声音配置：enabled + 音效引用（预设 id 或 `custom:<文件名>`）。 */
export type SoundAlertEventConfig = {
	/** 该事件是否播放声音，默认 true（waiting 默认 false，避免提问刷屏）。 */
	enabled: boolean;
	/**
	 * 音效引用：预设 id（如 "done-chime"）或 `custom:<userData/sounds/ 下的文件名>`。
	 * 空串 = 使用该事件的默认预设。旧数据/非法值由 normalizeSoundAlertSettings 兜底。
	 */
	sound: string;
};

/** AppSettings.soundAlert 的完整形状（默认值见 DEFAULT_SOUND_ALERT_SETTINGS）。 */
export type SoundAlertSettings = {
	/** 总开关，默认 true。 */
	enabled: boolean;
	/** 音量 0–1，默认 0.6；渲染层播放时钳制到该区间。 */
	volume: number;
	done: SoundAlertEventConfig;
	error: SoundAlertEventConfig;
	waiting: SoundAlertEventConfig;
};

/** 主进程 → 渲染层的声音播放事件（sounds:play 通道 payload）。 */
export type SoundAlertPlayEvent = {
	kind: SoundAlertKind;
	/** 会话标题（供未来扩展展示；当前播放不依赖它）。 */
	title: string;
	/** 音效引用，与 SoundAlertEventConfig.sound 同格式。 */
	soundId: string;
	/** 音量 0–1（已按设置钳制）。 */
	volume: number;
};

/** 自定义音频文件元数据（userData/sounds/ 目录扫描结果）。 */
export type CustomSoundInfo = {
	/** 文件名（含扩展名），设置中引用为 `custom:<name>`。 */
	name: string;
	/** 文件大小（字节）。 */
	size: number;
};

/** 自定义音频导入结果：ok=false 时 error 为渲染层可映射的稳定错误码。 */
export type SoundImportResult =
	| { ok: true; info: CustomSoundInfo }
	| { ok: false; error: "canceled" | "invalidType" | "tooLarge" | "readFailed" };

/** 每个事件的默认预设（config.sound 为空时的兜底）。 */
export const DEFAULT_SOUND_BY_KIND: Record<SoundAlertKind, SoundAlertPresetId> = {
	done: "done-chime",
	error: "error-buzz",
	waiting: "waiting-ping",
};

/** 预设目录（渲染层据此渲染下拉选项，labelKey 走 i18n）。 */
export const SOUND_ALERT_PRESETS: readonly {
	id: SoundAlertPresetId;
	file: string;
	labelKey: string;
}[] = [
	{ id: "done-chime", file: "done-chime.wav", labelKey: "settings.sound.preset.doneChime" },
	{ id: "done-bell", file: "done-bell.wav", labelKey: "settings.sound.preset.doneBell" },
	{ id: "done-pop", file: "done-pop.wav", labelKey: "settings.sound.preset.donePop" },
	{ id: "error-buzz", file: "error-buzz.wav", labelKey: "settings.sound.preset.errorBuzz" },
	{ id: "error-alert", file: "error-alert.wav", labelKey: "settings.sound.preset.errorAlert" },
	{ id: "waiting-ping", file: "waiting-ping.wav", labelKey: "settings.sound.preset.waitingPing" },
	{ id: "waiting-knock", file: "waiting-knock.wav", labelKey: "settings.sound.preset.waitingKnock" },
];

export const SOUND_ALERT_PRESET_IDS: readonly SoundAlertPresetId[] =
	SOUND_ALERT_PRESETS.map((entry) => entry.id);

/** 自定义音频允许的扩展名（小写，不含点）。 */
export const CUSTOM_SOUND_EXTENSIONS = ["wav", "mp3", "ogg", "m4a", "flac"] as const;

/** 自定义音频大小上限（5MB）：提示音足够，防止把大文件塞进 userData。 */
export const MAX_CUSTOM_SOUND_BYTES = 5 * 1024 * 1024;

/** 出厂默认：完成/出错提醒开、等待输入关（与 askNotificationEnabled 默认关的口径一致）。 */
export const DEFAULT_SOUND_ALERT_SETTINGS: SoundAlertSettings = {
	enabled: true,
	volume: 0.6,
	done: { enabled: true, sound: DEFAULT_SOUND_BY_KIND.done },
	error: { enabled: true, sound: DEFAULT_SOUND_BY_KIND.error },
	waiting: { enabled: false, sound: DEFAULT_SOUND_BY_KIND.waiting },
};

export function createDefaultSoundAlertSettings(): SoundAlertSettings {
	return {
		enabled: true,
		volume: DEFAULT_SOUND_ALERT_SETTINGS.volume,
		done: { ...DEFAULT_SOUND_ALERT_SETTINGS.done },
		error: { ...DEFAULT_SOUND_ALERT_SETTINGS.error },
		waiting: { ...DEFAULT_SOUND_ALERT_SETTINGS.waiting },
	};
}

/**
 * 自定义音频文件名合法性：仅允许安全字符 + 已知扩展名。
 * 用于渲染层/主进程两侧共用校验（协议 handler 与设置归一化）。
 */
export function isAllowedCustomSoundName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(wav|mp3|ogg|m4a|flac)$/i.test(name);
}

/**
 * 解析音效引用为结构化形式。
 * - `custom:<file>` → { kind: "custom", file }（文件名非法返回 null）
 * - 预设 id → { kind: "preset", id }
 * - 其它 → null
 */
export function parseSoundAlertRef(
	value: string,
): { kind: "preset"; id: SoundAlertPresetId } | { kind: "custom"; file: string } | null {
	if (value.startsWith("custom:")) {
		const file = value.slice("custom:".length);
		if (isAllowedCustomSoundName(file)) return { kind: "custom", file };
		return null;
	}
	if ((SOUND_ALERT_PRESET_IDS as readonly string[]).includes(value)) {
		return { kind: "preset", id: value as SoundAlertPresetId };
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clampVolume(value: unknown): number {
	const n = Number(value);
	if (!Number.isFinite(n)) return DEFAULT_SOUND_ALERT_SETTINGS.volume;
	return Math.min(1, Math.max(0, n));
}

function normalizeEventConfig(
	raw: unknown,
	fallback: SoundAlertEventConfig,
): SoundAlertEventConfig {
	if (!isRecord(raw)) return { ...fallback };
	const enabled = typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled;
	const sound =
		typeof raw.sound === "string" && parseSoundAlertRef(raw.sound)
			? raw.sound
			: fallback.sound;
	return { enabled, sound };
}

/**
 * 设置归一化（主进程加载/更新、渲染层草稿共用）：
 * 旧 settings.json 缺字段、手改坏值、枚举失效时回落到默认，
 * 保证声音链路永远拿到合法结构（不会因 sound 引用非法而静默失效）。
 */
export function normalizeSoundAlertSettings(raw: unknown): SoundAlertSettings {
	if (!isRecord(raw)) return createDefaultSoundAlertSettings();
	return {
		enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_SOUND_ALERT_SETTINGS.enabled,
		volume: clampVolume(raw.volume),
		done: normalizeEventConfig(raw.done, DEFAULT_SOUND_ALERT_SETTINGS.done),
		error: normalizeEventConfig(raw.error, DEFAULT_SOUND_ALERT_SETTINGS.error),
		waiting: normalizeEventConfig(raw.waiting, DEFAULT_SOUND_ALERT_SETTINGS.waiting),
	};
}
