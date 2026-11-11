import type { PiResourceOptions, PiResourceTarget } from "../../../shared/piConfig";

/**
 * 资源作用域（W1）的纯规则：IPC options、本轮哪些动作只支持本机。
 *
 * 与配置目标（PiConfigTarget）刻意分开：资源域只有 local/wsl 两个值，ssh 不能出现在资源目标里
 * （主进程对 ssh 目标回 PI_RESOURCE_SSH_UNSUPPORTED）。WSL 只有一个环境，不再需要「档案选择器」：
 * distro/user 由主进程从设置解析。
 */

/** local 是兼容缺省：不带 options，存量调用逐字不变；wsl 才带 target。 */
export function resourceTargetOptions(target: PiResourceTarget): PiResourceOptions | undefined {
	return target.kind === "wsl" ? { target } : undefined;
}

/**
 * 资源三页的写动作。task-16 起 skills 五个动作、prompts 五个动作与 extensions.toggle 已按目标路由；
 * 其余（技能正文编辑走 files IPC、扩展 install/uninstall/update/removeBuiltIn/restoreBuiltIn）仍只支持本机，
 * 必须显式拦住并提示——静默写 Windows HOME 比不显示更危险。
 */
export type PiResourceWriteAction =
	| "skills:create"
	| "skills:delete"
	| "skills:rename"
	| "skills:toggle"
	| "skills:openFolder"
	| "skills:edit"
	| "prompts:create"
	| "prompts:delete"
	| "prompts:rename"
	| "prompts:toggle"
	| "prompts:openFolder"
	| "extensions:toggle"
	| "extensions:install"
	| "extensions:uninstall"
	| "extensions:update"
	| "extensions:updateOne"
	| "extensions:removeBuiltIn"
	| "extensions:restoreBuiltIn";

/** 任一写动作是否支持当前目标：本机全支持；WSL 只有 task-16 已路由的动作。 */
export function resourceWriteAllowed(action: PiResourceWriteAction, target: PiResourceTarget): boolean {
	if (target.kind === "local") return true;
	if (action.startsWith("skills:")) return action !== "skills:edit";
	if (action.startsWith("prompts:")) return true;
	return action === "extensions:toggle";
}

/** 兼容旧判据：任一目标级写操作是否可用（当前仅本机；细粒度用 resourceWriteAllowed）。 */
export function resourceMutationAllowed(target: PiResourceTarget): boolean {
	return target.kind === "local";
}
