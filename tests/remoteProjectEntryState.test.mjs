import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const state = loadTsCommonJs("src/renderer/src/components/session/remoteFileManagementState.ts");
const drafts = loadTsCommonJs("src/renderer/src/utils/remoteFileDrafts.ts");

test("file management reducer enforces single-flight and distinguishes failed/unknown", () => {
	let current = state.initialRemoteFileManagementState();
	assert.deepEqual({ ...current }, { phase: "idle", operation: null, code: null });
	current = state.reduceRemoteFileManagement(current, { type: "begin", operation: "rename" });
	assert.deepEqual({ ...current }, { phase: "busy", operation: "rename", code: null });
	// 单飞：busy 期间第二个 begin 被忽略，不能覆盖在途操作。
	assert.deepEqual({ ...state.reduceRemoteFileManagement(current, { type: "begin", operation: "delete" }) }, { ...current });
	assert.deepEqual({ ...state.reduceRemoteFileManagement(current, { type: "failed", code: "REMOTE_FILE_CHANGED" }) }, { phase: "failed", operation: "rename", code: "REMOTE_FILE_CHANGED" });
	current = state.reduceRemoteFileManagement(current, { type: "unknown", code: "REMOTE_FILE_RESULT_UNCONFIRMED" });
	assert.equal(current.phase, "unknown");
	assert.equal(current.code, state.REMOTE_FILE_ENTRY_UNKNOWN_CODE);
	assert.deepEqual({ ...state.reduceRemoteFileManagement(current, { type: "reset" }) }, { ...state.initialRemoteFileManagementState() });
	// 成功只在 busy 时结算：空闲态收到迟到 succeeded 不改变状态。
	assert.equal(state.reduceRemoteFileManagement(state.initialRemoteFileManagementState(), { type: "succeeded" }).phase, "idle");
});

test("stable codes map to i18n keys; unknown codes fall back to a visible failure with the code", () => {
	assert.equal(state.remoteFileEntryErrorKey("REMOTE_FILE_TARGET_EXISTS"), "remoteFileEntry.targetExists");
	assert.equal(state.remoteFileEntryErrorKey("REMOTE_FILE_TRASH_UNAVAILABLE"), "remoteFileEntry.trashUnavailable");
	assert.equal(state.remoteFileEntryErrorKey("REMOTE_FILE_TRASH_ENTRY_NOT_FOUND"), "remoteFileEntry.trashNotFound");
	assert.equal(state.remoteFileEntryErrorKey("REMOTE_FILE_RESULT_UNCONFIRMED"), "remoteFileEntry.unknown");
	assert.equal(state.remoteFileEntryErrorKey("SSH_HOST_NOT_READY"), "remoteFile.connection");
	assert.equal(state.remoteFileEntryErrorKey("SOMETHING_ELSE"), "remoteFileEntry.failure");
	// 失败后保留输入只针对可修正的冲突；未知结果/受保护路径关闭弹框。
	assert.equal(state.remoteFileEntryKeepsInput("REMOTE_FILE_TARGET_EXISTS"), true);
	assert.equal(state.remoteFileEntryKeepsInput("REMOTE_FILE_CHANGED"), true);
	assert.equal(state.remoteFileEntryKeepsInput("REMOTE_FILE_PROTECTED_PATH"), false);
	assert.equal(state.remoteFileEntryKeepsInput("REMOTE_FILE_RESULT_UNCONFIRMED"), false);
	assert.equal(state.remoteFileEntryIsUnknown("REMOTE_FILE_RESULT_UNCONFIRMED"), true);
	assert.equal(state.remoteFileEntryIsUnknown("REMOTE_PROJECT_CREATE_UNCONFIRMED"), true);
	assert.equal(state.remoteFileEntryIsUnknown("REMOTE_FILE_CHANGED"), false);
	assert.equal(state.remoteFileEntrySuccessKey("rename"), "remoteFileEntry.renamed");
	assert.equal(state.remoteFileEntrySuccessKey("restore"), "remoteTrash.restored");
	assert.equal(state.remoteFileEntrySuccessKey("prune"), "remoteTrash.removed");
});

test("rename/delete draft recycling removes clean drafts and keeps dirty ones marked stale", () => {
	const map = new Map();
	map.set(drafts.remoteFileDraftKey("p", "a.txt"), { projectId: "p", path: "a.txt", content: "clean", savedContent: "clean", version: "v", generation: 1, phase: "ready" });
	map.set(drafts.remoteFileDraftKey("p", "dirty.txt"), { projectId: "p", path: "dirty.txt", content: "editing", savedContent: "", version: "v", generation: 1, phase: "ready" });
	map.set(drafts.remoteFileDraftKey("p", "dir/inner.txt"), { projectId: "p", path: "dir/inner.txt", content: "editing", savedContent: "", version: "v", generation: 1, phase: "ready" });
	map.set(drafts.remoteFileDraftKey("other", "dir/inner.txt"), { projectId: "other", path: "dir/inner.txt", content: "keep", savedContent: "keep", version: "v", generation: 1, phase: "ready" });
	const afterFile = drafts.applyRemoteFileMutation(map, "p", "a.txt");
	assert.equal(afterFile.has(drafts.remoteFileDraftKey("p", "a.txt")), false);
	assert.equal(afterFile.get(drafts.remoteFileDraftKey("p", "dirty.txt")).stale, undefined);
	const afterDirectory = drafts.applyRemoteFileMutation(afterFile, "p", "dir");
	assert.equal(afterDirectory.get(drafts.remoteFileDraftKey("p", "dir/inner.txt")).stale, true);
	assert.equal(afterDirectory.get(drafts.remoteFileDraftKey("p", "dir/inner.txt")).content, "editing");
	assert.equal(afterDirectory.has(drafts.remoteFileDraftKey("other", "dir/inner.txt")), true);
});

test("UI contract anchors exist in the shipped renderer modules", () => {
	const panel = readFileSync("src/renderer/src/components/session/RemoteProjectPanel.tsx", "utf8");
	for (const testid of ["remote-file-toolbar", "remote-file-create", "remote-file-mkdir", "remote-file-upload", "remote-file-outcome", "remote-trash-toggle"]) assert.match(panel, new RegExp('data-testid="' + testid + '"'), testid + " must be mounted");
	// W2 结构拆分后行菜单锚点位于 RemoteProjectRowMenu.tsx（面板只挂载，行组件仍与本地文件树共用 FileTreeRows），
	// 行为/契约不变；按「面板 + 行菜单模块」合并匹配，断言强度不变（四个锚点仍必须存在于 shipped 渲染模块）。
	const rowMenu = readFileSync("src/renderer/src/components/session/RemoteProjectRowMenu.tsx", "utf8");
	for (const testid of ["remote-file-row-menu", "remote-file-row-rename", "remote-file-row-delete", "remote-file-row-download"]) assert.match(panel + rowMenu, new RegExp('data-testid="' + testid + '"'), testid + " must be mounted");
	const dialogs = readFileSync("src/renderer/src/components/session/RemoteProjectEntryDialogs.tsx", "utf8");
	for (const testid of [
		"remote-file-new-dialog",
		"remote-file-new-name",
		"remote-file-new-confirm",
		"remote-file-new-cancel",
		"remote-file-rename-dialog",
		"remote-file-rename-input",
		"remote-file-rename-confirm",
		"remote-file-rename-cancel",
		"remote-file-delete-confirm",
		"remote-file-delete-cancel",
		"remote-trash-prune-confirm",
		"remote-trash-prune-cancel",
	])
		assert.match(dialogs, new RegExp('data-testid="' + testid + '"'), testid + " must be mounted");
	const trash = readFileSync("src/renderer/src/components/session/RemoteTrashPanel.tsx", "utf8");
	for (const testid of ["remote-trash", "remote-trash-row", "remote-trash-restore", "remote-trash-prune", "remote-trash-outcome", "remote-trash-expired", "remote-trash-truncated"]) assert.match(trash, new RegExp('data-testid="' + testid + '"'), testid + " must be mounted");
	assert.match(panel, /aria-live="polite"/);
	assert.match(trash, /aria-live="polite"/);
});

test("a successful first directory load refreshes helper facts before upload readiness is consumed", () => {
	const tree = readFileSync("src/renderer/src/hooks/useRemoteFileTree.ts", "utf8");
	assert.match(tree, /activeServices\.facts\.helperCapabilities === undefined[\s\S]{0,180}void activeServices\.refresh\(\)/, "rootStatus cannot see a helper before the first session exists; the directory load must refill capability facts");
});
