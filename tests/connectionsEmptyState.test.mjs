import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 设置 → 连接的空态原先只有一句「还没有已登记的主机」+ 底部按钮；
// 现在给一个能直接行动的引导卡，并避免与底部主按钮重复。

const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");

test("empty connections state is an actionable card", () => {
	assert.match(tab, /settings\.connections\.emptyTitle/);
	assert.match(tab, /border-dashed/);
	// 添加入口保留在列表顶部；空态卡与顶部「新建连接」不重复堆叠主按钮。
	assert.match(tab, /<Button size="sm" onClick=\{\(\) => setAdding\(true\)\}>/);
});
