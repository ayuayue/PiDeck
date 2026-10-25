import { atom, getDefaultStore } from "jotai";

/**
 * Git 提交框草稿 + AI 摘要生成态。
 * 必须按仓库 scope 常驻：GitPanel 切项目会复用同一实例，抽屉卸载也会丢掉 useState；
 * 生成中途切走再回来时，进度条、loading 和写回摘要都要从这里恢复。
 */
export type GitCommitComposerState = {
	message: string;
	generating: boolean;
	/** Date.now()，用于切回后按已过时间续跑进度条，而不是从 0 重开。 */
	startedAt?: number;
};

export const EMPTY_GIT_COMMIT_COMPOSER: GitCommitComposerState = {
	message: "",
	generating: false,
};

/** `projectId` + 嵌套仓 `repoScopeKey`；根仓没有独立 repo 时后者与 projectId 相同。 */
export function gitCommitScopeKey(projectId: string, repoScopeKey?: string): string {
	return `${projectId}::${repoScopeKey ?? projectId}`;
}

export const gitCommitComposerByScopeAtom = atom<Record<string, GitCommitComposerState>>({});

/**
 * 用 default store 写入，生成收尾可能发生在面板已切走/卸载之后。
 * 只补传入字段：成功写 message 时不要被 finally 的 generating:false 冲掉正文。
 */
function gitCommitComposerStore() {
	return getDefaultStore();
}

export function getGitCommitComposer(scopeKey: string): GitCommitComposerState {
	return gitCommitComposerStore().get(gitCommitComposerByScopeAtom)[scopeKey] ?? EMPTY_GIT_COMMIT_COMPOSER;
}

export function patchGitCommitComposer(scopeKey: string, patch: Partial<GitCommitComposerState>): GitCommitComposerState {
	const store = gitCommitComposerStore();
	const all = store.get(gitCommitComposerByScopeAtom);
	const prev = all[scopeKey] ?? EMPTY_GIT_COMMIT_COMPOSER;
	const next: GitCommitComposerState = { ...prev, ...patch };
	store.set(gitCommitComposerByScopeAtom, { ...all, [scopeKey]: next });
	return next;
}
