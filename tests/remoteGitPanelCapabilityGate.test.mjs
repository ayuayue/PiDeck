/**
 * G4b 远端 Git 面板能力门禁（纯判据 + 能力条渲染 + 面板源码契约）。
 *
 * 目标：能力表是唯一入口判据（不再用快照令牌），且能力条只解释缺失入口、不渲染假按钮。
 * - 判据与原因码映射在 utils/remoteGitCapabilityView.ts，直接加载真模块断言行为；
 * - 能力条组件用 server render 断言文本与 data-testid；
 * - 面板门禁点（按钮/分区 effect/refs 轮询/无自动 fetch）用源码断言锁定，防止回退到令牌或漏门禁。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const panel = readFileSync("src/renderer/src/components/workspace/RemoteGitPanel.tsx", "utf8");
const view = loadTsCommonJs("src/renderer/src/utils/remoteGitCapabilityView.ts");
const { describeGitCapabilityBanner, gitCapabilityReasonKey, normalizeGitCapabilities, ALL_GIT_CAPABILITIES, REMOTE_GIT_BANNER_ITEM_IDS, SHARED_GIT_BANNER_ITEM_IDS } = view;
const { RemoteGitCapabilityBanner } = loadTsCommonJs("src/renderer/src/components/workspace/RemoteGitCapabilityBanner.tsx", { stubs: { react: React } });
const { RemoteGitClosedNote } = loadTsCommonJs("src/renderer/src/components/workspace/RemoteGitClosedNote.tsx", { stubs: { react: React } });
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");

const allOpen = ALL_GIT_CAPABILITIES;
/** vm 沙箱与宿主是不同 realm：断言前把结果摊平成普通对象（现有测试同样做法）。 */
const plain = (value) => JSON.parse(JSON.stringify(value));
const closed = { ...allOpen, read: false, write: false, branchWrite: false, sync: false, recovery: false, history: false, refs: false, compare: false, forceRefresh: false, init: false, worktree: false };
const renderBanner = (git, blocked, items) => renderToStaticMarkup(React.createElement(RemoteGitCapabilityBanner, { git, blocked, ...(items === undefined ? {} : { items }) }));

test("全可用时不渲染能力条（只在有入口被关闭时解释原因）", () => {
	assert.deepEqual(plain(describeGitCapabilityBanner(allOpen)), [], "nothing is blocked");
	assert.equal(renderBanner(allOpen), "", "all-available must not render the banner");
	assert.deepEqual(plain(describeGitCapabilityBanner(allOpen, { "git.write": "PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED" })), []);
});

test("脏工作区切分支先确认，干净时直接切", () => {
	// 切换会带着未提交更改过去；失败时只回一个稳定码，所以先问一句（与本机同一条规则）。
	assert.match(panel, /changeCount > 0 \? setPendingSwitch\(ref\.name\) : switchBranch\(ref\.name\)/, "切换入口必须区分脏/干净两种路径");
	assert.match(panel, /remote-git-switch-confirm-bar/);
	assert.match(panel, /remote-git-switch-confirm/);
	assert.match(panel, /remote-git-switch-cancel/);
	// 未提交更改总数只用于提示，不参与任何写授权判定。
	assert.match(panel, /const changeCount = snapshot === undefined \? 0 : GROUPS\.reduce/);
});

test("能力关闭时区块不消失：保留标题并就地说明原因", () => {
	// 依据 ui-commercialization-plan「disabled 是必查态」：整块隐藏会让人以为功能不存在，
	// 也分不清是「没做」还是「这台主机/这个 helper 不行」。
	for (const key of ["git.recovery", "git.history", "git.refs", "git.compare"]) {
		assert.match(panel, new RegExp('<RemoteGitClosedNote capability="' + key + '"'), "缺少关闭占位：" + key);
	}
	const html = renderToStaticMarkup(React.createElement(RemoteGitClosedNote, { capability: "git.history", blocked: { "git.history": "PROJECT_SERVICE_CAPABILITY_HELPER_UNKNOWN" } }));
	assert.match(html, /data-testid="remote-git-closed-git\.history"/);
	assert.match(html, /检测/, "占位要给出可读原因，而不是只说不可用");
	// 未知原因码不猜文案：只保留「不可用」，不编造自由文本。
	const bare = renderToStaticMarkup(React.createElement(RemoteGitClosedNote, { capability: "git.refs", blocked: { "git.refs": "SOMETHING_ELSE" } }));
	assert.match(bare, /data-testid="remote-git-closed-git\.refs"/);
	assert.ok(!bare.includes("SOMETHING_ELSE"), "未知原因码不得出现在 UI 上");
});

test("能力未知说「正在检测」，不冒充「不支持」", () => {
	// root 会话还在握手时 helperCapabilities 缺席：这时说「缺少方法」是错的，用户会以为功能坏了。
	assert.equal(gitCapabilityReasonKey("PROJECT_SERVICE_CAPABILITY_HELPER_UNKNOWN"), "remoteGit.capabilityDetecting");
	assert.equal(gitCapabilityReasonKey("PROJECT_SERVICE_CAPABILITY_HELPER_METHOD_MISSING"), "remoteGit.unsupported");
	const lines = describeGitCapabilityBanner({ ...allOpen, write: false }, { "git.write": "PROJECT_SERVICE_CAPABILITY_HELPER_UNKNOWN" });
	assert.equal(lines.length, 1, "未知原因仍要解释，不能把区块静默隐藏");
	assert.equal(lines[0].reasonKey, "remoteGit.capabilityDetecting");
	assert.ok(zhCN["remoteGit.capabilityDetecting"].includes("检测"), "词典必须有「检测中」文案");
});

test("写入口按能力位成行：提交 / 暂存 / 丢弃，原因码映射到既有文案", () => {
	const lines = describeGitCapabilityBanner({ ...allOpen, write: false }, { "git.write": "PROJECT_SERVICE_CAPABILITY_HELPER_METHOD_MISSING" });
	assert.deepEqual(plain(lines), [{ id: "write", labels: ["remoteGit.capabilityWrite"], reason: "PROJECT_SERVICE_CAPABILITY_HELPER_METHOD_MISSING", reasonKey: "remoteGit.unsupported" }]);
});

test("分支写、同步各一项；同原因合并成一行", () => {
	const lines = describeGitCapabilityBanner({ ...allOpen, branchWrite: false, sync: false }, { "git.branchWrite": "PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED", "git.sync": "PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED" });
	assert.equal(lines.length, 1, "same reason must not repeat the same explanation twice");
	assert.equal(lines[0].id, "branchWrite");
	assert.deepEqual(plain(lines[0].labels), ["remoteGit.capabilityBranch", "remoteGit.capabilitySync"]);
	assert.equal(lines[0].reasonKey, "remoteGit.unsupported");
	// 不同原因不合并：恢复/历史各自的稳定原因分开解释。
	const split = describeGitCapabilityBanner({ ...allOpen, recovery: false, history: false }, { "git.recovery": "PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED", "git.history": "PROJECT_SERVICE_CAPABILITY_HELPER_METHOD_MISSING" });
	assert.deepEqual(plain(split.map((line) => line.id)), ["recovery", "history"]);
	assert.deepEqual(plain(split.map((line) => line.labels)), [["remoteGit.capabilityRecovery"], ["remoteGit.capabilityHistory"]]);
});

test("恢复/历史/引用/对比/强刷/初始化逐项覆盖到既有 key", () => {
	const cases = [
		["recovery", "remoteGit.capabilityRecovery"],
		["history", "remoteGit.capabilityHistory"],
		["refs", "remoteGit.capabilityRefs"],
		["compare", "remoteGit.capabilityCompare"],
		["forceRefresh", "remoteGit.capabilityForceRefresh"],
		["init", "remoteGit.capabilityInit"],
	];
	for (const [capability, key] of cases) {
		const lines = describeGitCapabilityBanner({ ...allOpen, [capability]: false }, {});
		assert.deepEqual(plain(lines), [{ id: capability, labels: [key] }], capability + " must be explained by " + key);
		assert.equal(typeof zhCN[key], "string", key + " must exist in zh-CN");
	}
});

test("worktree 不提供时用整句说明，且单独一行不合并", () => {
	const lines = describeGitCapabilityBanner({ ...allOpen, worktree: false, write: false }, { "git.worktree": "PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED" });
	assert.deepEqual(plain(lines.map((line) => line.id)), ["write", "worktree"]);
	assert.deepEqual(plain(lines[1].labels), ["remoteGit.worktreeUnsupported"]);
	assert.equal(lines[1].reason, undefined, "the sentence already explains why; no second copy");
	assert.equal(typeof zhCN["remoteGit.worktreeUnsupported"], "string");
});

test("原因码映射：trust / 连接 / 不支持 / 已变化；未知码不猜文案", () => {
	assert.equal(gitCapabilityReasonKey("PROJECT_SERVICE_CAPABILITY_TRUST_REQUIRED"), "remoteGit.trustRequired");
	assert.equal(gitCapabilityReasonKey("PROJECT_SERVICE_CAPABILITY_TRUST_STALE"), "remoteGit.trustRequired");
	assert.equal(gitCapabilityReasonKey("PROJECT_SERVICE_CAPABILITY_TRUST_UNKNOWN"), "remoteGit.trustRequired");
	assert.equal(gitCapabilityReasonKey("PROJECT_CAPABILITY_HOST_NOT_READY"), "remoteGit.connection");
	assert.equal(gitCapabilityReasonKey("PROJECT_CAPABILITY_WRITE_NEEDS_READY_HOST"), "remoteGit.connection");
	assert.equal(gitCapabilityReasonKey("SSH_HOST_UNREACHABLE"), "remoteGit.connection");
	assert.equal(gitCapabilityReasonKey("PROJECT_SERVICE_CAPABILITY_HELPER_METHOD_MISSING"), "remoteGit.unsupported");
	assert.equal(gitCapabilityReasonKey("PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED"), "remoteGit.unsupported");
	assert.equal(gitCapabilityReasonKey("UNSUPPORTED_CAPABILITY"), "remoteGit.unsupported");
	assert.equal(gitCapabilityReasonKey("PROJECT_SERVICE_CAPABILITY_ROOT_NEEDS_ATTENTION"), "remoteGit.capabilityRootNeedsAttention");
	assert.equal(typeof zhCN["remoteGit.capabilityRootNeedsAttention"], "string");
	assert.equal(gitCapabilityReasonKey("SOMETHING_ELSE"), undefined);
	assert.equal(gitCapabilityReasonKey(undefined), undefined);
});

test("read 关闭时用 git.read 的项目级原因解释全部入口", () => {
	const lines = describeGitCapabilityBanner(closed, { "git.read": "PROJECT_CAPABILITY_HOST_NOT_READY" });
	assert.equal(lines.length, 2, "one merged line for every gated entry plus the standalone worktree note");
	assert.equal(lines[0].id, "write");
	assert.equal(lines[0].labels.length, 9, "write + branchWrite + sync + recovery/history/refs/compare/forceRefresh/init（每个入口一条短标签）");
	assert.equal(lines[0].reason, "PROJECT_CAPABILITY_HOST_NOT_READY");
	assert.equal(lines[0].reasonKey, "remoteGit.connection");
	assert.equal(lines[1].id, "worktree");
});

test("共用面板只解释它真正门禁的入口（不把恢复渲染成永久告警）", () => {
	assert.deepEqual(plain(describeGitCapabilityBanner({ ...allOpen, recovery: false }, {}, SHARED_GIT_BANNER_ITEM_IDS)), []);
	assert.ok(!SHARED_GIT_BANNER_ITEM_IDS.includes("recovery"));
	assert.ok(REMOTE_GIT_BANNER_ITEM_IDS.includes("recovery"));
	const shared = describeGitCapabilityBanner({ ...allOpen, sync: false }, { "git.sync": "PROJECT_SERVICE_CAPABILITY_HELPER_METHOD_MISSING" }, SHARED_GIT_BANNER_ITEM_IDS);
	assert.deepEqual(plain(shared.map((line) => line.id)), ["sync"]);
});

test("normalizeGitCapabilities：缺省全可用，局部能力只覆盖传入项", () => {
	assert.equal(normalizeGitCapabilities(undefined), ALL_GIT_CAPABILITIES);
	const partial = normalizeGitCapabilities({ sync: false });
	assert.equal(partial.sync, false);
	assert.equal(partial.write, true);
	assert.equal(partial.branchCreateMode, "both");
	assert.equal(allOpen.autoFetch, true);
});

test("能力条只渲染文本，不渲染任何按钮或假入口", () => {
	const html = renderBanner({ ...allOpen, write: false, sync: false }, { "git.write": "PROJECT_SERVICE_CAPABILITY_TRUST_REQUIRED", "git.sync": "PROJECT_SERVICE_CAPABILITY_TRUST_REQUIRED" });
	assert.match(html, /data-testid="remote-git-capabilities"/);
	assert.match(html, new RegExp(zhCN["remoteGit.capabilityWrite"]));
	assert.match(html, new RegExp(zhCN["remoteGit.capabilitySync"]));
	assert.match(html, new RegExp(zhCN["remoteGit.capabilityBlocked"]));
	assert.match(html, new RegExp(zhCN["remoteGit.trustRequired"].replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 12)));
	assert.doesNotMatch(html, /<button/i);
	assert.doesNotMatch(html, /role="button"/);
	assert.doesNotMatch(html, /onClick/);
	const worktree = renderBanner({ ...allOpen, worktree: false });
	assert.match(worktree, new RegExp(zhCN["remoteGit.worktreeUnsupported"].slice(0, 12)));
	assert.doesNotMatch(worktree, /<button/i);
});

/** The panel source contract: every entry and every on-demand load is gated by the capability table. */
function effectBodies() {
	return panel
		.split("useEffect(")
		.slice(1)
		.map((chunk) => chunk.slice(0, 900));
}

test("面板把能力条固定在顶部，并把能力/原因传给组件", () => {
	assert.match(panel, /<RemoteGitCapabilityBanner git=\{capabilities\} blocked=\{blocked\} \/>/);
	assert.match(panel, /const \{\s*state,\s*capabilities,\s*blocked,/);
});

test("所有写/同步/分支/恢复/历史/引用/对比/初始化入口都看能力位，不再看令牌", () => {
	for (const gate of [
		"const canCommit = capabilities.write",
		"const canCreateBranch = capabilities.branchWrite",
		"const canSwitchBranch = capabilities.branchWrite",
		"const canDiscard = capabilities.write",
		"const canRestore = capabilities.recovery",
		"const canDrop = capabilities.recovery",
		"const canFetch = capabilities.sync",
		"const canPush = capabilities.sync",
		"const canPull = capabilities.sync",
	]) {
		assert.ok(panel.includes(gate), gate + " must gate its entry on the capability table");
	}
	assert.ok(panel.includes("const writable = capabilities.write"));
	assert.match(panel, /disabled=\{!capabilities\.read \|\| state\.loading/);
	assert.match(panel, /void refresh\(capabilities\.forceRefresh\)/, "force refresh degrades to an ordinary read, it never disables refresh");
	assert.match(panel, /disabled=\{busy \|\| !capabilities\.write\}/);
	assert.match(panel, /disabled=\{busy \|\| !capabilities\.branchWrite\}/);
	assert.match(panel, /\(state\.errorCode === "GIT_NOT_REPOSITORY" \|\| state\.initializing \|\| state\.initNotice !== undefined\) && capabilities\.init/);
	assert.match(panel, /\{capabilities\.compare \? \(/);
	for (const token of ["commitToken", "mutationToken", "branchToken", "switchToken", "discardToken", "restoreToken", "dropToken", "fetchToken", "pushToken", "pullToken"]) {
		assert.ok(!panel.includes(token), token + " must not come back: the service contract has no authorization tokens");
	}
	assert.ok(!panel.includes("snapshot.head"), "the snapshot no longer carries head; branch===null is the detached display");
});

test("分区展开 effect 先过能力闸门，且没有任何 effect 调用 fetch/push/pull", () => {
	const effects = effectBodies();
	for (const [capability, loader] of [
		["history", "loadHistory()"],
		["refs", "loadRefs()"],
		["recovery", "loadRecovery()"],
	]) {
		const body = effects.find((chunk) => chunk.includes(loader));
		assert.ok(body, capability + " must load on expansion");
		const gate = body.indexOf("if (!capabilities." + capability + ") return;");
		const call = body.indexOf(loader);
		assert.ok(gate >= 0, capability + " must check its capability first");
		assert.ok(gate < call, capability + " must not send a request before the capability gate");
	}
	for (const effect of effects) {
		for (const verb of ["fetchRemote(", "pushRemote(", "pullRemote(", "commit(", "mutate(", "discard(", "createBranch(", "switchBranch(", "initRepository("]) {
			assert.ok(!effect.includes(verb), "no effect may call " + verb);
		}
	}
});

test("refs 轮询串上 refsWatch；确认流程与 unknown 语义仍在", () => {
	assert.match(panel, /active: refsOpen && capabilities\.refsWatch/);
	assert.match(panel, /active: refsOpen && capabilities\.refsWatch,\s*refsLoaded: state\.refs !== undefined,\s*hostReady,/);
	for (const id of ["remote-git-sync-push-confirm-bar", "remote-git-discard-confirm-bar", "remote-git-init-confirm", "remote-git-recovery-drop-confirm-bar"]) {
		assert.ok(panel.includes('data-testid="' + id + '"'), id + " confirmation flow must survive the capability rewrite");
	}
	// unknown 结果不自动重放：状态层只展示稳定码，面板不做重试（重试入口即显式刷新）。
	assert.ok(panel.includes("remoteGitErrorMessage(state.errorCode)"));
	assert.ok(!panel.includes("setTimeout"), "no delayed replay of a write");
});
