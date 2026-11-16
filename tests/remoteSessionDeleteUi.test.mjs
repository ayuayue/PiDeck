import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { sessionIpcSource } from "./helpers/sessionIpcSources.mjs";
import { previewApiSource } from "./helpers/previewApiSources.mjs";
import { preloadSource } from "./helpers/preloadSources.mjs";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

/**
 * 远端归档会话永久删除的**渲染层契约**：状态机门槛、i18n 文案、CLI 入口接线。
 * 不渲染 React：状态是纯 reducer（utils/remoteArchivedDeleteState.ts），接线用源码锚点 +
 * 通道常量断言——与既有「三处同步」守卫同一思路。
 */

const state = loadTsCommonJs("src/renderer/src/utils/remoteArchivedDeleteState.ts");
const model = loadTsCommonJs("src/renderer/src/sessionManagerModel.ts");
const { REMOTE_SESSION_DELETE_CODES } = loadTsCommonJs("src/shared/sessionDeleteCodes.ts");
const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");

function reduce(action, initial = state.initialRemoteArchivedDeleteState) {
	return state.reduceRemoteArchivedDelete(initial, action);
}

test("delete state machine only allows confirm from the main-issued confirming state (double-click safe)", () => {
	let current = state.initialRemoteArchivedDeleteState;
	assert.equal(current.phase, "idle");
	// 没有 requestId 时 confirm 什么也不做：删除命令不可能被跳过确认直接发出。
	assert.equal(reduce({ type: "confirm" }, current).phase, "idle");
	current = reduce({ type: "request", sessionId: "s1" }, current);
	assert.equal(current.phase, "requesting");
	// 在途/重复请求被忽略，不会覆盖当前行。
	assert.equal(reduce({ type: "request", sessionId: "s2" }, current).phase, "requesting");
	current = reduce({ type: "requested", sessionId: "s1", requestId: "r1", expiresAt: 1 }, current);
	assert.equal(current.phase, "confirming");
	if (current.phase !== "confirming") throw new Error("expected confirming");
	assert.equal(current.requestId, "r1");
	// 迟到的另一个会话的 requested 不得顶替当前确认。
	assert.equal(reduce({ type: "requested", sessionId: "s2", requestId: "r2", expiresAt: 2 }, current).phase, "confirming");
	current = reduce({ type: "confirm" }, current);
	assert.equal(current.phase, "deleting");
	assert.equal(reduce({ type: "confirm" }, current).phase, "deleting", "重复确认必须被忽略");
	// deleting 不能取消：命令已在途，取消只制造「以为没删」的假象。
	assert.equal(reduce({ type: "cancel" }, current).phase, "deleting");
	assert.equal(reduce({ type: "deleted" }, current).phase, "idle");
});

test("cancel returns to idle only before dispatch; failure/unconfirmed require explicit acknowledge", () => {
	assert.equal(reduce({ type: "cancel" }, reduce({ type: "request", sessionId: "s1" })).phase, "idle");
	assert.equal(reduce({ type: "cancel" }, reduce({ type: "requested", sessionId: "s1", requestId: "r1", expiresAt: 1 }, reduce({ type: "request", sessionId: "s1" }))).phase, "idle");
	const deleting = reduce({ type: "confirm" }, reduce({ type: "requested", sessionId: "s1", requestId: "r1", expiresAt: 1 }, reduce({ type: "request", sessionId: "s1" })));
	const failed = reduce({ type: "deleteFailed", code: REMOTE_SESSION_DELETE_CODES.commandFailed }, deleting);
	assert.equal(failed.phase, "failed");
	assert.equal(failed.code, REMOTE_SESSION_DELETE_CODES.commandFailed);
	// 失败态不会被 request/confirm/deleted 等迟到动作冲掉，只能显式关闭。
	for (const action of [{ type: "request", sessionId: "s1" }, { type: "confirm" }, { type: "deleted" }]) assert.equal(reduce(action, failed).phase, "failed");
	assert.equal(reduce({ type: "acknowledge" }, failed).phase, "idle");
	const unconfirmed = reduce({ type: "deleteUnconfirmed", code: REMOTE_SESSION_DELETE_CODES.resultUnconfirmed }, deleting);
	assert.equal(unconfirmed.phase, "unconfirmed");
	assert.equal(reduce({ type: "deleted" }, unconfirmed).phase, "unconfirmed", "未确认结果不能被后续成功/刷新悄悄改写");
	assert.equal(reduce({ type: "acknowledge" }, unconfirmed).phase, "idle");
});

test("row phase / busy / stable-code→copy mapping", () => {
	const idle = state.initialRemoteArchivedDeleteState;
	assert.equal(state.remoteArchivedDeleteRowPhase(idle, "s1"), "idle");
	const confirming = reduce({ type: "requested", sessionId: "s1", requestId: "r1", expiresAt: 1 }, reduce({ type: "request", sessionId: "s1" }));
	assert.equal(state.remoteArchivedDeleteRowPhase(confirming, "s1"), "confirming");
	assert.equal(state.remoteArchivedDeleteRowPhase(confirming, "s2"), "other");
	assert.equal(state.remoteArchivedDeleteBusy(reduce({ type: "request", sessionId: "s1" })), true);
	assert.equal(state.remoteArchivedDeleteBusy(confirming), false);
	assert.equal(state.remoteArchivedDeleteErrorKey(REMOTE_SESSION_DELETE_CODES.busy), "sessionManager.remoteArchivedDeleteBusyRuntime");
	assert.equal(state.remoteArchivedDeleteErrorKey(REMOTE_SESSION_DELETE_CODES.unavailable), "sessionManager.remoteArchivedDeleteUnavailable");
	assert.equal(state.remoteArchivedDeleteErrorKey(REMOTE_SESSION_DELETE_CODES.entryNotFound), "sessionManager.remoteArchivedDeleteMissing");
	assert.equal(state.remoteArchivedDeleteErrorKey(REMOTE_SESSION_DELETE_CODES.notArchived), "sessionManager.remoteArchivedDeleteMissing");
	assert.equal(state.remoteArchivedDeleteErrorKey(REMOTE_SESSION_DELETE_CODES.confirmationRequired), "sessionManager.remoteArchivedDeleteExpired");
	assert.equal(state.remoteArchivedDeleteErrorKey(REMOTE_SESSION_DELETE_CODES.resultUnconfirmed), "sessionManager.remoteArchivedDeleteUnconfirmed");
	assert.equal(state.remoteArchivedDeleteErrorKey("SOMETHING_ELSE"), undefined);
});

test("remote archived rows get the explicit path while local rows keep the trash flow", () => {
	const remotePi = { kind: "pi", item: { summary: { id: "s1", filePath: "", name: "R", preview: "", updatedAt: 1, messageCount: 0, projectId: "p" }, archivedRemoteSessionId: "s1" } };
	const localPi = { kind: "pi", item: { summary: { id: "s2", filePath: "/tmp/a.jsonl", name: "L", preview: "", updatedAt: 1, messageCount: 0, projectId: "p" }, originalPath: "/tmp/a.jsonl" } };
	const dsh = { kind: "dsh", item: { dshSessionId: "d1", cwd: "/tmp", archivedAt: 1 } };
	assert.equal(model.isRemoteArchivedPiRow(remotePi), true);
	assert.equal(model.isRemoteArchivedPiRow(localPi), false);
	assert.equal(model.isRemoteArchivedPiRow(dsh), false);
	// 批量/回收站链路仍然排除远端行（远端只允许单行显式永久删除）。
	assert.equal(model.canDeleteManagerArchivedRow(remotePi), false);
	assert.equal(model.canDeleteManagerArchivedRow(localPi), true);
	assert.equal(model.canDeleteManagerArchivedRow(dsh), true);
});

test("zh/en copy for the irreversible confirmation exists and matches the closed codes", () => {
	const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
	for (const key of [
		"sessionManager.remoteArchivedDelete",
		"sessionManager.remoteArchivedDeleteConfirm",
		"sessionManager.remoteArchivedDeleteAction",
		"sessionManager.remoteArchivedDeleteDeleting",
		"sessionManager.remoteArchivedDeleteUnconfirmed",
		"sessionManager.remoteArchivedDeleteDismiss",
		"sessionManager.remoteArchivedDeleteBusyRuntime",
		"sessionManager.remoteArchivedDeleteUnavailable",
		"sessionManager.remoteArchivedDeleteMissing",
		"sessionManager.remoteArchivedDeleteExpired",
		"sessionManager.remoteArchivedDeleteFailedCode",
	]) {
		assert.equal(typeof zhCN[key], "string", "zh missing " + key);
		assert.equal(typeof enUS[key], "string", "en missing " + key);
	}
	// 不可恢复语义必须出现在确认文案里（不能只写“删除”）。
	assert.match(zhCN["sessionManager.remoteArchivedDeleteConfirm"], /无法恢复/);
	assert.match(enUS["sessionManager.remoteArchivedDeleteConfirm"], /cannot be undone/);
	assert.match(zhCN["sessionManager.remoteArchivedDeleteUnconfirmed"], /刷新/);
	assert.match(enUS["sessionManager.remoteArchivedDeleteUnconfirmed"], /refresh/i);
});

test("channels, preload, main handler and preview stub stay wired; request carries only a session id", () => {
	const channels = readFileSync("src/shared/ipc.ts", "utf8");
	const preload = preloadSource;
	const sessionIpc = sessionIpcSource;
	const preview = previewApiSource;
	const app = rendererAppSource;
	const sidebarContent = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
	const sidebarComponents = readFileSync("src/renderer/src/components/sidebar/SidebarComponents.tsx", "utf8");
	assert.equal(ipcChannels.sessionsCatalogDeleteArchivedRemote, "sessions:catalog-delete-archived-remote");
	assert.equal(ipcChannels.sessionsCatalogAnswerDeleteArchivedRemote, "sessions:catalog-answer-delete-archived-remote");
	assert.match(channels, /sessionsCatalogDeleteArchivedRemote\s*:/);
	assert.match(channels, /sessionsCatalogAnswerDeleteArchivedRemote\s*:/);
	// preload：请求只转发 sessionId，回答只转发 requestId+choice——不存在 path 参数。
	assert.match(preload, /deleteArchivedRemoteRecord:\s*\(sessionId: string\)[\s\S]{0,160}sessionsCatalogDeleteArchivedRemote/);
	assert.match(preload, /answerDeleteArchivedRemoteRecord:\s*\(requestId: string, choice: "approve" \| "deny"\)[\s\S]{0,200}sessionsCatalogAnswerDeleteArchivedRemote/);
	assert.doesNotMatch(preload, /deleteArchivedRemoteRecord:\s*\([^)]*path/i);
	assert.match(sessionIpc, /ipcMain\.handle\(ipcChannels\.sessionsCatalogDeleteArchivedRemote/);
	assert.match(sessionIpc, /ipcMain\.handle\(ipcChannels\.sessionsCatalogAnswerDeleteArchivedRemote/);
	assert.match(sessionIpc, /deleteArchivedRemoteSession/);
	assert.match(preview, /deleteArchivedRemoteRecord:/);
	assert.match(preview, /answerDeleteArchivedRemoteRecord:/);
	assert.match(app, /requestDeleteArchivedRemote:\s*\(sessionId\)\s*=>\s*api\.sessions\.deleteArchivedRemoteRecord/);
	assert.match(app, /answerDeleteArchivedRemote:\s*\(requestId, choice\)\s*=>\s*api\.sessions\.answerDeleteArchivedRemoteRecord/);
	assert.match(sidebarContent, /requestDeleteArchivedRemote=\{/);
	assert.match(sidebarComponents, /requestDeleteArchivedRemote:/);
	// UI 合同：单行删除入口 + 内联不可恢复确认 + 未确认提示，全部有稳定 testid。
	for (const testid of ["remote-archived-delete", "remote-archived-delete-confirm", "remote-archived-delete-confirm-action", "remote-archived-delete-cancel", "remote-archived-delete-unconfirmed", "remote-archived-delete-dismiss", "remote-archived-delete-busy", "remote-archived-delete-error"])
		assert.match(sidebarComponents, new RegExp('data-testid="' + testid + '"'), testid + " missing");
	// 未确认分支必须先于“确定失败”回调：不得在回执丢失时刷新列表把证据冲掉。
	const hook = readFileSync("src/renderer/src/hooks/useRemoteArchivedSessionDelete.ts", "utf8");
	const confirmBody = hook.slice(hook.indexOf("async function confirm"));
	const unconfirmedIndex = confirmBody.indexOf("resultUnconfirmed");
	const definiteFailureIndex = confirmBody.indexOf("onDefiniteFailure");
	assert.ok(unconfirmedIndex >= 0 && definiteFailureIndex > unconfirmedIndex, "unconfirmed branch must return before definite-failure refresh");
});
