/**
 * Agent preset 显示文案解析（纯函数，可单测）。
 *
 * DSH 0.2 不再提供 trust；稳定的官方 preset ID 用 i18n，其余回退声明元数据。
 * ID 由 registry 唯一约束，此处不再伪造“系统/用户”来源标签。
 */
import type { TranslationKey } from "../i18n";

/** 名单行的身份字段（agentPreset.list 返回子集）。 */
export type DshAgentPresetIdentity = {
	id: string;
	name?: string;
	description?: string;
};

/** 4 个随附预设 → i18n key 映射（与 dsh-web 的 BUILT_IN_PRESET_KEYS 同源）。 */
const BUILTIN_PRESET_KEYS: Record<string, { name: TranslationKey; description: TranslationKey }> = {
	standard: { name: "config.dsh.presetStandardName", description: "config.dsh.presetStandardDesc" },
	ptc: { name: "config.dsh.presetPtcName", description: "config.dsh.presetPtcDesc" },
	minimal: { name: "config.dsh.presetMinimalName", description: "config.dsh.presetMinimalDesc" },
	cordis: { name: "config.dsh.presetCordisName", description: "config.dsh.presetCordisDesc" },
};

/**
 * 官方预设的稳定 ID 对应 i18n key；未知 ID 原样展示声明元数据。
 */
export function builtinPresetKeys(preset: DshAgentPresetIdentity): { name: TranslationKey; description: TranslationKey } | undefined {
	return BUILTIN_PRESET_KEYS[preset.id];
}

/** 预设显示名：内置 system 预设走 i18n，其余用元数据 name，缺省回退 id。 */
export function presetDisplayName(preset: DshAgentPresetIdentity, t: (key: TranslationKey) => string): string {
	const keys = builtinPresetKeys(preset);
	return keys ? t(keys.name) : (preset.name ?? preset.id);
}

/** 预设显示描述：内置 system 预设走 i18n，其余用元数据 description（可缺省）。 */
export function presetDisplayDescription(preset: DshAgentPresetIdentity, t: (key: TranslationKey) => string): string | undefined {
	const keys = builtinPresetKeys(preset);
	return keys ? t(keys.description) : preset.description;
}
