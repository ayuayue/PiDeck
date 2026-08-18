/**
 * 项目目录存在性检测。
 *
 * 背景：项目添加后永久保留在 projects.json，目录被用户删除/移动后列表仍显示
 * 残留（2026-08 用户反馈）。方案是「标记显示」而非自动删除：
 * - 不自动移除记录——网络盘未挂载、移动盘未插入、WSL 发行版未启动等短暂
 *   不可达场景下 stat 失败但目录还在，自动移除会误删项目关联（会话历史入口、
 *   排序、worktree 关系）。
 * - 检测规则保守：只有明确「目录不存在」才标记 missing；环境不可达（WSL
 *   发行版未启动）不标记，避免误报。
 */
import { stat } from "node:fs/promises";
import type { Project } from "../../shared/types";
import { parseWslUncPath } from "../wsl/WslPaths";

export type PathCheck = (path: string) => Promise<boolean>;
export type ProjectPathResolver = (project: Project) => string;

/** 默认路径检查：stat 成功即存在（ENOENT 及一切异常视为不存在）。 */
export const defaultPathCheck: PathCheck = async (path) => {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
};

/**
 * 给项目列表附加存在性标记。chat 项目（userData 下自动创建）跳过；
 * 返回新数组（原对象不可变，missing 时浅拷贝加标记）。
 */
export async function attachProjectPresence(
	projects: readonly Project[],
	checkPath: PathCheck = defaultPathCheck,
	resolvePath: ProjectPathResolver = (project) => project.path,
): Promise<Project[]> {
	const results: Project[] = [];
	for (const project of projects) {
		if (project.kind === "chat" || !project.path) {
			results.push(project);
			continue;
		}
		results.push(
			(await isProjectMissing(project, checkPath, resolvePath))
				? { ...project, missing: true }
				: project,
		);
	}
	return results;
}

/** 单个项目是否标记 missing：目录 stat 失败且确认不是环境不可达。 */
async function isProjectMissing(
	project: Project,
	checkPath: PathCheck,
	resolvePath: ProjectPathResolver,
): Promise<boolean> {
	const hostPath = resolvePath(project);
	if (await checkPath(hostPath)) return false;
	// WSL 项目（UNC 路径）：stat 失败可能是发行版未启动（UNC 根不可达），
	// 此时不标记——否则每次 WSL 未启动都会误报「目录不存在」。
	// 发行版根可达但项目路径仍缺失，才是真正被删除/移动。
	if (project.environment === "wsl") {
		const unc = parseWslUncPath(hostPath) ?? parseWslUncPath(project.path);
		if (!unc) return true; // 无法解析的 WSL 路径视为缺失
		if (!(await checkPath(`\\\\wsl.localhost\\${unc.distro}`))) return false;
	}
	return true;
}
