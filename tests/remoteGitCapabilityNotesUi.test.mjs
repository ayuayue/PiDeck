/**
 * 远端 Git 能力说明条（task-5）的行为回归。
 *
 * 只验证用户能看到什么：纯函数按上下文决定是否显示；组件用 server render 断言文本与 data-testid。
 * 不新增 source-scan 测试（check:test-shape 会拦）。
 *
 * G4b 更新：能力条（RemoteGitCapabilityBanner）接手「哪些入口不可用 + 稳定原因」，
 * 说明条继续只解释只读区块的能力边界；本文件保留全部原断言，并补一条「不渲染假按钮」的锁定。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldShowRemoteGitCapabilityNote } = loadTsCommonJs("src/renderer/src/utils/remoteGitCapabilityNotes.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
const { RemoteGitCapabilityNote } = loadTsCommonJs("src/renderer/src/components/workspace/RemoteGitCapabilityNote.tsx", {
	stubs: { react: React },
});

const renderNote = (kind, context) => renderToStaticMarkup(React.createElement(RemoteGitCapabilityNote, { kind, context }));

test("说明条判据：按上下文显示，缺能力时不伪造入口", () => {
	assert.equal(shouldShowRemoteGitCapabilityNote("history", {}), false);
	assert.equal(shouldShowRemoteGitCapabilityNote("history", { historyOpen: true }), true);
	assert.equal(shouldShowRemoteGitCapabilityNote("commit", {}), false);
	assert.equal(shouldShowRemoteGitCapabilityNote("commit", { commitVisible: true }), true);
	assert.equal(shouldShowRemoteGitCapabilityNote("repoScope", { repoCount: 1 }), false);
	assert.equal(shouldShowRemoteGitCapabilityNote("repoScope", { repoCount: 2 }), true);
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareOpen: true, compareMode: "merge-base" }), false, "merge-base 有 ahead/behind，不需要 trees-only 说明");
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareOpen: true, compareMode: "trees" }), true);
	assert.equal(shouldShowRemoteGitCapabilityNote("compare", { compareMode: "trees" }), false, "未展开对比时不占位置");
});

test("history 说明条：HEAD-only、无过滤/总数/提交图", () => {
	const html = renderNote("history", { historyOpen: true });
	assert.match(html, /data-testid="remote-git-capability-note-history"/);
	assert.match(html, /HEAD/);
	assert.match(html, /提交总数|total count/);
	assert.match(html, /提交图|commit graph/);
});

test("commit 说明条：逐文件暂存、无批量/智能/AI", () => {
	const html = renderNote("commit", { commitVisible: true });
	assert.match(html, /data-testid="remote-git-capability-note-commit"/);
	assert.match(html, /批量暂存/);
	assert.match(html, /AI/);
	assert.match(html, /智能提交/);
});

test("repoScope 说明条：只在多仓时出现，明确一次一个仓", () => {
	assert.equal(renderNote("repoScope", { repoCount: 1 }), "");
	const html = renderNote("repoScope", { repoCount: 2 });
	assert.match(html, /data-testid="remote-git-capability-note-repoScope"/);
	assert.match(html, /一次只读一个仓库/);
	assert.match(html, /不能并排/);
});

test("compare 说明条：trees-only，无 merge-base / ahead-behind", () => {
	assert.equal(renderNote("compare", { compareOpen: true, compareMode: "merge-base" }), "");
	const html = renderNote("compare", { compareOpen: true, compareMode: "trees" });
	assert.match(html, /data-testid="remote-git-capability-note-compare"/);
	assert.match(html, /merge-base/);
	assert.match(html, /ahead／behind|ahead\/behind/);
});

test("多仓说明 key 在中英词典都存在；compareHint 已改为 trees-only 表述", () => {
	for (const dictionary of [zhCN, enUS]) {
		assert.ok(dictionary["remoteGit.repoScopeSingle"]);
	}
	assert.match(zhCN["remoteGit.compareHint"], /merge-base/);
	assert.match(enUS["remoteGit.compareHint"], /merge-base/);
});

/**
 * 能力说明条与 G4b 能力条的分工：说明条解释「这个位置没有哪些只读能力」（文案），
 * 能力条（RemoteGitCapabilityBanner）解释「这些入口现在不可用及第一条稳定原因」。
 * 两者都只解释，绝不渲染假按钮或成功分支——这条断言防止未来把说明条改成可点击入口。
 */
test("说明条只解释缺失能力：不渲染按钮、链接或成功分支", () => {
	const renders = [renderNote("history", { historyOpen: true }), renderNote("commit", { commitVisible: true }), renderNote("repoScope", { repoCount: 2 }), renderNote("compare", { compareOpen: true, compareMode: "trees" })];
	for (const html of renders) {
		assert.ok(html.length > 0, "the note must render where it applies");
		assert.doesNotMatch(html, /<button/i);
		assert.doesNotMatch(html, /role="button"/);
		assert.doesNotMatch(html, /onClick/);
		assert.doesNotMatch(html, /data-testid="remote-git-(?:sync-push-confirm|init-confirm|discard-confirm|recovery-drop-confirm)"/);
	}
});
