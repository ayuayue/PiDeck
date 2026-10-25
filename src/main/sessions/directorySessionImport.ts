import { dirname } from "node:path";
import type { DirectorySessionSourceDir, DirectorySourceKind, DirectorySessionSummary, SessionSummary } from "../../shared/types";

/**
 * 外置目录会话导入的纯逻辑（不碰 Electron、不碰磁盘、不 import SessionScanner）。
 *
 * 背景：pi 会话按「cwd 的 encoded 分组目录」存在 ~/.pi/agent/sessions 下
 * （布局 `~/.pi/agent/sessions/<encoded-cwd>/<file>.jsonl`）。项目目录一旦移动/改名，
 * 会话记录里的项目路径与新项目不再匹配，常规项目扫描（isSameProject 过滤）就看不到它们。
 *
 * 这里负责可单测的四件事：
 * 1. 判断用户选定的目录属于哪种形态（会话容器 / 项目目录 / 会话树的祖先目录）；
 * 2. 从「全量会话清单」里挑出属于该目录的候选（容器内文件，或原工作目录命中）；
 * 3. 候选摘要 → 弹窗行；
 * 4. 全量会话清单 → 「现有会话目录」列表（弹窗先列目录让用户点选，避免手选 ~/.pi 误列全部项目）。
 * 磁盘 IO 与 catalog 写入在 DirectorySessionImporter，本模块保持纯函数。
 *
 * 注意：本模块不引入 pi 的 encoded 目录名编码逻辑——候选筛选一律基于 SessionScanner
 * 给出的摘要（filePath / projectPath 已解码），避免与 SessionScanner 的私有实现重复。
 */

/** 单次扫描最多读取多少个会话（按 mtime 倒序取前 N，控制主进程 IO 与弹窗体量）。 */
export const DIRECTORY_IMPORT_MAX_SUMMARIES = 300;

/** 目录下直接含 .jsonl 文件 / 含 encoded 分组子目录，即视为「会话容器」。 */
export type DirectoryShapeProbe = {
	/** 目录直接含 .jsonl 文件（某个 encoded 分组目录，或自放会话文件的目录） */
	hasJsonl: boolean;
	/** 目录含 `--xxx--` 形态的子目录（pi sessions 根的形态） */
	hasEncodedGroups: boolean;
};

/** 选定目录的形态判定：是会话容器则按「目录内的会话文件」匹配。 */
export function isSessionContainerProbe(probe: DirectoryShapeProbe): boolean {
	return probe.hasJsonl || probe.hasEncodedGroups;
}

/** 路径归一：Windows 大小写不敏感，分隔符统一。会话文件/目录身份的比对键。 */
export function normalizeSessionPathKey(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * 文件是否位于目录内（含禁止前缀误判：`D:/work/proj` 不包含 `D:/work/proj2/a.jsonl`）。
 * 用于「候选必须落在用户选定目录里」的边界判定。
 */
export function isPathInsideRoots(filePath: string, roots: readonly string[]): boolean {
	const normalizedFile = normalizeSessionPathKey(filePath);
	return roots.some((root) => {
		const normalizedRoot = normalizeSessionPathKey(root);
		return normalizedFile === normalizedRoot || normalizedFile.startsWith(`${normalizedRoot}/`);
	});
}

/** 会话归属目录与用户选定目录是否是同一个（大小写/分隔符归一）。 */
export function isSameDirectory(left: string | undefined, right: string | undefined): boolean {
	if (!left || !right) return false;
	return normalizeSessionPathKey(left) === normalizeSessionPathKey(right);
}

/**
 * 候选判定（纯函数）：
 * - 选定目录是会话容器（某个 encoded 分组目录，或 sessions 根）→ 收「会话文件就在该目录内」的会话；
 * - 选定目录是项目目录（用户按直觉选了项目路径）→ 收「会话记录里的原工作目录 == 该目录」的会话，
 *   因为 pi 的会话文件在 sessions 树里按 cwd 分组，不在项目目录里。
 *
 * 关键边界：文件位置匹配**只在选定目录被判定为会话容器时**生效。
 * 曾经的写法是不管形态先做 isPathInsideRoots，导致用户选 `~/.pi`（sessions 树的祖先目录）时
 * 整棵树的会话全部命中（2026-09 反馈：选了 ~/.pi 却列出 300 条其它项目的会话）。
 */
export function isDirectoryImportCandidate(input: { summary: SessionSummary; dir: string; pickedIsContainer: boolean }): boolean {
	if (input.pickedIsContainer && isPathInsideRoots(input.summary.filePath, [input.dir])) return true;
	return isSameDirectory(input.summary.projectPath, input.dir);
}

/** 目录 A 是否是目录 B 的严格祖先（含盘符根，如 `C:\` 是 `C:\Users\...` 的祖先）。 */
export function isPathAncestorOf(ancestor: string, descendant: string): boolean {
	const normalizedAncestor = normalizeSessionPathKey(ancestor);
	const normalizedDescendant = normalizeSessionPathKey(descendant);
	if (!normalizedAncestor || normalizedAncestor === normalizedDescendant) return false;
	return normalizedDescendant.startsWith(`${normalizedAncestor}/`);
}

/**
 * 选定目录的形态（决定弹窗文案：正常列表 / 「你选的是 pi 主目录」提示）。
 * - sessions-root / group：会话容器，按目录内文件列出；
 * - project：按会话记录里的原工作目录命中；
 * - ancestor：sessions 树的祖先目录（~/.pi、~/.pi/agent、用户主目录…），命中必然为 0，需要提示改选；
 * - none：以上都不是，也没有命中。
 */
export function classifyDirectorySource(input: {
	pickedIsContainer: boolean;
	probe: DirectoryShapeProbe;
	/** 命中候选总数（截断前） */
	matchedSessions: number;
	isAncestorOfSessionRoot: boolean;
}): DirectorySourceKind {
	// sessions 根：按设计列出树内全部会话（用户在列表里主动选「全部会话」才会走到这里）。
	if (input.probe.hasEncodedGroups) return "sessions-root";
	if (input.pickedIsContainer) return input.matchedSessions > 0 ? "group" : "none";
	if (input.matchedSessions > 0) return "project";
	return input.isAncestorOfSessionRoot ? "ancestor" : "none";
}

/** 「现有会话目录」列表条数上限（分组目录一般几十个，避免极端情况下 IPC 与渲染体量失控）。 */
export const DIRECTORY_SOURCE_MAX_DIRS = 100;

/** 分组结果（磁盘存在性由 DirectorySessionImporter 补齐）。 */
export type SessionSourceDirectoryGroup = Omit<DirectorySessionSourceDir, "projectPathExists">;

/**
 * 全量会话清单 → 「现有会话目录」列表：按会话文件所在目录分组。
 * 目录名是编码后的旧路径（`--D--work-old--`），用户无法凭名字判断该选哪个，
 * 所以列表里带上解码后的原工作目录、会话数、最后使用时间，让用户按项目认领。
 * 按最后使用时间倒序（最近用过的排最前），超上限截断。
 */
export function groupSessionSourceDirectories(sessions: readonly SessionSummary[]): SessionSourceDirectoryGroup[] {
	const groups = new Map<string, SessionSourceDirectoryGroup>();
	for (const summary of sessions) {
		if (!summary.filePath) continue;
		const dir = dirname(summary.filePath);
		const key = normalizeSessionPathKey(dir);
		const current = groups.get(key);
		if (!current) {
			groups.set(key, {
				dir,
				...(summary.projectPath ? { projectPath: summary.projectPath } : {}),
				sessionCount: 1,
				lastUsedAt: summary.updatedAt,
			});
			continue;
		}
		current.sessionCount += 1;
		// 同一分组目录通常只对应一个项目路径；取「最近一次会话」那条作为代表，
		// 保证列表展示的是用户最近在用、也是导入后要挂回的那个路径。
		if (summary.updatedAt >= current.lastUsedAt) {
			current.lastUsedAt = summary.updatedAt;
			if (summary.projectPath) current.projectPath = summary.projectPath;
		}
	}
	return [...groups.values()].sort((left, right) => right.lastUsedAt - left.lastUsedAt).slice(0, DIRECTORY_SOURCE_MAX_DIRS);
}

/** 会话文件路径 → 弹窗标题兜底名（拿不到会话名时的文件名 stem）。 */
export function fileStemTitle(filePath: string): string {
	const base = filePath.replace(/\\/g, "/").split("/").pop() ?? filePath;
	return base.replace(/\.jsonl$/i, "");
}

/** 扫描摘要 → 弹窗行（纯映射；projectPath 由扫描器从 encoded 目录名还原）。 */
export function toDirectorySessionSummary(input: {
	summary: SessionSummary;
	projectPath?: string;
	projectPathExists: boolean;
	/** catalog 里已有该文件（可能挂在别的项目下；导入 = 把归属改到当前项目） */
	alreadyImported: boolean;
}): DirectorySessionSummary {
	const title = input.summary.name?.replace(/\s+/g, " ").trim();
	return {
		id: input.summary.id,
		sourcePath: input.summary.filePath,
		title: title || fileStemTitle(input.summary.filePath),
		preview: input.summary.preview ?? "",
		...(input.projectPath ? { projectPath: input.projectPath } : {}),
		projectPathExists: input.projectPathExists,
		updatedAt: input.summary.updatedAt,
		messageCount: input.summary.messageCount,
		status: input.alreadyImported ? "current" : "new",
	};
}
