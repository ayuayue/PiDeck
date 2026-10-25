/** DSH 0.2 preset plane：只引入官方预设声明，不启动 dsh-web 的浏览器/HTTP 服务。 */
import { dirname, join } from "node:path";

/** 每个会话自己的工具由预设持有；host 只保留共享 registry/backends。 */
export const dshWebAgentPlaneDisabledIds = [
	"tool-plugin-manager",
	"tool-bash",
	"tool-pwsh",
	"tool-jobs",
	"tool-fs",
	"tool-fs-search",
	"skill-filesystem",
	"tool-skill",
	"command-goal",
	"tool-goal",
	"plan-mode",
	"compaction-basic",
	"command-compact",
	"tool-result-pruner",
	"tool-subagent-control",
	"tool-subagent-list-agents",
	"tool-subagent",
	"tool-subagent-fork",
	"workflow-ptc",
	"tool-workflow",
	"agent-instructions",
	"tool-todo",
	"tool-web",
] as const;

/** 与 dsh-web-app 的 agent-plane 禁用层逐项对齐。 */
export function dshWebAgentPlaneDisableRows(): Array<{ id: string; disabled: true }> {
	return dshWebAgentPlaneDisabledIds.map((id) => ({ id, disabled: true }));
}

/** 新版默认值保存为此行的 selectedDefault；default 是部署兜底。 */
export function agentPresetsRow() {
	return {
		id: "agent-preset-registry",
		name: "@deepseek-ai/dsh-agent-preset-registry",
		config: { default: "standard" },
	};
}

/** 只取 bundle 声明中的 presets 文件；不手写官方工具表、隔离组或 persona。 */
export function shippedPresetPatchPaths(webPackageDir: string, patchFiles: readonly string[]): string[] {
	const presets = patchFiles.filter((file) => /^\.\/presets\/[a-z0-9-]+\.patch\.yml$/.test(file));
	if (presets.length === 0) throw new Error("DSH web bundle declares no preset patches");
	return presets.map((file) => join(webPackageDir, file));
}

/** agent-team 官方实验预设包（cordis.patch.yml 在包根，随依赖装进 node_modules）。 */
export const DSH_AGENT_TEAM_PROFILE_PACKAGE = "@deepseek-ai/dsh-experimental-agent-team-profile";

/**
 * agent-team 预设 patch 路径：官方 profile 包根的 cordis.patch.yml。
 * 包在 devDependencies（随 dev 闭包进外置 runtime tarball），runtimeRequire 锚定 runtime
 * node_modules 解析（与 @deepseek-ai/dsh-web-app 同链路），dev 与打包后无路径分叉。
 * 包缺失（runtime 未带该依赖）返回 undefined，调用方跳过注入而不是启动失败。
 */
export function agentTeamPresetPatchPath(resolvePackageJson: (specifier: string) => string): string | undefined {
	try {
		return join(dirname(resolvePackageJson(`${DSH_AGENT_TEAM_PROFILE_PACKAGE}/package.json`)), "cordis.patch.yml");
	} catch {
		return undefined;
	}
}

/** delegation 行需要 host 作用域的模型选择服务。 */
export function dshSubagentModelSelectionSettingsRow() {
	return { id: "subagent-model-selection-settings", name: "@deepseek-ai/dsh-tool-subagent/model-selection-settings" };
}
