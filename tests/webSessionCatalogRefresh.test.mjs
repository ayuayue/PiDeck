import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { mainIpcSource } from "./helpers/mainIpcSources.mjs";
/**
 * 回归 issue #436：通过 Web API 删会话后桌面端列表不刷新——`deleteSessionRecord` 删完没广播
 * `sessions:catalog-refreshed`，渲染进程不是发起方，只能等下次手动刷新才看到幽灵行消失。
 * 同类缺口（Web 端建草稿/改名换模型/复制）一并覆盖。
 *
 * 广播本身的行为（窗口已销毁、同项目去重、空 projectId）在下面用假窗口跑真模块；
 * 接线部分仍按仓库既有做法断言 index.ts 的调用点——deps 对象在 `app.whenReady` 闭包里，
 * 没有可注入的 seam，起 Electron 才能运行时验证。
 */
const { broadcastCatalogRefreshed } = loadTsCommonJs("src/main/sessions/catalogRefresh.ts");

function createWindow({ destroyed = false } = {}) {
	const sent = [];
	return {
		sent,
		window: {
			isDestroyed: () => destroyed,
			webContents: {
				send: (channel, payload) => sent.push({ channel, payload }),
			},
		},
	};
}

test("broadcastCatalogRefreshed：按项目各发一次，同项目去重", () => {
	const { sent, window } = createWindow();
	broadcastCatalogRefreshed(["p1", "p1", "p2"], { channel: "sessions:catalog-refreshed", getWindow: () => window });
	// VM 里造的 payload 跨 realm，deepEqual 比原型会假红：只比内容。
	assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
		{ channel: "sessions:catalog-refreshed", payload: { projectId: "p1" } },
		{ channel: "sessions:catalog-refreshed", payload: { projectId: "p2" } },
	]);
});

test("broadcastCatalogRefreshed：窗口不存在/已销毁时静默跳过，不抛错", () => {
	const destroyed = createWindow({ destroyed: true });
	assert.doesNotThrow(() => broadcastCatalogRefreshed(["p1"], { channel: "sessions:catalog-refreshed", getWindow: () => destroyed.window }));
	assert.deepEqual(destroyed.sent, []);
	assert.doesNotThrow(() => broadcastCatalogRefreshed(["p1"], { channel: "sessions:catalog-refreshed", getWindow: () => undefined }));
});

test("broadcastCatalogRefreshed：空 projectId 不发脏事件", () => {
	const { sent, window } = createWindow();
	broadcastCatalogRefreshed(["", "p1"], { channel: "sessions:catalog-refreshed", getWindow: () => window });
	assert.deepEqual(
		sent.map((item) => item.payload.projectId),
		["p1"],
	);
});

const indexSource = mainIpcSource;
test("Web API 四个会话写操作都在落库后广播 catalog 刷新（#436）", () => {
	// deleteSessionRecord：必须等 removeWithDescendants 成功后再发，早发会把刚删的行重拉回来。
	assert.match(indexSource, /await sessionCatalog\.removeWithDescendants\(sessionId\);[\s\S]{0,240}?notifyCatalogRefreshed\(\[entry\.projectId\]\);\s*return true;/);
	// createSessionDraft：Web 建的草稿不是渲染进程发的，不推侧栏就一直看不到这一行。
	// standby 预热只对 pi 会话有意义，dsh/acp 草稿不预热（锚点随之更新，断言强度不变）。
	assert.match(indexSource, /if \(draft\.backend !== "dsh" && draft\.backend !== "acp"\) agentManager\.ensureStandbyAgent\(draft\.projectId\);[\s\S]{0,200}?notifyCatalogRefreshed\(\[draft\.projectId\]\);/);
	// updateSessionRecord：改名/换模型后侧栏标题要跟着变。
	assert.match(indexSource, /const updated = await sessionCatalog\.update\(sessionId, \{[\s\S]{0,400}?notifyCatalogRefreshed\(\[updated\.projectId\]\);\s*return updated;/);
	// copySessionRecord：副本要立刻出现在侧栏。
	assert.match(indexSource, /copySessionRecord: async \(sessionId\) => \{[\s\S]{0,400}?if \(projectId\) notifyCatalogRefreshed\(\[projectId\]\);/);
});
