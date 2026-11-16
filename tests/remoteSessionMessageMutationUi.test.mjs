import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { rendererAppSource } from "./helpers/rendererAppSources.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
/**
 * P4.5c（远端消息编辑 / 删除 / 准备重发）的**接线守卫**。
 *
 * 为什么需要它：远端写面这一批交付的是"后端链路 + 装配"，而它有两个很容易被后续改动悄悄弄丢的接点——
 * ① 渲染层的「有持久化会话文件」判据（`hasPersistedSessionFile`）：ssh 记录的 `filePath` 是空的，
 *    判据只认 `filePath` 就会把远端会话当成匿名会话，三条链路在 UI 上**永远走不到**（点编辑只得到
 *    "匿名会话不支持"）；② 装配层必须把写面接到**同一条** pinned SSH 短命令通道上（与远端读取、远端归档
 *    同源），另起一条通道就绕过了 pin/指纹/路由摘要的复查。
 *
 * 这里断言的是"接点还在 + 判据仍然分层"，不是实现细节：正则一律空白容忍，定位用代码声明串而不是
 * 注释里的自然语言（本仓踩过 indexOf 命中注释的坑）。
 */

const app = rendererAppSource;
const main = mainIpcSource;
test("the persisted-session predicate counts remote (ssh) identities as file-backed", () => {
	// 远端分支必须出现，且认的是 locator 里的远端身份（remoteSessionId / remotePath），不是 filePath。
	const predicate = app.slice(app.indexOf("hasPersistedSessionFile: (sessionId) => {"));
	const block = predicate.slice(0, predicate.indexOf("isImageGenSession"));
	assert.match(block, /record\.locator\?\.kind\s*===\s*"ssh"/, "the predicate must branch on the ssh locator");
	assert.match(block, /record\.locator\.remoteSessionId\s*\|\|\s*record\.locator\.remotePath/, "the ssh branch must accept either remote identity field");
	// 本机语义不变：非 ssh 仍然要求 filePath，且 noSession 一律不算。
	assert.match(block, /return\s+Boolean\(record\.filePath\)/, "the local branch must still require filePath");
	assert.match(block, /if\s*\(!record\s*\|\|\s*record\.noSession\)\s*return\s+false/, "noSession must stay unsupported");
});

test("the remote message-mutation write plane reuses the pinned ssh short-command channel", () => {
	// 与远端读取（readRemoteSessionHistoryPage）/远端归档（archiveRemoteSession）**同一**传输端口：
	// 另起一条通道（或直接 ssh）就绕过了每次调用重新过的 pin / 指纹 / 路由摘要 / 严格配置复查。
	const wiring = main.slice(main.indexOf("createRemoteSessionHistoryWriter("));
	const block = wiring.slice(0, wiring.indexOf(")") + 1);
	assert.match(block, /runPinnedRemoteCommand/, "the writer must use the shared pinned command runner");
	assert.match(block, /resolveSessionRoot/, "the writer must reuse the single session-root resolver");
	// 实验开关关闭时不装配端口（fail-closed：协调器得到稳定码，而不是落回本机路径分支）。
	assert.match(main, /remoteFeatureEnabled\s*\?\s*createRemoteSessionHistoryWriter/, "the port must only exist when the remote feature is available");
});
