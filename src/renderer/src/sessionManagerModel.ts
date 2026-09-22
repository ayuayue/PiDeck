import type { ArchivedDshSession, ArchivedPiSession, Project, SessionSummary } from "../../shared/types";

/**
 * 会话管理弹窗（SessionManagerModal）的纯策略层：收录条件、行身份、
 * worktree 家族聚合与归档视图的项目归属过滤。全部为纯函数，便于
 * tests/*.test.mjs 直接单测。
 *
 * 过滤类别（pill）的共享模型在 sessionFilterPills.ts（侧栏来源过滤菜单同款），
 * 弹窗侧只保留自身专属策略。
 */

/**
 * 会话管理弹窗收录条件：
 * - pi/导入会话：有会话文件（filePath）才进（草稿无文件，侧栏单独展示，不进弹窗）；
 * - DSH 会话：没有 pi 会话文件，按 host 会话 id（dshSessionId）判定；
 *   DSH 草稿（未发送、无 host id）同样不进弹窗，与 pi 草稿语义一致。
 */
export function isManagerSessionSummary(summary: SessionSummary): boolean {
	if (summary.backend === "dsh") return Boolean(summary.dshSessionId);
	return Boolean(summary.filePath);
}

/**
 * 行身份：SessionRecord.id 跨重启稳定，pi/DSH 均唯一。
 * 不能沿用 filePath：DSH 会话无文件路径（空串会让多行 key 冲突、选中集合错乱）。
 */
export function sessionManagerRowKey(summary: SessionSummary): string {
	return summary.id;
}

// ── worktree 家族：弹窗「项目上下文」= 根项目 + 全部子工作区 ──────────────

/**
 * 会话管理弹窗的项目上下文 = 整个 worktree 家族（根 + 全部子工作区）：
 * 从家族任意成员（父项目或 worktree 行）打开弹窗，主列表与归档列表都覆盖
 * 整个家族，行按所属工作区打标签。与侧栏 WorktreeTree「家族一棵树」语义对齐。
 */
export function worktreeFamilyProjects(projects: readonly Project[], openedProjectId: string): Project[] {
	const opened = projects.find((project) => project.id === openedProjectId);
	if (!opened) return [];
	const root = opened.worktreeParentId ? projects.find((project) => project.id === opened.worktreeParentId) : opened;
	if (!root) return [opened];
	const children = projects.filter((project) => project.worktreeParentId === root.id);
	return [root, ...children];
}

/** 家族根项目：第一个无 worktreeParentId 的成员；全缺（异构数据）时回退首个成员。 */
export function familyRootProject(family: readonly Project[]): Project | undefined {
	return family.find((project) => !project.worktreeParentId) ?? family[0];
}

/**
 * 会话所属工作区标签：主工作区（家族根）返回 undefined（不标记、避免视觉噪）；
 * worktree 子项目返回其目录名（project.name = 路径末段），供主列表行打标签。
 */
export function sessionWorkspaceLabel(projectId: string | undefined, family: readonly Project[]): string | undefined {
	if (!projectId) return undefined;
	const root = familyRootProject(family);
	const project = family.find((candidate) => candidate.id === projectId);
	if (!project || !root || project.id === root.id) return undefined;
	return project.name || undefined;
}

// ── 归档视图：按家族归属过滤 + 工作区标签 ─────────────────────────────────

/**
 * 路径规范化（纯字符串，渲染层安全）：统一分隔符、去尾斜杠；
 * WSL（/ 开头）区分大小写，native 不区分（与 shared canonicalizeSessionPath 同语义）。
 */
export function canonicalWorkspacePath(path: string, wsl: boolean): string {
	const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return wsl ? normalized : normalized.toLowerCase();
}

function isWslLikePath(path: string): boolean {
	return path.startsWith("/");
}

/** 家族成员路径集合（按环境各自算一次，供归档归属判定）。 */
function familyPathSet(family: readonly Project[], wsl: boolean): ReadonlySet<string> {
	return new Set(
		family
			.map((project) => project.path)
			.filter((path): path is string => Boolean(path))
			.map((path) => canonicalWorkspacePath(path, wsl)),
	);
}

/** canonical 路径是否落在某成员目录内（等于或子路径；边界用 / 分隔避免 `C:/a` 误中 `C:/ab`）。 */
function isPathWithinMember(canonical: string, memberPaths: ReadonlySet<string>): boolean {
	for (const member of memberPaths) {
		if (canonical === member || canonical.startsWith(`${member}/`)) return true;
	}
	return false;
}

/**
 * pi 归档按家族过滤：使用归档 JSONL 中记录的 cwd/projectPath。
 * Pi 默认会话文件存于 ~/.pi/agent/sessions/<encoded-cwd>，文件路径不属于项目目录，
 * 因而不能拿 originalPath 做项目归属判断；originalPath 仅保留为恢复索引。
 */
export function filterArchivedPiByFamily(items: readonly ArchivedPiSession[], family: readonly Project[]): ArchivedPiSession[] {
	const nativeMembers = familyPathSet(family, false);
	const wslMembers = familyPathSet(family, true);
	return items.filter((item) => {
		const projectPath = item.summary.projectPath;
		// 缺少恢复索引的归档不能恢复；缺少 cwd 的归档不能可靠归属，均不展示在项目页。
		if (!item.originalPath || !projectPath) return false;
		const wsl = item.summary.wsl === true || isWslLikePath(projectPath);
		const members = wsl ? wslMembers : nativeMembers;
		return isPathWithinMember(canonicalWorkspacePath(projectPath, wsl), members);
	});
}

/**
 * DSH 归档按家族过滤：manifest cwd 精确匹配家族成员路径
 * （DSH 会话 cwd 恒等于创建/归属时刻的某项目 path，含 worktree 目录）。
 */
export function filterArchivedDshByFamily(items: readonly ArchivedDshSession[], family: readonly Project[]): ArchivedDshSession[] {
	const nativeMembers = familyPathSet(family, false);
	const wslMembers = familyPathSet(family, true);
	return items.filter((item) => {
		const wsl = isWslLikePath(item.cwd);
		const members = wsl ? wslMembers : nativeMembers;
		return members.has(canonicalWorkspacePath(item.cwd, wsl));
	});
}

/** canonical 路径归属到的家族非根成员（最长成员路径优先：worktree 目录可能嵌套在主项目下）。 */
function workspaceMemberForPath(canonical: string, wsl: boolean, family: readonly Project[]): Project | undefined {
	const root = familyRootProject(family);
	if (!root) return undefined;
	let best: Project | undefined;
	let bestLength = -1;
	for (const project of family) {
		if (project.id === root.id || !project.path) continue;
		const member = canonicalWorkspacePath(project.path, wsl);
		if (isPathWithinMember(canonical, new Set([member])) && member.length > bestLength) {
			best = project;
			bestLength = member.length;
		}
	}
	return best;
}

/** pi 归档行工作区标签：以 JSONL cwd/projectPath 判断归属；主工作区不标记。 */
export function archivedPiWorkspaceLabel(item: ArchivedPiSession, family: readonly Project[]): string | undefined {
	const projectPath = item.summary.projectPath;
	if (!item.originalPath || !projectPath) return undefined;
	const wsl = item.summary.wsl === true || isWslLikePath(projectPath);
	return workspaceMemberForPath(canonicalWorkspacePath(projectPath, wsl), wsl, family)?.name;
}

/** DSH 归档行工作区标签：cwd 归属 worktree 子项目时返回目录名；主工作区返回 undefined。 */
export function archivedDshWorkspaceLabel(item: ArchivedDshSession, family: readonly Project[]): string | undefined {
	const wsl = isWslLikePath(item.cwd);
	return workspaceMemberForPath(canonicalWorkspacePath(item.cwd, wsl), wsl, family)?.name;
}

/**
 * DSH 归档行标签（纯策略）：manifest/日志折叠标题 > cwd 末段 > 裸 host id。
 * 标题仍缺省（极老归档、日志无折叠结果）时也要比裸 id 可读。
 */
export function managerArchivedDshLabel(row: Extract<ManagerArchivedRow, { kind: "dsh" }>): string {
	const title = row.item.title?.trim();
	if (title) return title;
	const cwd = row.item.cwd.replace(/[\\/]+$/, "").trim();
	if (cwd) {
		const last = cwd.split(/[\\/]/).pop()?.trim();
		if (last) return last;
	}
	return row.item.dshSessionId;
}

/** 归档视图合并行：pi 会话按文件恢复；DSH 会话按 host id 恢复。 */
export type ManagerArchivedRow = { kind: "pi"; item: ArchivedPiSession } | { kind: "dsh"; item: ArchivedDshSession };

/**
 * 归档行身份（弹窗选中集合用）：pi 行用会话记录 id，DSH 行用 host 会话 id。
 * 与主列表 sessionManagerRowKey 同语义，两类 id 命名空间不冲突。
 */
export function managerArchivedRowKey(row: ManagerArchivedRow): string {
	return row.kind === "pi" ? sessionManagerRowKey(row.item.summary) : row.item.dshSessionId;
}

/** 归档行时间戳（排序用）：pi 用 updatedAt，DSH 用 archivedAt。 */
function managerArchivedTimestamp(row: ManagerArchivedRow): number {
	return row.kind === "pi" ? row.item.summary.updatedAt : row.item.archivedAt;
}

/** 合并 pi / DSH 归档清单为一个视图，按时间倒序（调用方应先按家族过滤）。 */
export function mergeManagerArchived(piSessions: readonly ArchivedPiSession[], dshItems: readonly ArchivedDshSession[]): ManagerArchivedRow[] {
	return [...piSessions.map((item) => ({ kind: "pi" as const, item })), ...dshItems.map((item) => ({ kind: "dsh" as const, item }))].sort((a, b) => managerArchivedTimestamp(b) - managerArchivedTimestamp(a));
}
