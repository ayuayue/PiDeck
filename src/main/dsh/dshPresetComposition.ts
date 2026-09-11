/**
 * DSH agent preset 组合辅助（纯函数，可单测）。
 *
 * 背景：dsh CLI 的 profile-boot 会在引导时把随包发布的 agent-presets 根目录
 * （SHIPPED_PRESET_ROOT，即 <dsh 包>/config/agent-presets）注入组合，并声明
 * `default: standard`。PiDeck 的 hostEntry 是自组组合（base patch + 自身 overlay），
 * 不声明 agent-presets 行时 `agentPreset.list` 返回空名单（配置页「预设设置」空白），
 * 新会话也没有默认预设可用。这里把该行抽成纯函数，hostEntry 装配、单测验证同一来源。
 *
 * 用户级默认值覆盖仍走 settings 文档（$DSH_HOME/settings.yaml 的 agent-presets.default，
 * 配置页「设为默认」写入同一命名空间），与 dsh-web 的 General 设置行一致。
 */
import { join } from "node:path";

/** 随包发布的 agent preset 根目录：0.1.5 起随 <dsh-agent-presets 包目录>/presets 分发
 *  （此前是 <dsh 包>/config/agent-presets，见 docs/dsh-0.1.5-typert-migration.md）。 */
export function shippedPresetRoot(agentPresetsPackageDir: string): string {
	return join(agentPresetsPackageDir, "presets");
}

/**
 * dsh-web-app/cordis.patch.yml 中「agent plane moves behind agent presets」
 * 所禁用的基础层行 id 清单。
 *
 * 背景：dsh-base 为无 preset 的 TUI/headless 保留进程级全局工具；web 表面必须
 * 把这些基础行禁用，才能让每个会话由自己的 agent preset 组装工具目录。PiDeck
 * 自组 host 若只挂 agentPresetsRow 而漏掉这段禁用，minimal/standard/code 都只是
 * 叠加自己的工具，全局工具仍会泄漏进所有会话（极简模式失效的根因）。
 */
export const dshWebAgentPlaneDisabledIds = [
	"tool-bash",
	"tool-pwsh",
	"tool-jobs",
	"tool-fs",
	"tool-fs-search",
	"tool-str-replace-editor",
	"skill-filesystem",
	"tool-skill",
	"tool-goal",
	"plan-mode",
	"compaction-basic",
	"command-compact",
	"tool-result-pruner",
	"tool-subagent-control",
	"tool-subagent-list-agents",
	"tool-subagent",
	"tool-subagent-fork",
	"workflow-worker-thread",
	"tool-workflow",
	"tool-ralph",
	"agent-instructions",
	"tool-todo",
	"tool-web",
] as const;

/** 生成与 dsh-web-app/cordis.patch.yml 同语义的禁用补丁行（装配层直接 push）。 */
export function dshWebAgentPlaneDisableRows(): Array<{ id: string; disabled: true }> {
	return dshWebAgentPlaneDisabledIds.map((id) => ({ id, disabled: true }));
}

/**
 * agent-presets 组合行：默认 standard（标准模式），与 dsh-web 的部署形态
 * （web-app cordis.patch.yml）一致。0.1.5 起随包预设由 dsh-agent-presets 插件
 * 自带（includeShippedRoot 默认 prepend 只读 system 根），行内不再显式配 roots
 * （重复声明同一根会被 loader 判重/多余）。
 * 用户级默认值覆盖仍走 settings 文档（$DSH_HOME/settings.yaml 的 agent-presets.default）。
 */
export function agentPresetsRow(): {
	id: string;
	name: string;
	config: { default: string };
} {
	return {
		id: "agent-presets",
		name: "@deepseek-ai/dsh-agent-presets",
		config: {
			default: "standard",
		},
	};
}

/**
 * host 组合文件（cordis.yml）的落盘目录 = appRoot/pideck-host（appRoot 即
 * `--dsh-node-modules` 指向的、含 node_modules 的目录）。
 *
 * **为什么不能放 userData/configDir**：dsh-app-boot 的 Include 构造函数会无条件把
 * 上下文的 `baseUrl` 重置为组合文件所在目录，而 dsh-agent-presets 用 `ctx.baseUrl`
 * 作为基准向上逐级找 `node_modules` 判定组合里的包名行（packageInstalled）。configDir
 * 在 userData 下，向上永远走不到 runtime 的 node_modules —— 随包预设的全部插件行会被
 * 判成 "cannot be resolved"（实测 24 行全灭，配置页选不了模式）。放到 appRoot 子目录后，
 * 向上走一级即 `<appRoot>/node_modules`，解析恢复正常。
 *
 * @param appRoot `--dsh-node-modules` 的 file URL（DshHost 传的是带尾斜杠的目录 URL）。
 * @returns 组合文件绝对路径。
 */
export function hostCompositionPath(appRootPath: string): string {
	return join(appRootPath, "pideck-host", "cordis.yml");
}
