import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Rebind 面板的界面纪律（设计 §4.4 / §6）：
 * - 不显示 recordId、路径或 pin；
 * - tx 文案显式映射，不拼 key；
 * - 执行阶段没有取消按钮（F2：确认后不可取消）；
 * - 设置页只挂这一个入口（用户已定）。
 */
const panel = readFileSync("src/renderer/src/components/app/settings/RebindPanel.tsx", "utf8");
const connections = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");

test("面板不接触 recordId / 路径 / pin，只显示计数与稳定码", () => {
	assert.ok(!panel.includes(".recordId") && !panel.includes("recordId:"), "recordId 是 main 内部标识，不进界面");
	assert.ok(!panel.includes("beforeLocator") && !panel.includes("afterLocator"));
	assert.ok(!panel.includes("pinAlias"));
	assert.match(panel, /settings\.connections\.rebind\.records/, "只显示计数");
});

test("tx 与 stage 文案显式映射，不拼 key", () => {
	assert.match(panel, /function txLabel\(/);
	assert.match(panel, /function stageLabel\(/);
	assert.ok(!/t\(`settings\.connections\.rebind\.tx\.\$\{/.test(panel), "禁止拼接 i18n key");
	assert.ok(!/t\(`settings\.connections\.rebind\.stage\.\$\{/.test(panel));
});

test("执行阶段没有取消：running 只有说明文字", () => {
	const running = panel.slice(panel.indexOf('state.step === "running"'));
	const nextBlock = running.slice(0, running.indexOf("<DialogFooter>"));
	assert.ok(!nextBlock.includes("<Button"), "running 阶段不得出现按钮（含取消）");
});

test("设置页只挂一个 rebind 入口", () => {
	assert.match(connections, /<RebindPanel hosts=\{hosts\}/);
	assert.equal(connections.match(/<RebindPanel /g)?.length, 1);
});

test("i18n 三种语言都有入口文案（zh-TW 为生成物）", () => {
	for (const file of ["zh-CN", "en-US", "zh-TW"]) {
		const copy = readFileSync(`src/renderer/src/i18n/rendererCopy.${file}.ts`, "utf8");
		assert.ok(copy.includes("settings.connections.rebind.title"), file + " missing rebind.title");
		assert.ok(copy.includes("settings.connections.rebind.confirm.noCancel"), file + " missing confirm.noCancel");
	}
});
