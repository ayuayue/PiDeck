import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteGitMutationTokens } = loadTsCommonJs("src/main/git/RemoteGitMutationTokens.ts");

/**
 * 多仓并排（与 `GitDrawerHost` 同一布局）要求令牌按 **(sender, project, kind, repoPath)** 分区：
 *
 * - `issue` 的替换循环只顶掉**同一个仓库**的同种授权，B 仓的 stage 令牌不能吃掉 A 仓的；
 * - `git:remote-snapshot` 的 revoke 也只清自己那个仓库，A 仓刷新不影响 B 仓在途写；
 * - `revoke(sender)`（窗口销毁）仍是全清，这是安全边界而不是布局问题。
 *
 * 这组断言把「并排两个仓各自可写」钉成事实；任何回退到按 kind 覆盖的改动都会先在这里失败。
 */
const base = { kind: "index", revision: "a".repeat(64), hostRevision: 7, target: { hostId: "host", remotePath: "/owned/project" } };
const rootScope = { ...base, repoPath: "" };
const nestedScope = { ...base, repoPath: "packages/nested" };

test("并排两个仓库面板：各仓的同种授权互不影响", () => {
	const grants = createRemoteGitMutationTokens();
	const panelA = grants.issue(1, "project", rootScope);
	const panelB = grants.issue(1, "project", nestedScope);
	assert.equal(grants.take(1, "project", "index", "", panelA).repoPath, "");
	assert.equal(grants.take(1, "project", "index", "packages/nested", panelB).repoPath, "packages/nested");
});

test("snapshot 的 revoke 只清本仓：A 仓刷新不撤 B 仓授权", () => {
	const grants = createRemoteGitMutationTokens();
	const rootGrant = grants.issue(1, "project", rootScope);
	const nestedGrant = grants.issue(1, "project", nestedScope);
	// git:remote-snapshot 处理器的第一步：tokens.revoke(sender, project, repoPath)。
	grants.revoke(1, "project", "packages/nested");
	assert.equal(grants.take(1, "project", "index", "", rootGrant).repoPath, "");
	assert.throws(() => grants.take(1, "project", "index", "packages/nested", nestedGrant), /GIT_WRITE_SNAPSHOT_EXPIRED/);
	// 不带 repoPath 时仍是全清（窗口销毁/服务回收）。
	const after = grants.issue(1, "project", rootScope);
	grants.revoke(1);
	assert.throws(() => grants.take(1, "project", "index", "", after), /GIT_WRITE_SNAPSHOT_EXPIRED/);
});
