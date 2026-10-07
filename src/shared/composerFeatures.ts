/**
 * 「输入框功能显示」（设置 → 外观 → 输入框功能显示）：用户按需收起输入框底栏的功能入口。
 *
 * 可关项：提示词增强、语音输入、快捷消息、权限（安全等级/权限预设）、Git 分支。
 * 与 shared/hiddenModules.ts 同一套设计：只隐藏入口，不停功能——隐藏提示词增强不影响
 * 增强 sidecar，隐藏语音输入不改录音配置，隐藏权限不改变实际生效的安全等级；
 * 快捷键（如快捷消息 Ctrl/Cmd+Shift+M）也继续工作。默认 `[]` = 全部显示。
 *
 * 为什么存 id 数组而不是 N 个布尔：与 hiddenModules 同理（清单随功能增减，
 * 加一项只需扩展清单，不动 AppSettings 类型和 SettingsStore 逐字段逻辑）。
 */

import { normalizeHiddenModules } from "./hiddenModules";

/**
 * 全部可隐藏的输入框功能入口。顺序即外观设置里开关的排列顺序
 * （左栏入口在前：权限/快捷消息，右栏入口在后：Git 分支/增强/语音）。
 */
export const HIDEABLE_COMPOSER_FEATURE_IDS = ["security", "quickMessages", "gitBranch", "enhance", "voice"] as const;

export type HideableComposerFeatureId = (typeof HIDEABLE_COMPOSER_FEATURE_IDS)[number];

/**
 * 存储清洗与 hiddenModules 完全同规则（非空字符串、去重、截断、非数组回落空数组），
 * 直接复用同一实现，避免两份清单逻辑漂移。
 */
export const normalizeHiddenComposerFeatures = normalizeHiddenModules;

/** 某输入框功能入口当前是否被用户隐藏。 */
export function isComposerFeatureHidden(hiddenFeatures: readonly string[], featureId: HideableComposerFeatureId): boolean {
	return hiddenFeatures.includes(featureId);
}

/** 切换某输入框功能入口的隐藏状态，返回新数组（不改入参）；用于外观设置开关的 onChange。 */
export function toggleHiddenComposerFeature(hiddenFeatures: readonly string[], featureId: HideableComposerFeatureId, hidden: boolean): string[] {
	const without = hiddenFeatures.filter((id) => id !== featureId);
	return hidden ? [...without, featureId] : without;
}
