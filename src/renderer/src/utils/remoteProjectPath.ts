/**
 * 远端（SSH）项目的文件路径词法规则（渲染层纯函数：不碰 node:path、不碰 fs）。
 *
 * 远端项目在本机没有路径——`RemoteProject` 只带 `locator.remotePath`（远端主机上的项目根）
 * 与「项目内相对路径」这组身份（见 `shared/types/project.ts` 与 `files:*` 通道的
 * `ProjectFileTarget` 契约）。而会话正文与工具参数里出现的是**远端主机上的绝对路径**
 *（远端 pi 的 cwd 解析结果），要打开就必须先归一到项目根之下；否则它只会落进本机 fs，
 * 远端主机上明明存在的文件会被报成「路径不存在或已失效」。
 *
 * 规则刻意收窄：只认 POSIX 绝对路径（远端 helper 的根一律 `/`），只做词法折叠，
 * 不做大小写折叠（Linux 远端区分大小写）；越界或非法一律返回 null，由调用方拒绝，
 * 绝不在这里降级成本机路径。
 */
import { isRemoteProject } from "../../../shared/projectLocation";
import type { Project, ProjectFileTarget } from "../../../shared/types/project";

const REMOTE_PATH_MAX_LENGTH = 4096;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** POSIX 绝对路径归一：折叠重复 `/`、`.`、`..`（在根处截断）。非法输入返回 null。 */
export function normalizeRemoteAbsolutePath(value: string): string | null {
	if (typeof value !== "string" || value.length === 0 || value.length > REMOTE_PATH_MAX_LENGTH || value[0] !== "/" || CONTROL_CHARS.test(value)) return null;
	const segments: string[] = [];
	for (const segment of value.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			segments.pop();
			continue;
		}
		segments.push(segment);
	}
	return `/${segments.join("/")}`;
}

/**
 * 远端绝对路径 → 项目内相对路径身份（项目根自身为 `""`，与 `ProjectFileTarget` 同一口径）。
 * 不在项目根之内、或任一侧不是合法 POSIX 绝对路径时返回 null。
 */
export function remoteProjectRelativePath(absolutePath: string, remoteRoot: string): string | null {
	const target = normalizeRemoteAbsolutePath(absolutePath);
	const root = normalizeRemoteAbsolutePath(remoteRoot);
	if (target === null || root === null) return null;
	if (target === root) return "";
	const prefix = root === "/" ? "/" : `${root}/`;
	return target.startsWith(prefix) ? target.slice(prefix.length) : null;
}

/**
 * 在已打开的远端项目里找这个绝对路径的家：优先本栏项目（`preferredProjectId`），
 * 其余按项目列表顺序。命中返回 `ProjectFileTarget`；本机客户端访问不到的位置返回 null。
 */
export function remoteProjectTarget(projects: readonly Project[], absolutePath: string, preferredProjectId?: string): ProjectFileTarget | null {
	const preferred = preferredProjectId === undefined ? undefined : projects.find((project) => project.id === preferredProjectId);
	for (const project of preferred === undefined ? projects : [preferred, ...projects]) {
		if (project === undefined || !isRemoteProject(project)) continue;
		const relativePath = remoteProjectRelativePath(absolutePath, project.locator.remotePath);
		if (relativePath !== null) return { projectId: project.id, relativePath };
	}
	return null;
}
