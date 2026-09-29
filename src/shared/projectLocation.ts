/**
 * 项目位置的判别窄化（纯函数，三层共用）。
 *
 * Phase 3 第二段起 `Project` 是 local/remote 判别联合：远端项目**没有** `path`，因此所有
 * 「把 `project.path` 当本机路径用」的消费点都会在类型层被编译器逐个点名，而不是运行期
 * 才发现传进来一个远端字符串。这两个助手是窄化的唯一出处：本地分支返回带 `path` 的类型，
 * 远端分支由调用方显式处理（拒绝 / 路由到远端服务），不允许用 `!` 或 `as` 绕过。
 */
import type { LocalProject, Project, RemoteProject } from "./types/project";

/** 本机（含 WSL）项目：拥有 `path`，可交给 `node:fs`/Git/终端等本机实现。 */
export function isLocalProject(project: Project): project is LocalProject {
	return !("locator" in project) || project.locator.kind !== "ssh";
}

/** 远端 (SSH) 项目：只有 `{ hostId, remotePath }`，任何本机路径消费者都必须拒绝它。 */
export function isRemoteProject(project: Project): project is RemoteProject {
	return "locator" in project && project.locator.kind === "ssh";
}

/**
 * 取本机路径；远端项目返回 `undefined`。
 *
 * 供「远端应被拒绝，但拒绝方式是实现细节」的边界使用（例如 presence 探测、日志）。凡是
 * 结果会被写盘或交给 `node:fs` 的地方都必须用 `isLocalProject` 显式分支，不能靠这个函数
 * 把 `undefined` 继续往下传。
 */
export function localProjectPath(project: Project): string | undefined {
	return isLocalProject(project) ? project.path : undefined;
}
