/**
 * 提交图谱写动词的数据面：cherry-pick / revert / reset / drop。
 *
 * 单独成模块的原因与 `RemoteGitHistoryContract.ts` 相同——`RemoteGitService.ts` 已在体量门禁的基线上。
 * 这里不做任何语义决定，只做三件事：把面板传来的 hash 收敛成完整 OID、确认令牌种类与快照授予一致、
 * 校验 helper 的回执形状。真正的门禁（hooks/filters/sequencer/身份/CAS）都在冻结 helper 里。
 *
 * `expected.head` 是读取时确认的 HEAD：没有它就等于没有可移动的起点，所以在触达会话前就拒绝，
 * 而不是把 null 发下去让 helper 报一个含义不同的错。
 */
import { REMOTE_GIT_HISTORY_METHODS, REMOTE_GIT_RESET_MODES, type RemoteGitHistoryMethod, type RemoteGitResetMode } from "../remote/RemoteGitHistoryContract";
import { record, REMOTE_GIT_OID_PATTERN, type RemoteGitWriteExpectation } from "./RemoteGitReadShapes";

/** `run` is the service's own request path; the parse callback sees only the helper's reply. */
export type RemoteGitHistoryRun = (projectId: string, method: RemoteGitHistoryMethod, params: unknown, signal: AbortSignal | undefined, parse: (value: unknown) => unknown, expected: RemoteGitWriteExpectation, repo: string) => Promise<unknown>;

export type RemoteGitHistoryOutcome = { applied: true; head: string };

function assertHash(value: unknown): string {
	if (typeof value !== "string" || !REMOTE_GIT_OID_PATTERN.test(value)) throw new Error("GIT_RESULT_INVALID");
	return value;
}

/** The reply is exactly `{ applied: true, head }`; anything else is not the answer this verb promises. */
function readOutcome(value: unknown): RemoteGitHistoryOutcome {
	if (!record(value) || value.applied !== true || Object.keys(value).length !== 2) throw new Error("GIT_RESULT_INVALID");
	return { applied: true, head: assertHash(value.head) };
}

/** A grant for another action is a caller bug and never reaches the helper. */
function assertKind(expected: RemoteGitWriteExpectation, kind: RemoteGitWriteExpectation["kind"]): string {
	if (expected.kind !== kind) throw new Error("GIT_RESULT_INVALID");
	// 历史写动作都从一个已确认的 HEAD 出发；没有 HEAD 就没有可移动的起点。
	if (typeof expected.head !== "string" || !REMOTE_GIT_OID_PATTERN.test(expected.head)) throw new Error("GIT_COMMIT_HEAD_CHANGED");
	return expected.head;
}

export function createRemoteGitHistoryMethods({ run }: { run: RemoteGitHistoryRun }) {
	function history(kind: RemoteGitWriteExpectation["kind"], method: RemoteGitHistoryMethod, projectId: string, hash: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal): Promise<RemoteGitHistoryOutcome> {
		const expectedHead = assertKind(expected, kind);
		const oid = assertHash(hash);
		return run(projectId, method, { hash: oid, expectedHead }, signal, readOutcome, expected, repoPath) as Promise<RemoteGitHistoryOutcome>;
	}
	return {
		/** 把一个提交的改动复制到当前分支顶端，形成新的提交。 */
		cherryPick: (projectId: string, hash: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal) => history("cherryPick", REMOTE_GIT_HISTORY_METHODS[0], projectId, hash, expected, repoPath, signal),
		/** 生成一个反向提交，撤销该提交的改动。 */
		revert: (projectId: string, hash: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal) => history("revert", REMOTE_GIT_HISTORY_METHODS[1], projectId, hash, expected, repoPath, signal),
		/** 把当前分支指针移到该提交；`hard` 还会重写工作区，所以只有干净工作区才被确认为成功。 */
		reset: (projectId: string, hash: unknown, mode: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal) => {
			if (typeof mode !== "string" || !REMOTE_GIT_RESET_MODES.includes(mode as RemoteGitResetMode)) throw new Error("GIT_RESULT_INVALID");
			const expectedHead = assertKind(expected, "reset");
			const oid = assertHash(hash);
			return run(projectId, REMOTE_GIT_HISTORY_METHODS[2], { hash: oid, expectedHead, mode }, signal, readOutcome, expected, repoPath) as Promise<RemoteGitHistoryOutcome>;
		},
		/** 从当前分支删掉该提交：本机的 `rebase --onto <parent> <hash>`。 */
		dropCommit: (projectId: string, hash: unknown, expected: RemoteGitWriteExpectation, repoPath: string, signal?: AbortSignal) => history("dropCommit", REMOTE_GIT_HISTORY_METHODS[3], projectId, hash, expected, repoPath, signal),
	};
}
