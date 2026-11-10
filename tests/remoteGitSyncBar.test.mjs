import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/*
 * Regression guard for the sync bar's layout contract. The bar shipped once with its facts reloaded by an effect
 * that watched the snapshot: that fed off the panel's own refresh cycle, made the drawer change height under the
 * user, and destabilized the file-row menus until the real-machine cases went red. The product fix was a constant
 * geometry plus reading the facts only when the user (or a finished verb) asks for them; this test pins both, so a
 * future edit cannot quietly reintroduce the churn.
 */

const PANEL = "src/renderer/src/components/workspace/RemoteGitPanel.tsx";
const HOOK = "src/renderer/src/hooks/useRemoteGitView.ts";

test("the sync bar keeps a constant height and never reloads its facts from an effect", () => {
	const panel = readFileSync(PANEL, "utf8");
	// The facts row and the message row (or the confirmation that replaces it) all have the same fixed height, so
	// nothing below the bar can be pushed around by a sync fact arriving.
	assert.match(panel, /className="[^"]*\bh-6\b[^"]*"[^>]*>\s*<span[^>]*data-testid="remote-git-sync-facts"/, "the facts row must have a fixed height");
	assert.match(panel, /data-testid="remote-git-sync-message"[^>]*className="[^"]*\bh-6\b[^"]*"/, "the message row must reserve its height even when it is empty");
	assert.match(panel, /data-testid="remote-git-sync-push-confirm-bar"[^>]*className="[^"]*\bh-6\b[^"]*"/, "the confirmation that replaces the message row keeps the same height");
	// The churn root cause: an effect that watches the snapshot and calls loadSync.
	for (const effect of panel.split("useEffect(").slice(1)) {
		const body = effect.split("\n\t},")[0];
		assert.ok(!body.includes("loadSync"), `an effect must not load the sync facts (found in: ${body.split("\n")[1]?.trim() ?? ""})`);
	}
	// One facts load per project identity, started together with the first repository read (and only when read is
	// available) — the refresh carries the answer instead of dropping it, so the second load is never a second wait.
	const hook = readFileSync(HOOK, "utf8");
	assert.match(hook, /if \(!capabilities\.read\) reads\.setUnavailable\(blocked\["git\.read"\]/, "the initial read is a capability decision");
	assert.match(hook, /void reads\.refresh\(\);\s*reads\.loadSync\(\);/, "the facts are read once, in parallel with the first read");
	assert.equal(hook.split("reads.loadSync()").length - 1, 1, "the hook must not load the facts from anywhere else");
});
test("同步完成文案只陈述服务层确认的事实（不虚构 up-to-date / 快进 / 合并 / 引用计数）", () => {
	const source = readFileSync(PANEL, "utf8");
	assert.match(source, /remoteGit\.syncFetchedDone/);
	assert.match(source, /remoteGit\.syncPushedDone/);
	assert.match(source, /remoteGit\.syncPulledDone/);
	assert.doesNotMatch(source, /"up-to-date"|fast-forward|updated:/, "the panel must not invent sync details the service does not report");
});

test("非仓库时同步条整块不渲染：同一句仓库错误不重复，也不留一排永远 disabled 的同步按钮", () => {
	const panel = readFileSync(PANEL, "utf8");
	// 真机：项目根确认不是仓库后，仓库级错误在上方说明一次，同步条又把同一句 remoteGit.notRepository
	// 说第二遍，旁边还有 获取/推送/拉取；用户读到的是「还在检测却已经给出初始化」。
	assert.match(panel, /const repositoryMissing = snapshot === undefined && state\.errorCode === "GIT_NOT_REPOSITORY"/, "判据只认已确认的非仓库状态");
	assert.match(panel, /\{repositoryMissing \? null : \(\s*<div data-testid="remote-git-sync"/, "同步条整块不渲染");
	// 同步条里的错误行也不复述仓库级错误码（两道防线，任一处漏掉都会重现重复文案）。
	assert.match(panel, /state\.syncErrorCode && state\.syncErrorCode !== state\.errorCode/);
});
