import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归：配置管理 → 设置页「默认供应商与模型」两个下拉框一片空白，
 * 但 settings.json 里的 defaultProvider/defaultModel 对 pi 会话仍然生效。
 *
 * 复现路径（用户实测）：配置管理直接落在「设置」tab（或从别的 tab 点进来）时，
 * SettingsTab 在 settingsData 还是 {} 的瞬间挂载：
 *   1. 挂载期的 retry/compaction 格式归一用空 data 回写表单（onChange reason="normalize"），
 *      并立刻改写 baselineSettingsRef；
 *   2. 父组件的脏检测 effect 用本轮渲染的旧 state（{}）与已被改写的 ref 比较 → 判定不一致
 *      → config:settings 被标脏；
 *   3. 紧接着的 loadConfig 认为存在未保存草稿 → skipSettings=true → 磁盘数据不写回；
 *   4. 下一轮脏检测又发现相等 → 黄点消失，于是只有「框是空的」这一个可见症状
 *      （页头「N 个配置项」也会缩水成归一生出来的那几个键）。
 *
 * 修法：settingsLoaded 之前不渲染 SettingsTab，让挂载必然发生在磁盘数据到位之后。
 */
const modal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");
const shared = readFileSync("src/renderer/src/config/ConfigShared.tsx", "utf8");

test("SettingsTab 只在磁盘 settings 读入后才挂载（消除空 data 挂载引发的假脏 → 跳过 loadConfig）", () => {
	// 渲染门禁必须同时含 loading 与 settingsLoaded
	const gate = modal.match(/\{!loading && settingsLoaded && \(\s*<SettingsTab/);
	assert.ok(gate, "SettingsTab 必须以 !loading && settingsLoaded 为渲染门禁，否则会在 settingsData={} 时挂载");

	// 反证：不得存在只判断 loading 的 SettingsTab 挂载
	assert.doesNotMatch(modal, /\{!loading && \(\s*<SettingsTab/);
});

test("settingsLoaded 在 settings 读取分支被置为 true（门禁不会永远关着）", () => {
	assert.match(modal, /setSettingsLoaded\(true\);/, "settings 读取成功后必须置 settingsLoaded=true");
});

test("combobox 触发器显式 type=text：PopoverTrigger asChild 不再把 <Input> 变成空白按钮", () => {
	const trigger = shared.match(/<PopoverTrigger asChild>[\s\S]{0,1500}?<\/PopoverTrigger>/);
	assert.ok(trigger, "未找到 ConfigComboboxInput 的 PopoverTrigger");
	assert.match(trigger[0], /<Input\s+type="text"/, 'Input 必须显式写 type="text"，否则 Radix 注入 type=button，空值时 placeholder 不渲染');
});
