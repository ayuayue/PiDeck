import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const state = loadTsCommonJs("src/renderer/src/utils/remoteProjectTransferState.ts");
const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");

test("传输进度单调、按总字节截断，未知总大小不产生伪百分比", () => {
	let items = [state.createRemoteTransferUiItem(1, "upload")];
	items = state.remoteTransferStarted(items, 1, 100);
	items = state.remoteTransferProgress(items, 1, "upload", 25, 100);
	assert.equal(items[0].id, 1);
	assert.equal(items[0].operation, "upload");
	assert.equal(items[0].phase, "running");
	assert.equal(items[0].transferred, 25);
	assert.equal(items[0].total, 100);
	items = state.remoteTransferProgress(items, 1, "upload", 50, 100);
	items = state.remoteTransferProgress(items, 1, "upload", 40, 100);
	assert.equal(items[0].transferred, 50, "迟到的小进度不能倒退");
	items = state.remoteTransferProgress(items, 1, "upload", 150, 100);
	assert.equal(items[0].transferred, 100, "进度必须截断到 total");
	assert.equal(state.remoteTransferPercent(items[0]), 100);
	items = state.remoteTransferProgress(items, 1, "upload", 70, 90);
	assert.equal(items[0].total, 100, "首个已知 total 固定后不能中途换分母");

	let unknown = [state.createRemoteTransferUiItem(2, "download")];
	unknown = state.remoteTransferStarted(unknown, 2, 0);
	unknown = state.remoteTransferProgress(unknown, 2, "download", 7, 0);
	assert.equal(unknown[0].operation, "download");
	assert.equal(unknown[0].phase, "running");
	assert.equal(unknown[0].transferred, 7);
	assert.equal(unknown[0].total, 0);
	assert.equal(state.remoteTransferPercent(unknown[0]), undefined);
	assert.equal(state.formatRemoteTransferBytes(7), "7 B");
});

test("错误操作被丢弃，终态只结算一次且 unknown 永不变成成功", () => {
	let items = [state.createRemoteTransferUiItem(3, "upload")];
	items = state.remoteTransferStarted(items, 3, 20);
	items = state.remoteTransferProgress(items, 3, "download", 8, 20);
	assert.equal(items[0].transferred, 0);
	items = state.remoteTransferProgress(items, 3, "upload", 8, 20);
	items = state.settleRemoteTransferUi(items, 3, "unknown", { code: "REMOTE_UPLOAD_COMMIT_UNCONFIRMED" });
	assert.equal(items[0].phase, "unknown");
	items = state.settleRemoteTransferUi(items, 3, "succeeded");
	assert.equal(items[0].phase, "unknown", "terminal 后不得被第二个结果覆盖");
	assert.equal(state.isRemoteTransferActive(items[0].phase), false);
});

test("取消可覆盖准备态，关闭只移除终态", () => {
	let items = [state.createRemoteTransferUiItem(4, "download"), state.createRemoteTransferUiItem(5, "upload")];
	items = state.remoteTransferCancelling(items, 4);
	assert.equal(items[0].phase, "cancelling");
	assert.equal(state.dismissRemoteTransferUi(items, 4).length, 2, "活动任务不能被关闭按钮藏掉");
	items = state.settleRemoteTransferUi(items, 4, "cancelled");
	assert.equal(state.dismissRemoteTransferUi(items, 4).length, 1);
});

test("状态卡展示上传/下载、字节进度、取消按钮与 unknown 专门提示", () => {
	const t = (key, params = {}) => (zhCN[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
	const Button = ({ children, variant: _variant, size: _size, ...props }) => React.createElement("button", props, children);
	const Icon = () => React.createElement("svg", { "aria-hidden": "true" });
	const Progress = ({ value, className: _className, ...props }) => React.createElement("div", { ...props, role: "progressbar", "aria-valuenow": value });
	const { RemoteProjectTransferStatus } = loadTsCommonJs("src/renderer/src/components/session/RemoteProjectTransferStatus.tsx", {
		stubs: {
			lucide: { AlertTriangle: Icon, Check: Icon, Loader2: Icon, X: Icon },
			"../../i18n": { t },
			"../ui-shadcn/button": { Button },
			"../ui-shadcn/progress": { Progress },
		},
	});
	const items = [
		{ id: 6, operation: "upload", phase: "running", transferred: 50, total: 100 },
		{ id: 7, operation: "download", phase: "unknown", transferred: 20, total: 20, code: "REMOTE_DOWNLOAD_RESULT_UNCONFIRMED" },
		{ id: 8, operation: "upload", phase: "failed", transferred: 0, total: 28, code: "FILE_UPLOAD_TARGET_EXISTS" },
	];
	const html = renderToStaticMarkup(React.createElement(RemoteProjectTransferStatus, { items, onCancel() {}, onDismiss() {} }));
	assert.match(html, /data-testid="remote-transfer-status"/);
	assert.match(html, /data-phase="running"/);
	assert.match(html, /role="progressbar"/);
	assert.match(html, /aria-valuenow="50"/);
	assert.match(html, /50 B \/ 100 B/);
	assert.match(html, /data-testid="remote-transfer-cancel-6"/);
	assert.match(html, /下载/);
	assert.match(html, /结果未知：REMOTE_DOWNLOAD_RESULT_UNCONFIRMED/);
	assert.match(html, /不要直接重试/);
	assert.match(html, /远端已有同名文件，未覆盖/);
	assert.doesNotMatch(html, /传输失败：FILE_UPLOAD_TARGET_EXISTS/);
});

test("zh-CN/en-US 都有进度与取消文案，unknown 明确要求核对而非重试", () => {
	const keys = [
		"transferUpload",
		"transferDownload",
		"transferPreparing",
		"transferProgress",
		"transferTransferred",
		"transferCancelling",
		"transferSucceeded",
		"transferPartial",
		"transferCancelled",
		"transferUnknown",
		"transferFailed",
		"transferCancellingAction",
		"transferCancel",
		"transferDismiss",
		"transferProgressAria",
	];
	for (const [dictionary, label] of [
		[zhCN, "zh-CN"],
		[enUS, "en-US"],
	]) {
		for (const key of keys) assert.ok(dictionary[`project.remote.${key}`], `${label} missing ${key}`);
	}
	assert.match(zhCN["project.remote.transferUnknown"], /核对.*不要直接重试/);
	assert.match(enUS["project.remote.transferUnknown"], /check.*do not retry/i);
});
