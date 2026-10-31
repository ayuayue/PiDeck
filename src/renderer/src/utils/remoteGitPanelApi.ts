import type { OpOutcome } from "../../../shared/op";
import { opOutcomeOf } from "../../../shared/op";
import type {
	GitCommitResult,
	GitCompareRefsResult,
	GitHistoryPageResult,
	GitIndexMutationResult,
	GitReadSnapshotResult,
	GitRepositoryListing,
	GitResourceGroupType,
	GitWorkspaceFileDiff,
	RemoteGitBranchMutationResult,
	RemoteGitCommitDetailResult,
	RemoteGitDiscardResult,
	RemoteGitInitResult,
	RemoteGitRefFileDiffResult,
	RemoteGitRefsResult,
} from "../../../shared/types/git";
import type { ProjectFileTarget } from "../../../shared/types/project";
import type { PiDesktopApi } from "../../../preload";
import { PROJECT_SERVICE_CODES } from "../services/projectServiceContracts";
import type { ProjectServices } from "../services/projectServiceContracts";
import { errorCode, type RemoteGitViewApi } from "./remoteGitViewState";

/**
 * G4a：远端 Git 面板的唯一数据入口。
 *
 * 面板/控制器只认识 `RemoteGitViewApi`（已绑定项目的 `ProjectGitService` + 既有 `{ok,code}` 信封），
 * 授权令牌只留在 provider 内部，渲染层不再接触 `remoteSnapshot(...token)` 之类的签名。
 *
 * 失败归一（与 §8.2 的错误语义一致）：
 * - `ProjectServiceError` 的 `outcome === "unknown"` → `GIT_WRITE_RESULT_UNCONFIRMED`（写可能已落地，绝不重放）；
 * - `outcome === "rejected"` → 原稳定码；
 * - 其它异常 → 沿用 `remoteGitViewState` 的稳定码正则（不把 invoke 包装/自由文本带给用户）。
 *
 * 三个只读/取消入口在冻结契约里没有对应方法，这里直连既有 preload 通道并做代数围栏（调用前后
 * `services.isCurrent()`）：结果必须属于创建时的连接代。等集成者扩 `ProjectGitService` 后删除。
 */

type PanelFailure = { ok: false; code: string; outcome: OpOutcome };

const UNCONFIRMED = "GIT_WRITE_RESULT_UNCONFIRMED";

/** 结构判定：不依赖跨 realm 的 `instanceof ProjectServiceError`，只认契约字段（code + outcome）。 */
function isServiceFailure(error: unknown): error is { code: string; outcome: OpOutcome } {
	if (error === null || typeof error !== "object") return false;
	const candidate = error as { code?: unknown; outcome?: unknown };
	return typeof candidate.code === "string" && candidate.code.length > 0 && (candidate.outcome === "rejected" || candidate.outcome === "unknown");
}

function failureOf(error: unknown): PanelFailure {
	if (isServiceFailure(error)) {
		return error.outcome === "unknown" ? { ok: false, code: UNCONFIRMED, outcome: "unknown" } : { ok: false, code: error.code, outcome: "rejected" };
	}
	const code = errorCode(error);
	return { ok: false, code, outcome: opOutcomeOf(code) };
}

/** 无信封的方法（workspaceFileDiff / repos）把失败抛到控制器；抛出的 message 就是稳定码。 */
function failureError(failure: PanelFailure): Error {
	return Object.assign(new Error(failure.code), { code: failure.code, outcome: failure.outcome });
}

/**
 * 面板 → `ProjectServices` 的桥。每个方法只做三件事：项目作用域转换、委托服务、把服务失败折回信封。
 * 能力门禁在控制器（web 面板）里做，桥不重复判定“现在能不能用”，只保证不碰令牌。
 */
export function createRemoteGitPanelApi(services: ProjectServices, api: PiDesktopApi): RemoteGitViewApi {
	const projectId = services.projectId;
	/** "" 是项目根（服务约定：不传 repo 目标）；嵌套仓库传项目相对 target。 */
	const repo = (repoPath: string | undefined): ProjectFileTarget | undefined => (repoPath === undefined || repoPath === "" ? undefined : { projectId, relativePath: repoPath });
	const generationStale = (): PanelFailure => ({ ok: false, code: PROJECT_SERVICE_CODES.generationStale, outcome: "rejected" });

	/** 当前分支只是展示信息：能力关闭/读失败都不得影响已经成功的事实读。 */
	async function readBranch(repoPath: string | undefined): Promise<string | null> {
		if (!services.capabilities.git.branchRead) return null;
		try {
			const info = await services.git.branches(repo(repoPath));
			return info.current;
		} catch {
			return null;
		}
	}

	async function readSnapshot(repoPath: string | undefined, force: boolean, options?: { branch?: boolean }): Promise<GitReadSnapshotResult> {
		try {
			// 事实读是主结果；分支只是展示信息，两者并行，失败互不冒充（branch 失败 → null，不影响 groups）。
			const facts = force ? services.git.refresh(repo(repoPath)) : services.git.status(repo(repoPath));
			// 静默轮询传 { branch: false }：少一次远端往返，也不为“展示信息”多开 SSH。
			const branch = options?.branch === false ? null : readBranch(repoPath);
			const groups = await facts;
			// head 不再是渲染层的快照字段；契约结果里填 null，本项目快照只保留 groups + branch。
			return { ok: true, snapshot: { groups, head: null, branch: await branch } };
		} catch (error) {
			return failureOf(error);
		}
	}

	return {
		/* 契约缺口：冻结契约没有 cancel 入口；等集成者扩契约后删除。 */
		async cancelRemoteReads(): Promise<void> {
			if (!services.isCurrent()) return;
			try {
				await api.git.cancelRemoteReads(projectId);
			} catch {
				// 取消是尽力而为：调用方只关心下一次读不再发布旧结果。
			}
		},
		status: (repoPath, options) => readSnapshot(repoPath, false, options),
		refresh: (repoPath, options) => readSnapshot(repoPath, true, options),
		async branches(repoPath) {
			try {
				return { ok: true, info: await services.git.branches(repo(repoPath)) };
			} catch (error) {
				return failureOf(error);
			}
		},
		/* 契约缺口：公共历史页存在，但 commitDetail 没有对应服务方法。等集成者扩契约后删除。 */
		async commitDetail(oid, repoPath) {
			if (!services.isCurrent()) return generationStale();
			try {
				const result = await api.git.remoteCommitDetail(projectId, oid, repoPath === "" ? undefined : repoPath);
				if (!services.isCurrent()) return generationStale();
				return result;
			} catch (error) {
				return failureOf(error);
			}
		},
		async historyPage(options, repoPath): Promise<GitHistoryPageResult> {
			try {
				return { ok: true, value: await services.git.history(options, repo(repoPath)) };
			} catch (error) {
				return failureOf(error);
			}
		},
		async refs(repoPath): Promise<RemoteGitRefsResult> {
			try {
				const refs = await services.git.refs(repo(repoPath));
				// 契约的 GitRef {name,fullName,hash,type} → 面板的 RemoteGitRef {fullName,name,oid,kind}。
				return { ok: true, refs: { head: null, branch: null, refs: refs.map((ref) => ({ fullName: ref.fullName, name: ref.name, oid: ref.hash, kind: ref.type === "tag" ? "tag" : "branch" })) } };
			} catch (error) {
				return failureOf(error);
			}
		},
		/* 契约缺口：逐文件双版本差异没有对应服务方法。等集成者扩契约后删除。 */
		async refFileDiff(base, head, target, repoPath): Promise<RemoteGitRefFileDiffResult> {
			if (!services.isCurrent()) return generationStale();
			try {
				const result = await api.git.remoteRefFileDiff(projectId, base, head, target, repoPath === "" ? undefined : repoPath);
				if (!services.isCurrent()) return generationStale();
				return result;
			} catch (error) {
				return failureOf(error);
			}
		},
		async compareRefs(base, head, repoPath): Promise<GitCompareRefsResult> {
			try {
				return { ok: true, value: await services.git.compare(base, head, repo(repoPath)) };
			} catch (error) {
				return failureOf(error);
			}
		},
		async workspaceFileDiff(group: GitResourceGroupType, target: ProjectFileTarget, repoPath): Promise<GitWorkspaceFileDiff | null> {
			try {
				return (await services.git.workspaceDiff(group, target, repo(repoPath))) ?? null;
			} catch (error) {
				throw failureError(failureOf(error));
			}
		},
		async syncFacts(repoPath) {
			try {
				return { ok: true, facts: await services.git.syncFacts(repo(repoPath)) };
			} catch (error) {
				return failureOf(error);
			}
		},
		async repos(): Promise<GitRepositoryListing> {
			try {
				return await services.git.repos();
			} catch (error) {
				throw failureError(failureOf(error));
			}
		},
		async mutateIndex(operation, group, target, repoPath): Promise<GitIndexMutationResult> {
			try {
				if (operation === "stage") await services.git.stage([target], repo(repoPath));
				else await services.git.unstage([target], repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		async commit(message, repoPath): Promise<GitCommitResult> {
			try {
				await services.git.commit(message, repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		async discard(group, target, repoPath): Promise<RemoteGitDiscardResult> {
			try {
				const receipt = await services.git.discard([{ group, target }], repo(repoPath));
				return { ok: true, recoveryRef: receipt.recoveryRef ?? null };
			} catch (error) {
				return failureOf(error);
			}
		},
		async createBranch(name, repoPath): Promise<RemoteGitBranchMutationResult> {
			try {
				// 本机只支持 create-and-checkout，远端只支持 create：模式由能力表决定，桥不擅自改写。
				const mode = services.capabilities.git.branchCreateMode === "create-and-checkout" ? "create-and-checkout" : "create";
				await services.git.createBranch(name, mode, repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		async switchBranch(name, repoPath): Promise<RemoteGitBranchMutationResult> {
			try {
				// checkout 已经返回新的分支信息；读回面板快照由控制器随后的 refresh 完成。
				await services.git.checkout(name, repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		async recoveryList(repoPath) {
			try {
				const listing = await services.git.recoveryList(repo(repoPath));
				return { ok: true, entries: listing.entries, truncated: listing.truncated };
			} catch (error) {
				return failureOf(error);
			}
		},
		async recoveryRestore(ref, oid, path, repoPath) {
			try {
				await services.git.recoveryRestore({ ref, oid, path }, repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		async recoveryDrop(ref, oid, repoPath) {
			try {
				await services.git.recoveryDrop({ ref, oid }, repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		/*
		 * 显式同步：控制器已按 sync facts 校验过 remote/branch；桥内再核对一次，避免任何调用方把
		 * “同步到别的远端/分支”当成合法输入。任何 effect 都不会走到这里（自动 fetch 恒不存在）。
		 */
		async fetch(remote, repoPath) {
			try {
				const facts = await services.git.syncFacts(repo(repoPath));
				if (!facts.remotes.includes(remote)) return { ok: false, code: "GIT_SYNC_REMOTE_UNKNOWN", outcome: "rejected" };
				await services.git.fetch(repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		async push(remote, branch, repoPath) {
			try {
				const facts = await services.git.syncFacts(repo(repoPath));
				if (!facts.remotes.includes(remote)) return { ok: false, code: "GIT_SYNC_REMOTE_UNKNOWN", outcome: "rejected" };
				// 事实读之后分支变了：这不是可以盲目推送的对象。
				if (facts.branch !== branch) return { ok: false, code: "GIT_RESOURCE_CHANGED", outcome: "rejected" };
				await services.git.push(repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		async pull(remote, branch, repoPath) {
			try {
				const facts = await services.git.syncFacts(repo(repoPath));
				if (!facts.remotes.includes(remote)) return { ok: false, code: "GIT_SYNC_REMOTE_UNKNOWN", outcome: "rejected" };
				if (facts.branch !== branch) return { ok: false, code: "GIT_RESOURCE_CHANGED", outcome: "rejected" };
				await services.git.pull(repo(repoPath));
				return { ok: true };
			} catch (error) {
				return failureOf(error);
			}
		},
		async init(): Promise<RemoteGitInitResult> {
			try {
				const result = await services.git.init();
				return { ok: true, branch: result.branch };
			} catch (error) {
				return failureOf(error);
			}
		},
	};
}
