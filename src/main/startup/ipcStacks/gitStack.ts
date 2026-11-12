import type { BrowserWindow } from "electron";
import { registerGitIpc } from "../../ipc/gitIpc";
import type { registerRemoteGitReadIpc } from "../../ipc/remoteGitReadIpc";

type GitIpcDeps = Parameters<typeof registerGitIpc>[0];

/**
 * git 域 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * ctx 只承载该段真正用到的实例与闭包；mainWindow 走 getter（闭包里读到的是当前窗口）。
 * 调用顺序与搬迁前完全一致。
 */
export interface GitStackContext extends GitIpcDeps {
	readonly getMainWindow: () => BrowserWindow | null;
	readonly remoteGitReads: ReturnType<typeof registerRemoteGitReadIpc>;
}

export function registerGitStack(ctx: GitStackContext): void {
	const { appLogger, getMainWindow, gitRefsWatcher, gitService, mainCopy, piLocator, projectStore, remoteGitReads, settingsStore, worktreeService } = ctx;

	registerGitIpc({
		appLogger,
		mainCopy,
		gitService,
		gitRefsWatcher: gitRefsWatcher,
		getMainWindow,
		piLocator,
		projectStore,
		settingsStore,
		worktreeService,
		remoteGitReads,
	});
}
