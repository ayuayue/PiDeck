import { OP_UNKNOWN_CODES, STABLE_CODE_PATTERN } from "../../../shared/op";
import { assertProjectServiceCurrent, PROJECT_SERVICE_CODES, ProjectServiceError, type ProjectFileService, type ProjectFileTarget, type ProjectGitService, type ProjectServiceFence } from "./projectServiceContracts";

/**
 * 服务的共同边界：项目身份、连接代与失败归一。
 *
 * - 身份：服务实例绑定 projectId，target/repoPath 数组的每一项都必须一致；不一致在触达 IPC 前拒绝；
 * - 代数：await 之后比较 fence 槽位。读路径 stale = rejected（可丢弃后重读）；
 *   写路径 stale = unknown（写可能已落地，禁止自动重放）；
 * - 失败：raw IPC 通道只抛 Electron Error；这里只提取稳定码形状（main 的既定约定）并给出中性回退，
 *   不让“远端失败”冒充本机错误，也不猜自由文本。
 */

export function assertProjectTarget(projectId: string, target: ProjectFileTarget): void {
	if (target.projectId !== projectId) throw new ProjectServiceError(PROJECT_SERVICE_CODES.projectMismatch, "rejected", "target project does not match the service");
}

export function assertProjectTargets(projectId: string, targets: readonly ProjectFileTarget[]): void {
	for (const target of targets) assertProjectTarget(projectId, target);
}

export function assertRepoScope(projectId: string, repoPath: ProjectFileTarget | undefined): void {
	if (repoPath !== undefined) assertProjectTarget(projectId, repoPath);
}

const STABLE_IN_MESSAGE = /(?:Error invoking remote method '[^']*':\s*)?(?:Error:\s*)?([A-Z][A-Z0-9_]{2,63})(?![A-Za-z0-9_])/;

/** 把 raw IPC/领域 Error 归一成稳定码 + outcome；已是 ProjectServiceError 的保持原样。 */
export function normalizeProjectServiceError(error: unknown): ProjectServiceError {
	if (error instanceof ProjectServiceError) return error;
	const attached = error as { code?: unknown; outcome?: unknown } | null;
	const attachedCode = typeof attached?.code === "string" && STABLE_CODE_PATTERN.test(attached.code) ? attached.code : undefined;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
	const code = attachedCode ?? STABLE_IN_MESSAGE.exec(message)?.[1] ?? PROJECT_SERVICE_CODES.failed;
	const outcome = attached?.outcome === "unknown" || OP_UNKNOWN_CODES.has(code) ? "unknown" : "rejected";
	return new ProjectServiceError(code, outcome, message.length > 0 ? message.slice(0, 300) : undefined);
}

/** 把一次异步实现包上代数围栏；旧代成功/失败都不能作为本次结果发布，raw 失败统一归一。 */
export function fenced<A extends unknown[], R>(fence: ProjectServiceFence, run: (...args: A) => Promise<R>, staleOutcome: "rejected" | "unknown" = "rejected"): (...args: A) => Promise<R> {
	return async (...args: A): Promise<R> => {
		try {
			const result = await run(...args);
			assertProjectServiceCurrent(fence, staleOutcome);
			return result;
		} catch (error) {
			assertProjectServiceCurrent(fence, staleOutcome);
			throw normalizeProjectServiceError(error);
		}
	};
}

export function fenceProjectFileService(fence: ProjectServiceFence, service: ProjectFileService): ProjectFileService {
	return {
		listDirectory: fenced(fence, service.listDirectory),
		searchFiles: fenced(fence, service.searchFiles),
		searchContent: fenced(fence, service.searchContent),
		readText: fenced(fence, service.readText),
		writeText: fenced(fence, service.writeText, "unknown"),
		stat: fenced(fence, service.stat),
		createEntry: fenced(fence, service.createEntry, "unknown"),
		renameEntry: fenced(fence, service.renameEntry, "unknown"),
		moveEntry: fenced(fence, service.moveEntry, "unknown"),
		deleteEntry: fenced(fence, service.deleteEntry, "unknown"),
		openInEditor: fenced(fence, service.openInEditor),
		showInFolder: fenced(fence, service.showInFolder),
	};
}

export function fenceProjectGitService(fence: ProjectServiceFence, service: ProjectGitService): ProjectGitService {
	return {
		status: fenced(fence, service.status),
		refresh: fenced(fence, service.refresh),
		history: fenced(fence, service.history),
		repos: fenced(fence, service.repos),
		refs: fenced(fence, service.refs),
		compare: fenced(fence, service.compare),
		workspaceDiff: fenced(fence, service.workspaceDiff),
		branches: fenced(fence, service.branches),
		createBranch: fenced(fence, service.createBranch, "unknown"),
		checkout: fenced(fence, service.checkout, "unknown"),
		stage: fenced(fence, service.stage, "unknown"),
		unstage: fenced(fence, service.unstage, "unknown"),
		commit: fenced(fence, service.commit, "unknown"),
		discard: fenced(fence, service.discard, "unknown"),
		fetch: fenced(fence, service.fetch, "unknown"),
		pull: fenced(fence, service.pull, "unknown"),
		push: fenced(fence, service.push, "unknown"),
		syncFacts: fenced(fence, service.syncFacts),
		recoveryList: fenced(fence, service.recoveryList),
		recoveryRestore: fenced(fence, service.recoveryRestore, "unknown"),
		recoveryDrop: fenced(fence, service.recoveryDrop, "unknown"),
		init: fenced(fence, service.init, "unknown"),
		deleteFiles: fenced(fence, service.deleteFiles, "unknown"),
		worktreeList: fenced(fence, service.worktreeList),
		worktreeCreate: fenced(fence, service.worktreeCreate, "unknown"),
		worktreeRemove: fenced(fence, service.worktreeRemove, "unknown"),
		aheadBehind: fenced(fence, service.aheadBehind),
	};
}
