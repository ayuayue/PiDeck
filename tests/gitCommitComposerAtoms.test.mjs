import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const gitAtoms = loadTsCommonJs("src/renderer/src/atoms/git-atoms.ts");

test("Git commit composer patches stay on the originating repo after switching away", () => {
	const scopeA = gitAtoms.gitCommitScopeKey("project-a", "project-a");
	const scopeB = gitAtoms.gitCommitScopeKey("project-b", "project-b");
	assert.notEqual(scopeA, scopeB);

	gitAtoms.patchGitCommitComposer(scopeA, { generating: true, startedAt: 1000, message: "wip" });
	gitAtoms.patchGitCommitComposer(scopeB, { message: "other" });

	const a = gitAtoms.getGitCommitComposer(scopeA);
	const b = gitAtoms.getGitCommitComposer(scopeB);
	assert.equal(a.generating, true);
	assert.equal(a.startedAt, 1000);
	assert.equal(a.message, "wip");
	assert.equal(b.generating, false);
	assert.equal(b.message, "other");

	// 切到 B 期间 A 生成结束：只写回 A，不能冲掉 B 的草稿
	gitAtoms.patchGitCommitComposer(scopeA, {
		generating: false,
		startedAt: undefined,
		message: "feat: from a",
	});
	assert.equal(gitAtoms.getGitCommitComposer(scopeA).generating, false);
	assert.equal(gitAtoms.getGitCommitComposer(scopeA).message, "feat: from a");
	assert.equal(gitAtoms.getGitCommitComposer(scopeB).message, "other");
});
