import type { PiConfigTarget } from "../../../shared/piConfig";
import type { ConfigTab } from "./configTypes";

/**
 * 配置管理「环境」能力表（纯规则）：一个环境（本机 / 一台 SSH 主机 / 应用的 WSL 环境）能管理哪些配置页。
 *
 * 为什么把这张表放在纯模块里：切换环境后「这一页还在不在」「切到哪一页」「哪些脏草稿会随着页面消失」
 * 三件事必须同一个判定来源。散在 JSX 里就会出现「导航里没了、tab state 还停在那一页」这类半截状态。
 *
 * 边界来自后端事实，不是 UI 口味：
 * - ssh：配置与用户资源经主机绑定适配器，认证以保留引用编辑；OAuth 登录仍在远端终端完成。
 * - wsl：本机 UNC 读 + 发行版内原子替换，因此连 auth.json 也能编辑；但 OAuth 登录仍走本机 pi 进程，
 *   安全策略页编辑的是 PiDeck 自己的宿主设置，两者都只在本机。
 */
export type ConfigNavSection = "config" | "security" | "skills" | "prompts" | "extensions" | "mcp";

/** 每个环境的配置页（顺序即左侧导航顺序）。 */
const CONFIG_TABS_BY_TARGET: Record<PiConfigTarget["kind"], readonly ConfigTab[]> = {
	local: ["models", "auth", "oauth", "settings", "trust", "mcp", "raw"],
	wsl: ["models", "auth", "settings", "trust", "mcp", "raw"],
	ssh: ["models", "auth", "settings", "trust", "mcp", "raw"],
};

/** 该环境可管理的配置页（含顺序）。 */
export function configTabsForTarget(target: PiConfigTarget): readonly ConfigTab[] {
	return CONFIG_TABS_BY_TARGET[target.kind];
}

/** 当前 tab 在该环境是否可用；不可用时调用方必须落到 {@link firstConfigTabForTarget}。 */
export function isConfigTabSupported(target: PiConfigTarget, tab: ConfigTab): boolean {
	return CONFIG_TABS_BY_TARGET[target.kind].includes(tab);
}

/** 切换环境后的落点：当前页仍支持就留在原地，否则回到该环境的第一页。 */
export function resolveConfigTabForTarget(target: PiConfigTarget, current: ConfigTab): ConfigTab {
	return isConfigTabSupported(target, current) ? current : firstConfigTabForTarget(target);
}

export function firstConfigTabForTarget(target: PiConfigTarget): ConfigTab {
	return CONFIG_TABS_BY_TARGET[target.kind][0] ?? "models";
}

/** 三类环境都有资源适配器；具体写动作仍受目标能力门禁约束。 */
export function resourcePagesSupported(_target: PiConfigTarget): boolean {
	return true;
}

/** 安全策略页编辑 PiDeck 宿主设置（工具动作 allow/ask/deny 等），只对本机成立。 */
export function securityPageSupported(target: PiConfigTarget): boolean {
	return target.kind === "local";
}

/** 环境的稳定身份串：切换时用它做 key / 依赖，不含对象身份。 */
export function configTargetKey(target: PiConfigTarget): string {
	return target.kind === "ssh" ? `ssh:${target.hostId}` : target.kind;
}

/**
 * 环境边界的一句话说明（i18n key）：让用户在切换后立刻知道「为什么少了几页」，
 * 而不是以为页面丢了。
 */
export function environmentScopeHintKey(target: PiConfigTarget): "config.env.scopeLocal" | "config.env.scopeWsl" | "config.env.scopeSsh" {
	if (target.kind === "ssh") return "config.env.scopeSsh";
	if (target.kind === "wsl") return "config.env.scopeWsl";
	return "config.env.scopeLocal";
}
