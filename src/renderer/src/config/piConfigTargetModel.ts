import type { PiConfigTarget } from "../../../shared/piConfig";
import { isRemoteProject } from "../../../shared/projectLocation";
import type { Project } from "../../../shared/types";
import type { RemoteHostListItem } from "../../../shared/types/remoteHost";

/**
 * 配置目标（P1-1 UI 侧）的纯规则：选择器可选项、目标比较、本地编辑器是否带 target、
 * provider 探针门禁。放在纯模块里而不是 JSX lambda 里，便于单测「切目标/带不带 target」这些
 * 会直接影响写盘作用域的判断。
 */

/** 目标选择器的一项：已校验且未禁用的 ssh 主机，或应用唯一的 WSL 环境。 */
export type PiConfigTargetHost = { kind: "ssh"; id: string; label: string; sshHost: string } | { kind: "wsl"; label: string; distro: string; user: string };

/** WSL 项（来源提示、未接入页说明都只认这一种）。 */
export type WslConfigTargetHost = Extract<PiConfigTargetHost, { kind: "wsl" }>;

/** SSH 项（连接状态只对它有语义，因此派生与取用都需要这个窄化类型）。 */
export type SshConfigTargetHost = Extract<PiConfigTargetHost, { kind: "ssh" }>;

/** 已验证的 ssh 主机 → 选择器项（过滤条件由调用方先做，这里只做形状转换）。 */
export function toSshTargetHosts(hosts: readonly RemoteHostListItem[]): PiConfigTargetHost[] {
	return hosts.map((host) => ({ kind: "ssh", id: host.id, label: host.label, sshHost: host.sshHost }));
}

/**
 * 应用唯一的 WSL 环境 → 选择器项（0 或 1 项）。
 *
 * WSL 不是一台可以用 id 选中的连接：它的 distro/user 就是开发设置里那一份，关掉开关即不存在。
 * 因此这里只做「有没有 + 展示信息」，不提供枚举。
 */
export function toWslTargetHosts(identity: { distro: string; user: string } | undefined): PiConfigTargetHost[] {
	return identity === undefined ? [] : [{ kind: "wsl", label: "WSL", distro: identity.distro, user: identity.user }];
}

/**
 * 目标 → 展示名。已消失的主机（档案被删/被禁用）回退到「未知主机」而不是空串：
 * 用户看到的必须是「我停在一个读不到的目标上」，而不是一个没有名字的空白。
 */
export function configTargetHostLabel(target: PiConfigTarget, hosts: readonly PiConfigTargetHost[], localLabel: string, unknownLabel: string): string {
	if (target.kind === "local") return localLabel;
	const host = target.kind === "ssh" ? hosts.find((candidate) => candidate.kind === "ssh" && candidate.id === target.hostId) : hosts.find((candidate) => candidate.kind === "wsl");
	return host?.label ?? unknownLabel;
}

/**
 * 切换配置目标前必须拦下的「配置组未保存草稿」判定。
 * 只看 config:* 的脏标记：skills/prompts 等与配置目标无关的未保存修改不应挡住切目标。
 */
export function hasUnsavedConfigDrafts(keys: Iterable<string>): boolean {
	for (const key of keys) {
		if (key.startsWith("config:")) return true;
	}
	return false;
}

/**
 * 同一目标判定：local 对 local；ssh 同 hostId 才算同一个；WSL 只有一个环境，两者都是 wsl 即同一个。
 * 切换时必须重载——否则界面会把上一份目标的草稿当成新目标的数据展示。
 */
export function samePiConfigTarget(left: PiConfigTarget, right: PiConfigTarget): boolean {
	if (left.kind === "local" || right.kind === "local") return left.kind === right.kind;
	if (left.kind === "ssh" || right.kind === "ssh") return left.kind === "ssh" && right.kind === "ssh" && left.hostId === right.hostId;
	return true;
}

/**
 * 打开配置管理时的默认目标：当前项目是 SSH 项目、且那台主机在可选目标里 ⇒ 落在该主机。
 *
 * 为什么默认而不是要求用户自己切：「模型配置 / Pi 设置」展示的是**当前环境**的 pi 配置。
 * 在远端项目里默认展示本机配置，用户改完才发现改错了机器（甚至以为远端配置根本不可编辑）。
 * 只改写「当前是本机」的情形：用户已主动选过远端目标时不被打开动作改写；
 * 主机不在可选清单里（未验证/被禁用/清单未到）时保持原值，不指向一个读不到的机器。
 */
export function preferredConfigTargetForProject(project: Project | undefined, hosts: readonly PiConfigTargetHost[], current: PiConfigTarget): PiConfigTarget {
	if (current.kind !== "local") return current;
	if (project === undefined || !isRemoteProject(project)) return current;
	const hostId = project.locator.hostId;
	if (!hosts.some((host) => host.kind === "ssh" && host.id === hostId)) return current;
	return { kind: "ssh", hostId };
}

/**
 * 本地编辑器（models/settings 表单）读写要带的 target 选项：
 * - local：缺省，不带（旧调用语义）；
 * - ssh：由远端面板接管，本地编辑器不参与；
 * - wsl：带 target，读写落到该档案的发行版 HOME。
 */
export function localEditorTargetOption(target: PiConfigTarget): { target: PiConfigTarget } | undefined {
	return target.kind === "wsl" ? { target } : undefined;
}

/** 按当前目标找 WSL 项；本机目标或当前没有 WSL 环境都返回 undefined。 */
export function wslTargetHostOf(hosts: readonly PiConfigTargetHost[], target: PiConfigTarget): WslConfigTargetHost | undefined {
	if (target.kind !== "wsl") return undefined;
	return hosts.find((host): host is WslConfigTargetHost => host.kind === "wsl");
}

/**
 * provider 探针（连接测试 / 拉取模型 / 用量查询）只对本机开放：
 * 远端与 WSL 目标在主进程会被拒（PROVIDER_OPERATION_UNSUPPORTED），界面必须提前禁用/拒绝，
 * 不能点了才报错，也不能把请求发到错误的网络出口。
 */
export function providerOpsAllowed(target: PiConfigTarget): boolean {
	return target.kind === "local";
}
