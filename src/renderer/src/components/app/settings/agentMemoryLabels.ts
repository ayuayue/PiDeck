/**
 * 记忆设置页共用的文案映射：作用域/目标名的中文说法、失败码到可读原因。
 *
 * 抽出来的原因很实际：条目浏览器与导入导出弹窗都要显示「这条记忆属于哪个作用域」，
 * 各写一份就会出现「列表写『本机设备 · x』、弹窗写『设备』」这类不一致。
 */

import type { AgentMemoryEntry, AgentMemoryEntryGroup } from "../../../../../shared/types/agentMemory";
import { t } from "../../../i18n";

export function memoryTargetLabel(target: AgentMemoryEntry["target"] | string): string {
	switch (target) {
		case "memory":
			return t("settings.agentMemoryTargetMemory");
		case "user":
			return t("settings.agentMemoryTargetUser");
		case "failure":
			return t("settings.agentMemoryTargetFailure");
		case "standing":
			return t("settings.agentMemoryTargetStanding");
		default:
			return target;
	}
}

/** 全局 → 「全局」；设备 → 「本机设备 · <短键>」；项目 → 项目名（拿不到名字时退回目录键）。 */
export function memoryScopeLabel(scope: AgentMemoryEntry["scope"], projectId: string, projectName: string): string {
	if (scope === "global") return t("settings.agentMemoryScopeGlobal");
	if (scope === "device") return t("settings.agentMemoryScopeDevice", { device: projectName });
	return projectName || projectId;
}

export function memoryGroupScopeLabel(group: AgentMemoryEntryGroup): string {
	return memoryScopeLabel(group.scope, group.projectId, group.projectName);
}

/** 失败码 → 可读原因；未知码原样显示，避免「静默失败」。 */
export function describeAgentMemoryCode(code: string): string {
	switch (code) {
		case "bundle-invalid":
			return t("settings.agentMemoryErrorBundleInvalid");
		case "bundle-format-unsupported":
			return t("settings.agentMemoryErrorBundleFormat");
		case "bundle-version-unsupported":
			return t("settings.agentMemoryErrorBundleVersion");
		case "bundle-too-large":
			return t("settings.agentMemoryErrorBundleTooLarge");
		case "index-unavailable":
			return t("settings.agentMemoryErrorIndexUnavailable");
		case "invalid-input":
		case "operation-failed":
			return t("settings.agentMemoryErrorFailed");
		default:
			return code;
	}
}
