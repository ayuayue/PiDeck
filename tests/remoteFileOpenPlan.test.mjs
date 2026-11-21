/**
 * 远端文件「点开」的宿主选择（契约见 src/renderer/src/components/session/remoteFileOpenPlan.ts）。
 *
 * 背景（2026-11-20 用户反馈）：远端点开一个文件，预览被塞在文件抽屉底部 40% 的那一小块里，
 * 而本地点开同一个文件是进中间栏阅读面、按 workspaceContentOpenMode 决定分屏还是整屏——
 * 同一个动作两套位置。现在两边同一条主路径，**不再按文本/二进制分流**：二进制读通道
 * （files:read-base64 的远端分支）已支持 ssh 项目，图片/PDF/Office/压缩包同样进中间栏。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { openRemoteFile, remoteFileOpenHost } = loadTsCommonJs("src/renderer/src/components/session/remoteFileOpenPlan.ts");

test("宿主给了中间栏入口就一律进中间栏（与本机文件同一条主路径）", () => {
	assert.equal(remoteFileOpenHost({ hasWorkbench: true }), "workbench");
});

test("宿主没给中间栏入口时退回面板内，点击不能被吞掉", () => {
	// 其它宿主（只注入 onOpenFile 的历史调用点）不能因为缺入口就变成点不动。
	assert.equal(remoteFileOpenHost({ hasWorkbench: false }), "inline");
});

test("一次调用决定去中间栏还是面板内，切走时收掉面板内预览", () => {
	const calls = [];
	const setInline = (relativePath) => calls.push({ inline: relativePath });
	const onViewFile = (target, openMode) => calls.push({ target, openMode });
	// 文本、二进制走同一条路：都交给宿主中间栏入口。
	openRemoteFile({ target: { projectId: "p1", relativePath: "src/a.ts" }, onViewFile, setInline });
	openRemoteFile({ target: { projectId: "p1", relativePath: "docs/a.png" }, onViewFile, setInline });
	openRemoteFile({ target: { projectId: "p1", relativePath: "README.md" }, openMode: "permanent", onViewFile, setInline });
	// 没有中间栏入口：只喂面板内预览，绝不调用宿主入口。
	openRemoteFile({ target: { projectId: "p1", relativePath: "src/b.ts" }, setInline });
	assert.deepEqual(calls, [
		// 先收掉面板内预览，再交给宿主（否则上一次的兜底预览还挂着，像「点开没反应」）
		{ inline: null },
		{ target: { projectId: "p1", relativePath: "src/a.ts" }, openMode: "preview" },
		{ inline: null },
		{ target: { projectId: "p1", relativePath: "docs/a.png" }, openMode: "preview" },
		// 双击常驻语义原样转发
		{ inline: null },
		{ target: { projectId: "p1", relativePath: "README.md" }, openMode: "permanent" },
		// 缺宿主入口
		{ inline: "src/b.ts" },
	]);
});
