import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createRemoteProjectGitService } = loadTsCommonJs("src/renderer/src/services/projectGitService.ts");
const { normalizeProjectServiceError } = loadTsCommonJs("src/renderer/src/services/projectServiceFence.ts");
const { remoteGitErrorText } = loadTsCommonJs("src/renderer/src/utils/gitErrorPresentation.ts");
const { createRemoteGitPanelBridge } = loadTsCommonJs("src/renderer/src/components/workspace/remoteGitPanelBridge.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");

/**
 * 失败文案的边界（远端 Git）：**内部说明永不上屏**。
 *
 * 回归的事故形态：强刷被主进程守卫拒绝 → 失败信封只有稳定码、没有 helper 原文 →
 * 生产端把内部英文说明（"remote git force refresh refused"）写进了可上屏的 `detail` →
 * 面板横幅原样显示这句英文，闭集码词典里的中文永不生效，用户看不到真正的原因。
 *
 * 契约因此拆成两条文本通道：`detail` = 远端原文（可上屏），`internal` = 内部说明（只给日志）。
 */
const projectId = "project";
const fence = { generation: "generation-1", slot: { current: "generation-1" } };
const INTERNAL_JUNK = /refused|remote git|Error invoking|[A-Z][A-Z0-9_]{2,}/;

/** 远端通道的最小假面：只提供被测动作会碰到的信封，其余一律抛错（碰到就是设计跑偏）。 */
function remoteApi(overrides = {}) {
	const untouchable = (name) => async () => {
		throw new Error("unexpected channel call: " + name);
	};
	return {
		files: { delete: untouchable("files.delete") },
		remoteHosts: {},
		remoteTrust: {},
		remoteTransfers: {},
		git: {
			refreshRemoteGitFacts: async () => ({ ok: false, code: "SSH_HOST_NOT_READY" }),
			remoteRefs: async () => ({ ok: false, code: "GIT_NOT_REPOSITORY" }),
			syncFacts: async () => ({ ok: true, facts: { branch: "main", upstream: null, ahead: 0, behind: 0, remotes: ["a", "b"] } }),
			...overrides,
		},
	};
}

async function caughtOf(run) {
	try {
		await run();
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

test("主进程拒绝强刷（信封无原文）：横幅给词典文案，内部说明不上屏", async () => {
	const service = createRemoteProjectGitService(projectId, remoteApi(), fence);
	const caught = await caughtOf(() => service.refresh(undefined));

	assert.equal(caught.code, "SSH_HOST_NOT_READY");
	assert.equal(caught.detail, undefined, "没有 helper 原文时 detail 必须留空");
	assert.ok(typeof caught.internal === "string" && caught.internal.length > 0, "内部说明要留给我们自己查，但只能待在 internal");

	const text = remoteGitErrorText(caught);
	assert.equal(text, zhCN["remoteGit.connection"]);
	assert.doesNotMatch(text, INTERNAL_JUNK, "横幅不能出现内部英文串");

	// 面板真实链路：桥接层把同一个失败折成 throw 的 Error，message 就是上屏文案。
	const bridge = createRemoteGitPanelBridge({ projectId, kind: "remote", facts: {}, git: service }, undefined);
	const fromBridge = await caughtOf(() => bridge.getStatus(projectId, { force: true }));
	assert.equal(fromBridge.message, zhCN["remoteGit.connection"]);
	assert.equal(fromBridge.code, "SSH_HOST_NOT_READY", "稳定码照旧带出去，供面板判定分类与重放");
	assert.ok(typeof fromBridge.internal === "string" && fromBridge.internal.length > 0, "内部说明跟着错误对象进调试通道，但不进文案");
	assert.doesNotMatch(fromBridge.message, INTERNAL_JUNK);
});

test("helper 带回的原文仍然优先：可上屏的是 git 说的话，不是我们的分类文案", async () => {
	const service = createRemoteProjectGitService(projectId, remoteApi({ refreshRemoteGitFacts: async () => ({ ok: false, code: "GIT_COMMAND_FAILED", message: "fatal: unable to read current working directory" }) }), fence);
	const caught = await caughtOf(() => service.refresh(undefined));

	assert.equal(caught.detail, "fatal: unable to read current working directory");
	assert.equal(remoteGitErrorText(caught), "fatal: unable to read current working directory");
});

test("契约缺口与身份拒绝的内部说明同样不上屏", async () => {
	// 两个 remote 无法替用户选：契约缺口走 unsupported，内部说明只进 internal。
	const service = createRemoteProjectGitService(projectId, remoteApi(), fence);
	const ambiguous = await caughtOf(() => service.fetch(undefined));
	assert.equal(ambiguous.code, "PROJECT_SERVICE_UNSUPPORTED");
	assert.equal(ambiguous.detail, undefined);
	assert.doesNotMatch(remoteGitErrorText(ambiguous), INTERNAL_JUNK);

	// raw IPC 的包装文本（Electron 前缀 + 稳定码）不是远端原文，也不能原样上屏。
	const wrapped = normalizeProjectServiceError(new Error("Error invoking remote method 'git:remote-snapshot': Error: GIT_RESULT_INVALID"));
	assert.equal(wrapped.code, "GIT_RESULT_INVALID", "稳定码仍然要从包装文本里认出来");
	assert.equal(wrapped.detail, undefined);
	const wrappedText = remoteGitErrorText(wrapped);
	assert.doesNotMatch(wrappedText, INTERNAL_JUNK);
	assert.equal(wrappedText, zhCN["remoteGit.failed"]);
});
