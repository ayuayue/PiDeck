/**
 * IPC 分流顺序守卫：远端分支必须在「本机文件路径解析」**之前**（2026-10 修复）。
 *
 * 为什么需要：`localSessionFilePath(sessionId)` 对 ssh locator 抛稳定码。它若排在远端分流之前，整条远端分支就是
 * **不可达的死代码**——「重启后打开远端会话读不到历史」的真因，而且运行中会话走 runtime 内存消息，
 * 真机验收当时抓不到。这条守卫把顺序固化，避免以后被"顺手整理"回去。
 *
 * 说明：这是结构守卫（不是行为测试）。行为级回归已由 lane 在复现时验证过；把导出/读页两条路由包成行为测试
 * 需要扩展 tests/remoteSessionHtmlExport.test.mjs 的 IPC 夹具（读端口 deps），留作后续补强。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { sessionIpcSource } from "./helpers/sessionIpcSources.mjs";

const SOURCE = sessionIpcSource;

/** 剥掉注释：注释里也会出现 `localSessionFilePath(sessionId)` 这类字面量，不剥会把「注释在前」误判成代码顺序。 */
function codeOnly(body) {
	return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[\t ]*\/\/[^\n]*/gm, "");
}

/** 取一个 ipcMain.handle 的 handler 正文（到下一条 ipcMain.handle 为止）。 */
function handlerBody(channelKey) {
	const start = SOURCE.indexOf(`ipcMain.handle(ipcChannels.${channelKey}`);
	assert.ok(start >= 0, `找不到 handler: ${channelKey}`);
	const next = SOURCE.indexOf("ipcMain.handle(", start + 10);
	return SOURCE.slice(start, next > 0 ? next : undefined);
}

for (const channel of ["sessionsCatalogReadMessagePage", "sessionsCatalogExportHtml"]) {
	test(`${channel}：远端分流排在本机路径解析之前`, () => {
		const code = codeOnly(handlerBody(channel));
		// 远端分流按 ssh locator 判定（各 handler 写法略有差异，认特征片段而不是完整表达式）。
		const remoteAt = code.search(/kind === "ssh"/);
		// 本机路径解析：导出链路走 localSessionFilePath()，读页链路在合并后直接用 dev 的
		// `entry.filePath`（ssh 条目已在上方 return；乱序会让本机链路先看到被清空的路径）。
		const localAt = Math.min(...[code.search(/localSessionFilePath\s*\(\s*sessionId\s*\)/), code.search(/entry\??\.filePath/)].filter((index) => index >= 0));
		assert.ok(remoteAt >= 0, "handler 里必须存在远端分流（按 ssh locator 判定）");
		assert.ok(Number.isFinite(localAt), "handler 里必须存在本机路径解析");
		assert.ok(remoteAt < localAt, "远端分流必须排在本机路径解析之前，否则远端分支不可达（见本文件头注释）");
	});
}

test("读页 handler 里保留顺序说明（防被当成冗余注释清理掉）", () => {
	assert.match(handlerBody("sessionsCatalogReadMessagePage"), /顺序要求（2026-10 修复）/);
});
