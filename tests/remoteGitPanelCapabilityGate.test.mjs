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
const localPanel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const bridge = readFileSync("src/renderer/src/components/workspace/remoteGitPanelBridge.ts", "utf8");
const recoverySection = readFileSync("src/renderer/src/components/workspace/RemoteGitRecoverySection.tsx", "utf8");
/**
 */
const view = loadTsCommonJs("src/renderer/src/utils/remoteGitCapabilityView.ts");
const { describeGitCapabilityBanner, gitCapabilityReasonKey, normalizeGitCapabilities, ALL_GIT_CAPABILITIES, REMOTE_GIT_BANNER_ITEM_IDS, SHARED_GIT_BANNER_ITEM_IDS } = view;
const { RemoteGitCapabilityBanner } = loadTsCommonJs("src/renderer/src/components/workspace/RemoteGitCapabilityBanner.tsx", { stubs: { react: React } });
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

/** 共用面板契约：远端面板只做“位置相关”的装配，入口门禁由 GitPanel + 能力表统一执行。 */
test("远端把能力快照与阻塞原因原样交给共用面板（能力条只剩一份）", () => {
	assert.match(panel, /gitCapabilities=\{git\}/);
	assert.match(panel, /blockedReasons=\{blocked\}/);
	assert.match(localPanel, /<RemoteGitCapabilityBanner git=\{gitCapabilities\} blocked=\{props\.blockedReasons\}/);
});

test("写/同步/分支/对比/初始化入口由共用面板按能力位门禁，远端不再自建一套", () => {
	for (const gate of [
		"const canCommit = gitCapabilities.write",
		"disabled={!gitCapabilities.sync || pushing",
		"disabled={!gitCapabilities.sync || pulling",
		"enabled={gitCapabilities.compare}",
		"if (!props.gitInit || !gitCapabilitiesRef.current.init) return;",
		"if (!gitCapabilitiesRef.current.branchWrite) return;",
		"disabled={!gitCapabilities.branchWrite}",
	]) {
		assert.ok(localPanel.includes(gate), gate + " must gate its entry on the capability table");
	}
	// 面板本身不写门禁判定：它只透传能力与数据。
	assert.ok(!panel.includes("const canCommit"), "远端面板不得复制写门禁");
	assert.match(panel, /gitInit=\{/);
});

test("脏工作区切分支先确认：远端复用本机同一条确认，不再有第二套行内确认条", () => {
	assert.match(localPanel, /setPendingBranchSwitch\(branch\)/);
	assert.match(localPanel, /git\.branchSwitchConfirmMessage/);
	assert.ok(!panel.includes("remote-git-switch-confirm-bar"), "远端不得复活第二套切分支确认");
});

test("远端专属入口同样按能力位：恢复区展开才读，关闭时只说明原因", () => {
	assert.match(recoverySection, /if \(open && props\.enabled && listing === undefined && !loading\) void load\(\)/);
	assert.match(recoverySection, /\{open \? \(\s*props\.enabled \?/);
	assert.match(recoverySection, /recoveryDropConfirm/);
	assert.match(panel, /enabled=\{git\.recovery\}/);
});

test("没有任何 effect 触发写/网络：fetch、push、pull、commit 只来自用户动作", () => {
	const effects = panel
		.split("useEffect(")
		.slice(1)
		.map((chunk) => chunk.slice(0, 900));
	for (const effect of effects) {
		for (const verb of ["fetch(", "push(", "pull(", "commit(", "discard(", "createBranch("]) {
			assert.ok(!effect.includes(verb), "no effect may call " + verb);
		}
	}
	// 桥只暴露动词，不主动调用；面板把它们挂成 props。
	assert.match(panel, /fetch=\{bridge\.fetch\}/);
	assert.match(panel, /push=\{bridge\.push\}/);
	assert.match(panel, /pull=\{bridge\.pull\}/);
	assert.doesNotMatch(panel, /setInterval|setTimeout/, "no delayed replay of a write");
});

test("远端与本机同形的入口都在，但新协议入口按 helper 声明降级", () => {
	// 这一批（暂存 diff / 分支过滤与总数 / refs 订阅）随 helper 1.32.0 一起发布：
	// 旧 helper 上入口必须缺席，而不是点了才报错。
	for (const prop of ["generateCommitMessage=", "deleteFiles=", "watchRefs=", "unwatchRefs=", "onRefsChanged=", "commitCount="]) {
		assert.ok(panel.includes(prop), prop + " must ride on the shared panel");
	}
	assert.match(panel, /historyRefFilter=\{upgraded\}/, "the history filter is gated by the same protocol marker");
	assert.match(panel, /git\.stagedDiff/, "the marker is the helper declaration of the new protocol batch");
	// helper 1.35.0 起有图谱写动词：四个入口挂上共享面板，同样由 helper 的声明守门。
	for (const prop of ["cherryPick=", "revert=", "reset=", "dropCommit="]) assert.ok(panel.includes(prop), prop + " must ride on the shared panel");
	assert.match(panel, /git\.cherryPick/, "the graph-write gate is the helper declaration of the new verbs");
	assert.match(panel, /cherryPick=\{historyWrite \? bridge\.cherryPick : undefined\}/, "an old helper keeps the entry absent");
	// unknown 结果只展示稳定码、不自动重放；文案只从同一个出口出：桥不再自己读 detail 拼文案。
	// 文案只从同一个出口出：桥用 remoteGitErrorText 取文案（未入词典的码附码），不再自己读 detail 拼文案。
	assert.match(bridge, /const text = remoteGitErrorText\(error\)/);
	assert.doesNotMatch(bridge, /\.detail\b/, "文案走 remoteGitErrorText：内部说明与非原文文本一旦被桥直接取用就会漏上屏");
	assert.match(bridge, /outcome/);
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

test("worktree 不进能力条：远端永远没有本机 Git 目录，不把不可能写成告警", () => {
	// 侧栏菜单入口已经按 shouldShowWorktreeMenuEntry 隐藏；能力条再列一行只会被当成故障。
	assert.deepEqual(plain(describeGitCapabilityBanner({ ...allOpen, worktree: false }, { "git.worktree": "PROJECT_SERVICE_CAPABILITY_PROVIDER_UNSUPPORTED" })), []);
	assert.ok(!REMOTE_GIT_BANNER_ITEM_IDS.includes("worktree"));
	assert.ok(!SHARED_GIT_BANNER_ITEM_IDS.includes("worktree"));
	assert.equal(renderBanner({ ...allOpen, worktree: false }), "", "worktree 关闭不是能力条的理由");
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
	assert.equal(lines.length, 1, "同一原因的入口全部合并成一行");
	assert.equal(lines[0].id, "write");
	assert.equal(lines[0].labels.length, 9, "write + branchWrite + sync + recovery/history/refs/compare/forceRefresh/init（每个入口一条短标签）");
	assert.equal(lines[0].reason, "PROJECT_CAPABILITY_HOST_NOT_READY");
	assert.equal(lines[0].reasonKey, "remoteGit.connection");
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
	assert.equal(worktree, "", "worktree 关闭不渲染能力条（入口本来就不提供）");
});
