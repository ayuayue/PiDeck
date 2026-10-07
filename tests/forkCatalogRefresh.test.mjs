import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 回归：fork/clone（pi 与 DSH）成功后必须推送 sessionsCatalogRefreshed。
 * 2027-03 用户反馈「dsh fork 之后侧栏列表不刷新」；排查发现 pi 分支同样只回包
 * 不推送——侧栏只认 catalog-refreshed 推送（useProjectSync），不推就要等手动刷新。
 * 这里做源码契约断言（空白容忍，改格式不炸）。
 */

const source = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");

test("fork/clone 成功路径统一经 notifyForkCatalogRefreshed 推送 catalog 刷新", () => {
	// 定义存在：解析 catalog 的 projectId → 主窗口存在且未销毁才发送
	assert.match(source, /function notifyForkCatalogRefreshed\(sessionId: string\): void \{[\s\S]*?sessionCatalog\.get\(sessionId\)\?\.projectId[\s\S]*?getMainWindow\(\)[\s\S]*?isDestroyed\(\)[\s\S]*?send\(ipcChannels\.sessionsCatalogRefreshed, \{ projectId \}\)/);
	// 4 条成功路径（DSH/pi × fork/clone）都要调用：1 处定义 + 4 处调用
	const calls = source.match(/notifyForkCatalogRefreshed\(target\.sessionId\);/g) ?? [];
	assert.equal(calls.length, 4);
});

test("DSH 与 pi 的 fork/clone 成功块都在 return 前推送", () => {
	const blocks = [
		["dsh clone", /withRuntimeReservation\(target\.sessionId, target\.agentId, \(\) => cloneDshAgentSession\(target\)\)[\s\S]{0,400}?notifyForkCatalogRefreshed\(target\.sessionId\);\s*return \{ ok: true/],
		["pi clone", /replaceAgentSession\(target\.agentId, \(\) => agentManager\.cloneSession\(target\.agentId\), \{ markForked: true \}\)[\s\S]{0,300}?notifyForkCatalogRefreshed\(target\.sessionId\);\s*return \{/],
		["dsh fork", /withRuntimeReservation\(target\.sessionId, target\.agentId, \(\) => forkDshAgentSession\(target, entryId\)\)[\s\S]{0,400}?notifyForkCatalogRefreshed\(target\.sessionId\);\s*return \{ ok: true/],
		["pi fork", /replaceAgentSession\(\s*target\.agentId,\s*\(\) => agentManager\.forkSession\(target\.agentId, entryId\),[\s\S]{0,500}?markForked: true[\s\S]{0,400}?notifyForkCatalogRefreshed\(target\.sessionId\);\s*return \{/],
	];
	for (const [label, pattern] of blocks) {
		assert.ok(pattern.test(source), `${label} success path must notifyForkCatalogRefreshed before return`);
	}
});
