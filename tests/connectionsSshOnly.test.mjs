import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 设置 → 连接只列 SSH 主机。
 *
 * WSL 不是「连接」，而是本机 pi 的来源（开发设置里的 enabled/distro/user）：它没有 host key、
 * 没有认证、也不该在这里增删。连接页一旦再出现 WSL 档案区或「新建连接」里的 WSL 模式，
 * 就等于把已经废弃的档案层重新接回 UI。
 */

const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");

test("连接页不再有任何 WSL 档案入口", () => {
	assert.doesNotMatch(tab, /listWslHosts|addWslHost|removeWslHost|updateWslHost/);
	assert.doesNotMatch(tab, /wslHosts|removingWsl|wslSupported/);
	assert.doesNotMatch(tab, /settings\.connections\.wsl\./);
	// 计数只算 SSH 主机。
	assert.match(tab, /settings\.connections\.devices", \{ count: String\(hosts\.length\) \}/);
});

test("新建连接只提供 SSH：类型切换与 WSL 表单都已移除", () => {
	assert.doesNotMatch(dialog, /ConnectionKind/);
	assert.doesNotMatch(dialog, /addWslHost/);
	assert.doesNotMatch(dialog, /initialKind/);
	assert.doesNotMatch(dialog, /wsl-host-distro|wsl-host-user/);
	assert.doesNotMatch(dialog, /settings\.connections\.add\.kind\./);
	// 唯一入口仍是顶部「新建连接」，页内没有第二个新建按钮。
	assert.equal((tab.match(/setAdding\(true\)/g) ?? []).length, 1);
});
