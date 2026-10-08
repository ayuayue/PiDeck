/**
 * ACP 工具预设契约测试:
 * - 预设结构完整(id 唯一/命令参数非空/首页 https);
 * - 渲染层三语 i18n 文件均含每个预设的描述 key(源码扫描契约,空白容忍正则,改格式不碎);
 * - 预设命令与共享表导出的 id 联合一致(防止加预设漏 id 类型)。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const repoRoot = process.cwd();
const { ACP_TOOL_PRESETS } = loadTsCommonJs("src/shared/acpToolPresets.ts");

const COPY_FILES = ["rendererCopy.zh-CN.ts", "rendererCopy.en-US.ts", "rendererCopy.zh-TW.ts"];

test("预设:id 唯一、命令/参数非空、homepage 为 https", () => {
	assert.ok(ACP_TOOL_PRESETS.length >= 6, "常用预设至少覆盖 6 个 CLI");
	const ids = new Set();
	for (const preset of ACP_TOOL_PRESETS) {
		assert.match(preset.id, /^[\w-]+$/, `id 形态: ${preset.id}`);
		assert.ok(!ids.has(preset.id), `id 重复: ${preset.id}`);
		ids.add(preset.id);
		assert.ok(preset.name.trim().length > 0, "name 非空");
		assert.ok(preset.command.trim().length > 0, `command 非空: ${preset.id}`);
		for (const arg of preset.args) assert.ok(typeof arg === "string" && arg.length > 0, `args 无空串: ${preset.id}`);
		assert.match(preset.homepage, /^https:\/\//, `homepage https: ${preset.id}`);
	}
});

test("预设:npx 形态走 -y 免交互(卡在 npx 交互提示会握不上手)", () => {
	for (const preset of ACP_TOOL_PRESETS) {
		if (preset.command === "npx") {
			assert.ok(preset.args.includes("-y") || preset.args.includes("--yes"), `npx 预设须免交互: ${preset.id}`);
		}
	}
});

test("i18n:三语文件均含每个预设描述 key 与预设区文案 key(空白容忍)", () => {
	const requiredKeys = [...ACP_TOOL_PRESETS.map((preset) => `acp.presetDesc.${preset.id}`), "acp.presetsTitle", "acp.presetsHint", "acp.presetHome", "acp.presetAlreadyAdded"];
	for (const file of COPY_FILES) {
		const source = readFileSync(join(repoRoot, "src", "renderer", "src", "i18n", file), "utf8");
		for (const key of requiredKeys) {
			const pattern = new RegExp(`["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']\\s*:`);
			assert.ok(pattern.test(source), `${file} 缺 key: ${key}`);
		}
	}
});

test("UI:AcpToolsTab 引用共享预设表(加预设无需改 UI)", () => {
	const source = readFileSync(join(repoRoot, "src", "renderer", "src", "components", "app", "settings", "AcpToolsTab.tsx"), "utf8");
	assert.match(source, /ACP_TOOL_PRESETS/, "AcpToolsTab 应遍历共享预设表");
	// 预设描述 key 静态映射:每个预设 id 一条(带连字符的 id 加引号),防止模板字符串拼 key 破坏 t() 的字面量联合
	for (const preset of ACP_TOOL_PRESETS) {
		assert.match(source, new RegExp(`["']?${preset.id}["']?\\s*:\\s*"acp\\.presetDesc\\.${preset.id}"`), `PRESET_DESC_KEYS 缺 ${preset.id}`);
	}
});
