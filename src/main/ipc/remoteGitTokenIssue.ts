/**
 * 快照 → 授权令牌的唯一签发点。
 *
 * 从 `remoteGitReadIpc.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）：那里原本是一段逐个
 * `if (xExpectation) snapshot.xToken = ...` 的清单，每加一个写动词就要动那个巨文件。现在清单在这里，
 * 巨文件只留三行调用。
 *
 * 两条不变量保持原样：
 * - 纯事实快照（`factsOnly`）不带任何令牌——渲染层可以"只看事实"地强刷一次，不会因此多拿到授权；
 * - 令牌只按 (发送者, 项目, 动作种类, 仓库) 签发；跨窗口、跨仓库都用不了，这也正是多仓并排不互撤的原因。
 */
import type { GitReadSnapshot } from "../../shared/types/git";
import type { createRemoteGitMutationTokens } from "../git/RemoteGitMutationTokens";
import type { RemoteGitReadSnapshot, RemoteGitWriteExpectation } from "../git/RemoteGitReadShapes";

type Tokens = ReturnType<typeof createRemoteGitMutationTokens>;

/** 一个写动词的授予字段与它对应的令牌字段；两者必须成对出现，缺一个就等于没有入口。 */
const GRANTS: readonly { expectation: keyof RemoteGitReadSnapshot; token: keyof GitReadSnapshot }[] = [
	{ expectation: "writeExpectation", token: "mutationToken" },
	{ expectation: "commitExpectation", token: "commitToken" },
	{ expectation: "branchExpectation", token: "branchToken" },
	{ expectation: "switchExpectation", token: "switchToken" },
	{ expectation: "discardExpectation", token: "discardToken" },
	{ expectation: "restoreExpectation", token: "restoreToken" },
	{ expectation: "dropExpectation", token: "dropToken" },
	{ expectation: "cherryPickExpectation", token: "cherryPickToken" },
	{ expectation: "revertExpectation", token: "revertToken" },
	{ expectation: "resetExpectation", token: "resetToken" },
	{ expectation: "dropCommitExpectation", token: "dropCommitToken" },
	{ expectation: "fetchExpectation", token: "fetchToken" },
	{ expectation: "pushExpectation", token: "pushToken" },
	{ expectation: "pullExpectation", token: "pullToken" },
];

/** 事实部分：读快照里除授权之外的一切，纯事实出口与令牌出口共用同一份取值。 */
export function remoteGitSnapshotFacts(source: RemoteGitReadSnapshot): GitReadSnapshot {
	return { groups: source.groups, head: source.head, branch: source.branch };
}

/** 为这份已确认事实签发每个动作各自的令牌；返回是否真的签发了（只有签发过才需要盯住发送者）。 */
export function issueRemoteGitTokens(senderId: number, projectId: string, tokens: Tokens, source: RemoteGitReadSnapshot): { snapshot: GitReadSnapshot; issued: boolean } {
	const snapshot = remoteGitSnapshotFacts(source);
	for (const grant of GRANTS) {
		const expectation = source[grant.expectation] as RemoteGitWriteExpectation | undefined;
		if (expectation === undefined) continue;
		(snapshot[grant.token] as string | undefined) = tokens.issue(senderId, projectId, expectation);
	}
	return { snapshot, issued: GRANTS.some((grant) => source[grant.expectation] !== undefined) };
}
