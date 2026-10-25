import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/**
 * 回归：fork/clone（pi 与 DSH）成功后必须推送 sessionsCatalogRefreshed。
 * 2027-03 用户反馈「dsh fork 之后侧栏列表不刷新」；排查发现 pi 分支同样只回包
 * 不推送——侧栏只认 catalog-refreshed 推送（useProjectSync），不推就要等手动刷新。
 * 2027-04 fork/clone 已收口到 src/main/sessions/sessionForkCommands.ts（桌面/Web 共用命令层），
 * 契约断言同步改读新模块（空白容忍，改格式不炸）。
 */

const source = readFileSync("src/main/sessions/sessionForkCommands.ts", "utf8");

test("fork/clone 成功路径统一经 notifyForkCatalogRefreshed 推送 catalog 刷新", () => {
	// 4 条成功路径（DSH/pi × fork/clone）都要调用：deps.notifyForkCatalogRefreshed
	const calls = source.match(/notifyForkCatalogRefreshed\(target\.sessionId\);/g) ?? [];
	assert.equal(calls.length, 4);
});

test("DSH 与 pi 的 fork/clone 成功块都在 return 前推送", () => {
	const blocks = [
		["dsh clone", /dshClone\(target\)[\s\S]{0,400}?notifyForkCatalogRefreshed\(target\.sessionId\);\s*return \{ ok: true/],
		["pi clone", /replaceAgentSession\(target\.agentId, \(\) => deps\.agentManager\.cloneSession\(target\.agentId\), \{ markForked: true \}\)[\s\S]{0,300}?notifyForkCatalogRefreshed\(target\.sessionId\);\s*return \{/],
		["dsh fork", /dshFork\(target, entryId\)[\s\S]{0,400}?notifyForkCatalogRefreshed\(target\.sessionId\);\s*return \{ ok: true/],
		["pi fork", /replaceAgentSession\(\s*target\.agentId,\s*\(\) => deps\.agentManager\.forkSession\(target\.agentId, entryId\),[\s\S]{0,500}?markForked: true[\s\S]{0,400}?notifyForkCatalogRefreshed\(target\.sessionId\);\s*return \{/],
	];
	for (const [label, pattern] of blocks) {
		assert.ok(pattern.test(source), `${label} success path must notifyForkCatalogRefreshed before return`);
	}
});

test("尾部重发/编辑 fork 化（mutationFork 且非 branchMode）走 markSuperseded 隐藏旧会话", () => {
	// 与桌面端语义一致：mutationFork && !branchMode → { markForked: false, markSuperseded: true }
	assert.match(source, /mutationFork && !branchMode \? \{ markForked: false, markSuperseded: true \} : \{ markForked: true \}/);
});
