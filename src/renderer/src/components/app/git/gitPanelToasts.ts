/**
 * Git 面板的 toast 常量与稳定 id（从 `GitPanel.tsx` 原样搬出）。
 *
 * 稳定 id 让同一仓库的同一操作顶掉旧条，而不是堆一排；生成摘要的进度条上限也与
 * 主进程 quickGenerate 的 60s 预算对齐，避免用户误以为卡住。
 *
 * 注意：真正读写 composer atom 的 `finishCommitGen` 仍留在面板里——它依赖 atoms，
 * 而契约测试会把 jotai 替身化，跨层 import `atoms` 的模块在那种环境里加载不起来。
 */
import { t } from "../../../i18n";
import { type NoticeId, showNotice } from "../../../utils/notice";

/** 与主进程 quickGenerate 60s 上限对齐：面板进度条按此时长爬升，避免用户误以为卡住。 */
export const COMMIT_GEN_TIMEOUT_MS = 60_000;

/** 错误 toast 必须有正文：showNotice 会丢掉空串，失败就会看起来像“没反应”。 */
export function commitGenNoticeText(message: string | undefined, fallback: string) {
	const text = String(message ?? "").trim();
	return text || fallback;
}

/** 首次推送 "no upstream branch" 的识别：此类失败给“设置上游”引导而非裸报错。 */
export const NO_UPSTREAM_RE = /no upstream branch/i;

/** 操作失败 toast 的稳定 id：同仓库同操作连发时顶掉旧条，避免堆一排。 */
export function gitErrorToastId(scopeKey: string, kind: "push" | "pull" | "commit"): NoticeId {
	return `git-op:${kind}:${scopeKey}`;
}

export function commitGenToastId(scopeKey: string): NoticeId {
	return `git-commit-gen:${scopeKey}`;
}

export function showCommitGenProgressToast(scopeKey: string) {
	// 稳定 id：切走再回来是更新同一条，而不是再堆一条；面板卸载后 finish 也能按 id 关掉。
	showNotice(t("git.generateCommitMessageProgress"), Number.POSITIVE_INFINITY, undefined, undefined, undefined, commitGenToastId(scopeKey));
}
