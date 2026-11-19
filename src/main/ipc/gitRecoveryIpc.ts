/**
 * 本机「可还原丢弃」的三个通道（list / restore / drop）。
 *
 * 从 `gitIpc.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）。这里只做**形状门卫 + 转发**：
 * 语义（ref 前缀、oid 40/64 hex、路径越界、覆盖保护）统一在 `LocalGitRecovery` 里，
 * 避免 IPC 层和恢复实现各写一套白名单。
 */
import type { IpcMainInvokeEvent } from "electron";
import type { GitRecoveryListing } from "../../shared/types/git";
import { ipcChannels } from "../../shared/ipc";

/** 渲染层回传的恢复条目是未受信输入：这里只守形状与长度。 */
function parseRecoveryEntry(value: unknown): { ref: string; oid: string; path?: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("INVALID_GIT_RECOVERY_ENTRY");
	const { ref, oid, path } = value as Record<string, unknown>;
	if (typeof ref !== "string" || ref.length === 0 || ref.length > 512) throw new Error("INVALID_GIT_RECOVERY_ENTRY");
	if (typeof oid !== "string" || oid.length === 0 || oid.length > 128) throw new Error("INVALID_GIT_RECOVERY_ENTRY");
	if (path === undefined) return { ref, oid };
	if (typeof path !== "string" || path.length === 0 || path.length > 32_768) throw new Error("INVALID_GIT_RECOVERY_ENTRY");
	return { ref, oid, path };
}

export type GitRecoveryIpcPorts = {
	/** 已绑定“可信项目 + WSL 身份”的 handler 注册器（与其它 Git 通道同一条边界）。 */
	handle<Args extends unknown[], Result>(channel: string, listener: (event: IpcMainInvokeEvent, ...args: Args) => Result): void;
	/** 三个动作对 `GitService` 的最小依赖；不传整个 service，避免这层知道别的写面。 */
	recovery: {
		recoveryList(cwd: string): Promise<GitRecoveryListing>;
		recoveryRestore(cwd: string, entry: { ref: string; oid: string; path: string }): Promise<{ path: string; bytes: number }>;
		recoveryDrop(cwd: string, entry: { ref: string; oid: string }): Promise<void>;
	};
	/** 与其它 Git 通道同一个仓库根解析（含嵌套仓库 scope 校验）。 */
	requireGitCwd(projectId: string, repoPath?: unknown): Promise<string>;
	info(message: string, meta: Record<string, unknown>): void;
};

export function registerGitRecoveryIpc({ handle, recovery, requireGitCwd, info }: GitRecoveryIpcPorts): void {
	handle(ipcChannels.gitRecoveryList, async (_event, projectId: string, repoPath?: unknown): Promise<GitRecoveryListing> => {
		return recovery.recoveryList(await requireGitCwd(projectId, repoPath));
	});

	handle(ipcChannels.gitRecoveryRestore, async (_event, projectId: string, rawEntry: unknown, repoPath?: unknown) => {
		const entry = parseRecoveryEntry(rawEntry);
		if (entry.path === undefined) throw new Error("INVALID_GIT_RECOVERY_ENTRY");
		const cwd = await requireGitCwd(projectId, repoPath);
		const restored = await recovery.recoveryRestore(cwd, { ref: entry.ref, oid: entry.oid, path: entry.path });
		info("Recovery snapshot restored", { projectId, ref: entry.ref, path: restored.path, bytes: restored.bytes });
		return restored;
	});

	handle(ipcChannels.gitRecoveryDrop, async (_event, projectId: string, rawEntry: unknown, repoPath?: unknown) => {
		const entry = parseRecoveryEntry(rawEntry);
		const cwd = await requireGitCwd(projectId, repoPath);
		await recovery.recoveryDrop(cwd, { ref: entry.ref, oid: entry.oid });
		info("Recovery snapshot dropped", { projectId, ref: entry.ref, oid: entry.oid });
	});
}
