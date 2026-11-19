/**
 * 远端暂存区 diff 的出口（AI 提交摘要的输入）。
 *
 * 从 `remoteGitReadIpc.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）。只读、无令牌、不改 index；
 * 失败照样只回稳定码。`read` 由宿主传入，保证它与其它远端读共用同一套 sender/代/取消边界。
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { RemoteGitStagedDiffResult } from "../../shared/types/git";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteGitService } from "../git/RemoteGitService";
import { failureEnvelope } from "./remoteGitFailureEnvelope";

export type RemoteGitStagedDiffPorts = {
	read<T>(event: IpcMainInvokeEvent, projectId: unknown, repoPath: string, task: (projectId: string, signal: AbortSignal) => Promise<T>): Promise<T>;
	git: Pick<RemoteGitService, "stagedDiff">;
	/** 旧调用方传字符串、共享通道传 ProjectFileTarget：统一归一到仓库 scope。 */
	compatRepo(projectId: string, value: unknown): string;
};

export function createRemoteGitStagedDiffIpc({ read, git, compatRepo }: RemoteGitStagedDiffPorts) {
	const stagedDiff = async (event: IpcMainInvokeEvent, projectId: unknown, repo: unknown): Promise<string> => {
		const repoPath = compatRepo(typeof projectId === "string" ? projectId : "", repo);
		return read(event, projectId, repoPath, (id, signal) => git.stagedDiff(id, repoPath, signal));
	};
	// 工厂即注册：调用方只在装配期创建一次，入口与返回值来自同一份闭包。
	ipcMain.handle(ipcChannels.gitRemoteStagedDiff, async (event, projectId: unknown, repo: unknown): Promise<RemoteGitStagedDiffResult> => {
		try {
			return { ok: true, value: { diff: await stagedDiff(event, projectId, repo) } };
		} catch (error) {
			return failureEnvelope(error);
		}
	});
	return { stagedDiff };
}
