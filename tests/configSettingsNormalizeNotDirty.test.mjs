/**
 * 回归：进设置页就报「有未保存更改」，实际没改（用户报障，WSL 模式最常见）。
 *
 * 根因：SettingsTab 首次挂载时会对 settings.json 做格式归一（补默认 compaction、剔除
 * 旧版 retry 字段），归一结果经 props.onChange 回写草稿，与 ConfigModal 的「脏 = 草稿 vs
 * 基准」判定撞车——目标机的 settings.json 只要缺这几个键，每次进页面都会立刻变脏。
 *
 * 锁两件事：
 * 1. 两个挂载期归一 effect 明确以 "normalize" 理由回写（区别于用户编辑）；
 * 2. ConfigModal 收到该理由时同步刷新基准快照，而不 markDirty。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const settingsTab = readFileSync("src/renderer/src/config/SettingsTab.tsx", "utf8");
const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");

test("SettingsTab：挂载期归一以 normalize 理由回写，用户编辑不带理由", () => {
	assert.match(settingsTab, /onChange: \(data: SettingsFile, reason\?: "normalize"\) => void;/);
	assert.match(settingsTab, /props\.onChange\(\{ \.\.\.data, retry: retryConfig \}, "normalize"\)/);
	assert.match(settingsTab, /props\.onChange\(\{ \.\.\.data, compaction: next \}, "normalize"\)/);
	// 用户编辑路径（重试/压缩任一字段）不得标成归一
	assert.match(settingsTab, /const updateRetry = \(patch: Record<string, unknown>\) => \{\s*props\.onChange\(\{\s*\.\.\.data,\s*retry: \{ \.\.\.retryConfig, \.\.\.patch \},\s*\}\);/);
});

test("ConfigModal：归一回写刷新基准快照而不是 markDirty", () => {
	const handler = configModal.match(/onChange=\{\(data, reason\) => \{[\s\S]*?\n\t\t\t\t\t\t\t\t\t{2}\}\}/);
	assert.ok(handler, "SettingsTab 的 onChange 处理器未找到");
	assert.match(handler[0], /baselineSettingsRef\.current = deepClone\(data\)/, "归一时必须同步基准，否则每次进设置都假脏");
	assert.match(handler[0], /reason === "normalize"/);
	// 非归一路径仍是正常的脏标记
	assert.ok(handler[0].indexOf("markDirty(\"config:settings\")") > handler[0].indexOf("reason === \"normalize\""));
});
