import type { PiResourceOptions, PiResourceTarget } from "../../../shared/piConfig";

/**
 * 资源作用域的纯规则：IPC options 与各目标允许的动作。
 *
 * SSH 走独立主机绑定适配器；本机/WSL 旧 IPC 仍拒绝 SSH。WSL 身份从开发设置解析。
 */

/** local 是兼容缺省：不带 options，存量调用逐字不变；wsl 才带 target。 */
export function resourceTargetOptions(target: PiResourceTarget): PiResourceOptions | undefined {
	return target.kind !== "local" ? { target } : undefined;
}

/**
 * 资源三页的写动作。SSH 通过主机绑定适配器支持除 PiDeck 内置扩展启停外的动作；
 * WSL 仍按既有能力表限制，未路由的动作必须显式拦住并提示，避免静默写 Windows HOME。
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

/** 任一写动作是否支持当前目标：本机全支持；SSH 管理主机资源；WSL 维持既有能力表。 */
export function resourceWriteAllowed(action: PiResourceWriteAction, target: PiResourceTarget): boolean {
	if (target.kind === "local") return true;
	if (target.kind === "ssh") return action !== "extensions:removeBuiltIn" && action !== "extensions:restoreBuiltIn";
	if (action.startsWith("skills:")) return action !== "skills:edit";
	if (action.startsWith("prompts:")) return true;
	return action === "extensions:toggle";
}

/** 兼容旧判据：目标级资源是否允许写（细粒度用 resourceWriteAllowed）。 */
export function resourceMutationAllowed(target: PiResourceTarget): boolean {
	return target.kind === "local";
}
