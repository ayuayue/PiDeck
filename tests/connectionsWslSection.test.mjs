import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 第 10 步：连接页列出 WSL 档案并可在新增弹窗里创建；删除只删本机档案，引用时拒绝。
const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");

test("connections page lists WSL profiles on Windows only", () => {
	assert.match(tab, /const wslSupported = detectRendererPlatform\(\) === "win32"/);
	assert.match(tab, /listWslHosts\(\)/);
	assert.match(tab, /settings\.connections\.wsl\.badge/);
	assert.match(tab, /host\.distro\} · \{host\.user/);
	// 空态按平台给不同的下一步：只有 Windows 才提 WSL 发行版。
	assert.match(tab, /\{wslSupported \? t\("settings\.connections\.emptyHintWsl"\) : t\("settings\.connections\.emptyHint"\)\}/);
});

test("one new-connection entry covers both SSH and WSL", () => {
	// 唯一入口：顶部「新建连接」打开带 SSH/WSL 类型切换的弹窗，页面里不再有第二个新建按钮。
	assert.equal((tab.match(/setAdding\(true\)/g) ?? []).length, 1);
	assert.doesNotMatch(tab, /settings\.connections\.wsl\.add"/);
	assert.doesNotMatch(tab, /initialKind="wsl"/);
	// 两类连接同列一张表：同一个 divide-y 容器里先后渲染，不再各开一段。
	assert.match(tab, /divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle">[\s\S]{0,60}\{hosts\.map/);
	assert.match(tab, /\{wslHosts\.map\(\(host\) => \(/);
});

test("WSL profiles are created from the add dialog, not the dev settings", () => {
	assert.match(dialog, /initialKind\?: ConnectionKind/);
	assert.match(dialog, /useState<ConnectionKind>\(props\.initialKind \?\? "ssh"\)/);
	assert.match(dialog, /id="wsl-host-distro"/);
	assert.match(dialog, /id="wsl-host-user"/);
	assert.match(dialog, /addWslHost\(\{ label, distro, user \}\)/);
	// 新建 WSL 连接直接检测本机发行版：切到 WSL 页拉一次列表，检出的可选、可手填。
	assert.match(dialog, /desktopApi\.wsl[\s\S]{0,40}\.listDistros\(\)/);
	assert.match(dialog, /<datalist id="wsl-distro-options">/);
	assert.match(dialog, /settings\.connections\.add\.wsl\.detecting/);
	assert.match(dialog, /settings\.connections\.add\.wsl\.detected/);
	assert.match(dialog, /settings\.connections\.add\.wsl\.noneDetected/);
	// 检出后只在输入为空时预填第一个发行版，不覆盖用户已填的内容。
	assert.match(dialog, /current\.distro\.trim\(\)\.length === 0/);
	// 不再深链到「设置 → 开发」。
	assert.doesNotMatch(dialog, /openSettings\(\{ tab: "dev" \}\)/);
});

test("removal is confirmed and explains reference refusal", () => {
	assert.match(tab, /removeWslHost\(removingWsl\.id\)/);
	assert.match(tab, /WSL_HOST_REFERENCED/);
	assert.match(tab, /wsl\.remove\.referenced/);
	assert.match(tab, /settings\.connections\.wsl\.remove\.body/);
});
