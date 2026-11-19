/**
 * 提交图谱写动词的 IPC 出口（cherry-pick / revert / reset / drop）。
 *
 * 每个动词都要自己那枚令牌：`tokens.take` 在第一次 await 之前同步消费，并按 (窗口, 项目, 动作种类, 仓库)
 * 核对——所以一个面板签的授权不能被另一个仓库或另一个动作借用，失败的核对也不会烧掉用户手里的令牌。
 * helper 未声明对应能力时不签发令牌，入口天然缺席。
 *
 * 从 `remoteGitReadIpc.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）；`read` 由宿主传入，和其他远端写
 * 共用同一套 sender / 代 / 取消边界与「写后标脏」事实。
 */
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteGitBranchMutationResult } from "../../shared/types";
import type { RemoteGitMutationKind } from "../git/RemoteGitMutationTokens";
import type { RemoteGitService } from "../git/RemoteGitService";
import type { RemoteGitWriteExpectation } from "../git/RemoteGitReadShapes";
import { failureEnvelope } from "./remoteGitFailureEnvelope";

export type RemoteGitHistoryPorts = {
	read<T>(event: IpcMainInvokeEvent, projectId: unknown, repoPath: string, task: (projectId: string, signal: AbortSignal) => Promise<T>, mutating?: boolean): Promise<T>;
	git: Pick<RemoteGitService, "cherryPick" | "revert" | "reset" | "dropCommit">;
	tokens: { take(senderId: number, projectId: string, kind: RemoteGitMutationKind, repoPath: string, token: unknown): RemoteGitWriteExpectation };
	/** 远端通道只传相对的 POSIX 仓库路径；统一在入口收敛一次。 */
	repoScope(projectId: string, value: unknown): string;
};

export function createRemoteGitHistoryIpc({ read, git, tokens, repoScope }: RemoteGitHistoryPorts) {
	/**
	 * 四个动词的传输形状一致：`(projectId, hash, [mode,] token, repo)`；多出来的参数一律拒绝，
	 * 免得调用方以为还有其它开关（例如 force）而带上了却被静默忽略。
	 */
	const handler = (kind: RemoteGitMutationKind, invoke: (projectId: string, hash: unknown, mode: unknown, repoPath: string, take: (id: string) => RemoteGitWriteExpectation, signal: AbortSignal) => Promise<unknown>) => {
		return async (event: IpcMainInvokeEvent, projectId: unknown, hash: unknown, ...rest: unknown[]): Promise<RemoteGitBranchMutationResult> => {
			try {
				// reset 多一个 mode 位：其余动词的第三参就是 token。
				const withMode = kind === "reset";
				if (rest.length !== (withMode ? 4 : 3)) throw new Error("GIT_RESULT_INVALID");
				const mode = withMode ? rest[0] : undefined;
				const token = withMode ? rest[1] : rest[0];
				const repo = withMode ? rest[2] : rest[1];
				const extra = withMode ? rest[3] : rest[2];
				if (extra !== undefined) throw new Error("GIT_RESULT_INVALID");
				const repoPath = repoScope(typeof projectId === "string" ? projectId : "", repo);
				await read(event, projectId, repoPath, (id, signal) => invoke(id, hash, mode, repoPath, (value) => tokens.take(event.sender.id, value, kind, repoPath, token), signal), true);
				return { ok: true };
			} catch (error) {
				return failureEnvelope(error);
			}
		};
	};
	// 工厂即注册：调用方只在装配期创建一次，通道与闭包来自同一份实例。
	ipcMain.handle(
		ipcChannels.gitRemoteCherryPick,
		handler("cherryPick", (id, hash, _mode, repoPath, take, signal) => git.cherryPick(id, hash, take(id), repoPath, signal)),
	);
	ipcMain.handle(
		ipcChannels.gitRemoteRevert,
		handler("revert", (id, hash, _mode, repoPath, take, signal) => git.revert(id, hash, take(id), repoPath, signal)),
	);
	ipcMain.handle(
		ipcChannels.gitRemoteReset,
		handler("reset", (id, hash, mode, repoPath, take, signal) => git.reset(id, hash, mode, take(id), repoPath, signal)),
	);
	ipcMain.handle(
		ipcChannels.gitRemoteDropCommit,
		handler("dropCommit", (id, hash, _mode, repoPath, take, signal) => git.dropCommit(id, hash, take(id), repoPath, signal)),
	);
}
