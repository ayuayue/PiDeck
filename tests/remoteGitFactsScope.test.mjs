/**
 * Git 面板的事实失效取舍（M2）：主进程只标脏，面板必须自己订阅并只重读本仓库。
 *
 * 背景：hook 曾删掉直订、改依赖 services runtime，但 runtime 对「同代事实事件」直接 return（不重建、不通知），
 * 于是写成功/未知写/文件写发出的 status 标脏到不了面板，只剩 5s 轮询兜底。这里锁定筛选判据与 hook 订阅接线。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { shouldRefreshRemoteGitOnFactsChange } = loadTsCommonJs("src/renderer/src/utils/remoteGitFactsScope.ts");
const HOOK = "src/renderer/src/hooks/useRemoteGitView.ts";
const change = (scopes, overrides = {}) => ({ projectId: "project", generation: "ssh:h:1", scopes, ...overrides });

test("只认本项目、本仓库的 status 失效", () => {
	assert.equal(shouldRefreshRemoteGitOnFactsChange(change([{ kind: "status", repoPath: "" }]), "project", ""), true);
	assert.equal(shouldRefreshRemoteGitOnFactsChange(change([{ kind: "status", repoPath: "packages/a" }]), "project", "packages/a"), true);
	// 别的仓库 scope 不能刷新这个仓库
	assert.equal(shouldRefreshRemoteGitOnFactsChange(change([{ kind: "status", repoPath: "packages/b" }]), "project", "packages/a"), false);
	assert.equal(shouldRefreshRemoteGitOnFactsChange(change([{ kind: "status", repoPath: "" }]), "project", "packages/a"), false);
});

test("别的项目、目录/整树/仓库发现事件都不刷新 Git 面板", () => {
	assert.equal(shouldRefreshRemoteGitOnFactsChange(change([{ kind: "status", repoPath: "" }], { projectId: "other" }), "project", ""), false);
	for (const scope of [{ kind: "dir", path: "src" }, { kind: "tree" }, { kind: "repos" }]) {
		assert.equal(shouldRefreshRemoteGitOnFactsChange(change([scope]), "project", ""), false, JSON.stringify(scope));
	}
	assert.equal(shouldRefreshRemoteGitOnFactsChange(change([]), "project", ""), false);
});

test("混合 scopes 里只要命中本仓库 status 就刷新", () => {
	const mixed = change([{ kind: "dir", path: "src" }, { kind: "status", repoPath: "" }, { kind: "tree" }]);
	assert.equal(shouldRefreshRemoteGitOnFactsChange(mixed, "project", ""), true);
});

test("hook 真的订阅了项目事实：status 命中时 force 重读，且不再依赖 runtime 的同代通知", () => {
	const hook = readFileSync(HOOK, "utf8");
	assert.match(hook, /import \{ acquireProjectFactSubscription \} from "\.\.\/services\/projectServiceFactSubscription"/);
	assert.match(hook, /import \{ shouldRefreshRemoteGitOnFactsChange \} from "\.\.\/utils\/remoteGitFactsScope"/);
	assert.match(hook, /acquireProjectFactSubscription\(project, desktopApi, \{/);
	const block = hook.slice(hook.indexOf("acquireProjectFactSubscription(project, desktopApi"), hook.indexOf("}, [project, repoPath]);"));
	assert.ok(block.indexOf("shouldRefreshRemoteGitOnFactsChange(change, project.id, repoPath)") >= 0, "the scope filter must run first");
	assert.ok(block.indexOf("controller.current?.refresh(true)") > block.indexOf("shouldRefreshRemoteGitOnFactsChange"), "only a matching scope may force a fresh read");
	assert.ok(block.indexOf("return release") >= 0 || hook.includes("return release"), "the subscription must be released on cleanup");
	assert.ok(!/subscribeRemoteGitFacts|remoteHosts\.onStateChange/.test(hook), "the hook must use the shared project fact subscription, not a second preload one");
});
