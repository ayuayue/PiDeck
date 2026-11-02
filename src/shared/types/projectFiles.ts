/**
 * 文件域的公共读取形状（v5 T6）：本地与 SSH 都返回同一份形状，调用方不需要知道位置。
 *
 * 三条约束写在这里，避免后续为了“对齐”而漂移：
 * - `revision`/`generation` 只描述**这份事实的新鲜度**，不是写入授权收据（文本编辑的 `version` 另算）；
 * - `hasChildren` 本机是 exact（`true|false`），远端只能是 `"unknown"`——不能把“没查过”伪装成“没有子项”；
 * - `ignored` 只是 Git 判定的修饰，不是过滤条件；保护性隐藏规则（系统目录/回收站）仍由 backend 过滤。
 */
import type { Op } from "../op";
import type { ProjectFileTarget } from "./project";

export type ProjectDirectoryEntry = {
	target: ProjectFileTarget;
	relativePath: string;
	type: "file" | "directory";
	hasChildren: boolean | "unknown";
	/**
	 * 本机 backend 的绝对路径（只给本机树保留既有 `FileTreeNode.path` 语义）。
	 * 远端投影绝不填本机路径：远端路径不能进入本机 fs API，调用方也不该拿它当路径。
	 */
	path?: string;
	/** 本机文件树排序用的元数据；远端条目缺席（远端面板不提供按时间/大小排序）。 */
	mtimeMs?: number;
	ctimeMs?: number;
	size?: number;
	/** Git ignore 修饰（仅当 backend 有 Git 判定时出现）；不是“隐藏”。 */
	ignored?: boolean;
};

/**
 * 深层目录订阅的降级（watch 能力不足，不是读失败）。
 *
 * helper 的 watcher 预算是 4×32：目录仍能读，但超出的目录不会实时刷新。必须显式带出来，
 * 否则文件树会把「没监听」呈现成「没变化」，用户以为远端已经同步。
 * 只带计数与原因：内部期望/覆盖路径列表留在主进程，不灌进每个目录页。
 */
export type ProjectDirectoryWatchDegradation = {
	degraded: true;
	/**
	 * `watch-failed`：helper 拒绝/无法建立订阅（不是预算不够）。目录仍可读，但不会实时刷新；
	 * 失败码放在 `code`，UI 必须把它带出来，否则用户只看到「降级」却不知道原因。
	 */
	reason: "paths-over-limit" | "watcher-capacity" | "watch-failed";
	/** 期望监听的目录数。 */
	desired: number;
	/** 真正被 watcher 覆盖的目录数。 */
	covered: number;
	/** 因预算没有覆盖到的目录数。 */
	dropped: number;
	/** helper 的稳定失败码（例如 METHOD_NOT_FOUND / PERMISSION_DENIED / TOO_MANY_REQUESTS）；无失败时缺席。 */
	code?: string;
};

export type ProjectDirectoryPage = {
	entries: ProjectDirectoryEntry[];
	truncated: boolean;
	/** 同一 generation 内的事实版本；不相等即表示内容被替换或标脏过。 */
	revision: number;
	/** 连接代（本机为稳定常量）；跨代一律丢弃缓存。 */
	generation: string;
	/** 仅当深层目录订阅降级时出现；正常覆盖时字段缺席（旧读者零影响）。 */
	dirWatch?: ProjectDirectoryWatchDegradation;
	/** 仅本机页在单层超限截断时出现：截断前总数，供文件树复现“目录过大”提示。 */
	totalEntries?: number;
};

export type ProjectDirectoryPageResult = Op<ProjectDirectoryPage>;

/** 批量存在性/类型（只读 fs 面；不签发任何 entry/文本授权）。 */
export type ProjectPathState = { target: ProjectFileTarget; exists: boolean; isDirectory: boolean };

export type ProjectPathsExistResult = Op<ProjectPathState[]>;
