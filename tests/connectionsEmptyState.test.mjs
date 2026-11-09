import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 设置 → 连接的空态原先只有一句「还没有已登记的主机」+ 底部按钮；
// 现在给一个能直接行动的引导卡，并避免与底部主按钮重复。

const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");

test("empty connections state is an actionable card", () => {
	assert.match(tab, /settings\.connections\.emptyTitle/);
	assert.match(tab, /border-dashed/);
	// 添加入口保留在列表顶部；空态卡与顶部「新建连接」不重复堆叠主按钮。
	assert.match(tab, /<Button size="sm" onClick=\{\(\) => setAdding\(true\)\}>/);
});

test("WSL in the add dialog creates a profile instead of deep-linking", () => {
	assert.match(dialog, /addWslHost\(\{ label, distro, user \}\)/);
	assert.match(dialog, /kind === "wsl" \? \(/);
	assert.match(dialog, /id="wsl-host-distro"/);
	// WSL 页不再渲染 SSH 的保存+检测按钮（那条链路只在 SSH 分支里）。
	assert.match(dialog, /\{kind === "ssh" \? \(\s*<>\s*\{setupRunning \|\| setupSettled \? null : \(/);
});
