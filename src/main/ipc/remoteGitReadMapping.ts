/**
 * helper 读结果 → 公共 Git 通道形状（历史页 / 比较）。
 *
 * 从 `remoteGitReadIpc.ts` 拆出（文件体量门禁：存量巨文件只准降不准升）。纯映射：不读会话、不做授权；
 * 唯一有语义的地方是「三点的 ahead/behind 缺席 ≠ 0」与「总数只在 helper 给了才带上」。
 */
import type { GitCompareRefsValue, GitHistoryPage, RemoteGitCompare, RemoteGitLogPage } from "../../shared/types/git";

/** 远端历史页：`total` 只在调用方要过总数时出现，缺席不填 0。 */
export function toHistoryPage(page: RemoteGitLogPage): GitHistoryPage {
	return {
		commits: page.commits.map((commit) => ({
			oid: commit.oid,
			parents: [...commit.parents],
			subject: commit.subject,
			authorName: commit.authorName,
			authorEmail: commit.authorEmail,
			authorTimeMs: commit.authorTimeSec * 1000,
		})),
		hasMore: page.hasMore,
		...(page.total === undefined ? {} : { totalCount: page.total }),
	};
}

/** 远端比较：答案自己声明语义（merge-base 才有 ahead/behind），两树不补 0/0。 */
export function toCompareValue(compare: RemoteGitCompare): GitCompareRefsValue {
	const threeDot = compare.ahead !== undefined && compare.behind !== undefined;
	return {
		mode: threeDot ? "merge-base" : "trees",
		base: { ref: compare.base.ref, oid: compare.base.oid },
		head: { ref: compare.head.ref, oid: compare.head.oid },
		files: compare.files.map((file) => ({ status: file.status, path: file.path, ...(file.oldPath === undefined ? {} : { oldPath: file.oldPath }) })),
		...(threeDot ? { ahead: compare.ahead, behind: compare.behind } : {}),
	};
}
