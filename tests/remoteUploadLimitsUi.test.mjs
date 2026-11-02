/**
 * 远端能力边界的 UI 提示（WS3 P2）：上传硬限制与「远端固定 pi」的锁定原因。
 *
 * 强制边界在主进程（8 GiB / 32 files / 只接受常规文件 / 后端 clamp），这里锁定 UI 不能做的事：
 * - 超限、文件夹（拖入目录）失败必须走错误提示，不能刷新成「成功」；
 * - 上传面板提前说明 8 GiB、32 files 与「不支持文件夹」；
 * - 远端会话的后端锁定原因必须是「远端只支持 pi」，不能复用「已发送消息后锁定」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

const flush = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => {
	for (let i = 0; i < 5; i += 1) await flush();
};

const { readRemoteUploadNotice, remoteUploadFailureCopy, backendLockCopyKeys } = loadTsCommonJs("src/renderer/src/utils/remoteCapabilityLimits.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");

const UPLOADED = [{ name: "a.txt", bytes: 3 }];

test("上传结果分类：失败码与部分失败绝不进入 success 分支", () => {
	// vm 沙箱返回的对象来自另一个 realm：逐字段断言，不用 deepStrictEqual 比较原型。
	const tooLarge = readRemoteUploadNotice({ ok: false, code: "REMOTE_FILE_TOO_LARGE" });
	assert.equal(tooLarge.kind, "error");
	assert.equal(tooLarge.code, "REMOTE_FILE_TOO_LARGE");
	// 拖入目录时主进程按「不是常规文件」拒绝：这同样是失败，不是 0 个文件的成功。
	const notAFile = readRemoteUploadNotice({ ok: false, code: "REMOTE_UPLOAD_NOT_A_FILE" });
	assert.equal(notAFile.kind, "error");
	assert.equal(notAFile.code, "REMOTE_UPLOAD_NOT_A_FILE");
	assert.equal(readRemoteUploadNotice({ ok: true, value: { canceled: true } }).kind, "none");
	const partial = readRemoteUploadNotice({ ok: true, value: { uploaded: UPLOADED, failed: [{ name: "b.bin", code: "REMOTE_FILE_TOO_LARGE" }] } });
	assert.equal(partial.kind, "partial");
	assert.equal(partial.failedCount, 1);
	assert.equal(partial.code, "REMOTE_FILE_TOO_LARGE");
	assert.equal(readRemoteUploadNotice({ ok: true, value: { uploaded: UPLOADED, failed: [] } }).kind, "success");
});

test("上传失败码映射：超限与文件夹都有明确文案，未知码不吞掉", () => {
	const tooLarge = remoteUploadFailureCopy("REMOTE_FILE_TOO_LARGE");
	assert.equal(tooLarge.key, "project.remote.uploadTooLarge");
	assert.equal(tooLarge.withCode, false);
	const notAFile = remoteUploadFailureCopy("REMOTE_UPLOAD_NOT_A_FILE");
	assert.equal(notAFile.key, "project.remote.uploadNotAFile");
	assert.equal(notAFile.withCode, false);
	const unknown = remoteUploadFailureCopy("REMOTE_SOMETHING_NEW");
	assert.equal(unknown.key, "project.remote.uploadFailed");
	assert.equal(unknown.withCode, true);
});

test("上传限制文案：zh-CN/en-US 都明确 8 GiB、32 files 与不支持文件夹", () => {
	for (const [dictionary, label] of [
		[zhCN, "zh-CN"],
		[enUS, "en-US"],
	]) {
		const hint = dictionary["project.remote.uploadLimitHint"];
		assert.ok(hint, label + " 缺少 uploadLimitHint");
		assert.match(hint, /8 GiB/);
		assert.match(hint, /32/);
		assert.match(hint, label === "zh-CN" ? /文件夹/ : /[Ff]older/);
	}
	// 文件夹失败（只接受常规文件）与超限失败都有可行动文案，而不是泛化错误。
	assert.match(zhCN["project.remote.uploadNotAFile"], /文件夹|目录/);
	assert.match(zhCN["project.remote.uploadTooLarge"], /8 GiB/);
	assert.match(enUS["project.remote.uploadNotAFile"], /folder/i);
	assert.match(enUS["project.remote.uploadTooLarge"], /8 GiB/);
});

test("后端锁定文案：远端固定 pi 与「会话已开始」使用不同 key", () => {
	const remoteCopy = backendLockCopyKeys(true);
	assert.equal(remoteCopy.hint, "session.backendRemotePiOnlyHint");
	assert.equal(remoteCopy.notice, "session.backendRemotePiOnlyNotice");
	const localCopy = backendLockCopyKeys(false);
	assert.equal(localCopy.hint, "session.backendLockedHint");
	assert.equal(localCopy.notice, "session.backendLockedNotice");
	for (const dictionary of [zhCN, enUS]) {
		assert.ok(dictionary["session.backendRemotePiOnlyHint"]);
		assert.ok(dictionary["session.backendRemotePiOnlyNotice"]);
		assert.notEqual(dictionary["session.backendRemotePiOnlyHint"], dictionary["session.backendLockedHint"]);
	}
	assert.match(zhCN["session.backendRemotePiOnlyHint"], /pi/);
	assert.match(zhCN["session.backendRemotePiOnlyNotice"], /远端项目/);
});

test("上传提示组件渲染 8 GiB / 32 files / 文件夹限制", () => {
	const { RemoteUploadLimitsHint } = loadTsCommonJs("src/renderer/src/components/session/RemoteUploadLimitsHint.tsx", { stubs: { react: React } });
	const html = renderToStaticMarkup(React.createElement(RemoteUploadLimitsHint));
	assert.match(html, /data-testid="remote-upload-limits-hint"/);
	assert.match(html, /8 GiB/);
	assert.match(html, /32/);
	assert.match(html, /文件夹/);
});

function transferHarness(results) {
	const host = quickMessageHookHost();
	const errors = [];
	const reloads = [];
	const calls = [];
	const queue = [...results];
	const services = {
		projectId: "p1",
		capabilities: { files: { read: true, write: true, upload: true, download: true } },
		files: {
			uploadFiles: async (target, source) => {
				if (source.kind === "picker") calls.push({ kind: "dialog", target });
				else calls.push({ kind: "paths", target, paths: source.paths });
				return queue.shift();
			},
			downloadFile: async () => ({ ok: true, value: { canceled: true } }),
		},
	};
	const desktopApi = {
		files: { getPathForFile: () => "D:/dropped/folder" },
	};
	const { useRemoteProjectTransfer } = loadTsCommonJs("src/renderer/src/hooks/useRemoteProjectTransfer.ts", {
		stubs: {
			react: host.react,
			"../desktopApi": { desktopApi },
			// 只断言 key（文案由词典测试覆盖），不加载整份 i18n 运行时。
			"../i18n": { t: (key, params) => (params ? key + JSON.stringify(params) : key) },
		},
	});
	let state = null;
	const render = () =>
		(state = host.render(() =>
			useRemoteProjectTransfer({
				services,
				directory: "",
				reload: async () => {
					reloads.push(1);
				},
				setError: (message) => errors.push(message),
				searching: false,
			}),
		));
	return { host, render, view: () => state, errors, reloads, calls };
}

test("超限上传：显示 8 GiB 限制错误，不刷新列表（不是成功）", async () => {
	const h = transferHarness([{ ok: false, code: "REMOTE_FILE_TOO_LARGE" }]);
	h.render();
	h.view().uploadFiles();
	await settle();
	assert.equal(h.errors.at(-1), "project.remote.uploadTooLarge");
	assert.equal(h.reloads.length, 0, "失败不能走成功路径的 reload");
	h.host.unmount();
});

test("拖入文件夹（非普通文件）：显示文件夹不支持提示，不刷新列表", async () => {
	const h = transferHarness([{ ok: false, code: "REMOTE_UPLOAD_NOT_A_FILE" }]);
	h.render();
	h.view().dropFiles([{ name: "folder" }]);
	await settle();
	assert.equal(h.calls[0].kind, "paths");
	assert.equal(h.errors.at(-1), "project.remote.uploadNotAFile");
	assert.match(zhCN[h.errors.at(-1)], /文件夹|目录/);
	assert.equal(h.reloads.length, 0);
	h.host.unmount();
});

test("成功才刷新列表；部分失败在刷新后给出失败明细", async () => {
	const h = transferHarness([{ ok: true, value: { uploaded: UPLOADED, failed: [] } }]);
	h.render();
	h.view().uploadFiles();
	await settle();
	assert.equal(h.reloads.length, 1);
	assert.equal(h.errors.length, 0);

	const partial = transferHarness([{ ok: true, value: { uploaded: UPLOADED, failed: [{ name: "big.bin", code: "REMOTE_FILE_TOO_LARGE" }] } }]);
	partial.render();
	partial.view().uploadFiles();
	await settle();
	assert.equal(partial.reloads.length, 1);
	assert.match(partial.errors.at(-1), /^project\.remote\.uploadPartial/);
	assert.match(partial.errors.at(-1), /project\.remote\.uploadTooLarge/);
	partial.host.unmount();
});

test("取消上传：不刷新、不报错（既不成功也不失败）", async () => {
	const h = transferHarness([{ ok: true, value: { canceled: true } }]);
	h.render();
	h.view().uploadFiles();
	await settle();
	assert.equal(h.reloads.length, 0);
	assert.equal(h.errors.length, 0);
	h.host.unmount();
});
