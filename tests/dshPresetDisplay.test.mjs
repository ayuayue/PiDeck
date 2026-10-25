import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { builtinPresetKeys, presetDisplayDescription, presetDisplayName } = loadTsCommonJs("src/renderer/src/config/dshPresetDisplay.ts");

/** 桩 t：直接回显 key，验证路由到 i18n 而非文件元数据。 */
const t = (key) => `[${key}]`;

test("builtinPresetKeys: 4 个官方预设的稳定 ID 返回 i18n key", () => {
	const standard = builtinPresetKeys({ id: "standard", trust: "system" });
	assert.equal(standard?.name, "config.dsh.presetStandardName");
	assert.equal(standard?.description, "config.dsh.presetStandardDesc");

	const code = builtinPresetKeys({ id: "ptc" });
	assert.equal(code?.name, "config.dsh.presetPtcName");
	assert.equal(code?.description, "config.dsh.presetPtcDesc");

	const minimal = builtinPresetKeys({ id: "minimal", trust: "system" });
	assert.equal(minimal?.name, "config.dsh.presetMinimalName");
	assert.equal(minimal?.description, "config.dsh.presetMinimalDesc");

	const cordis = builtinPresetKeys({ id: "cordis", trust: "system" });
	assert.equal(cordis?.name, "config.dsh.presetCordisName");
	assert.equal(cordis?.description, "config.dsh.presetCordisDesc");
});

test("builtinPresetKeys: 不把旧 code 或自定义 ID 当作官方 ptc", () => {
	assert.equal(builtinPresetKeys({ id: "code" }), undefined);
	assert.equal(builtinPresetKeys({ id: "custom" }), undefined);
});

test("builtinPresetKeys: 未知 system id 回退文件元数据", () => {
	assert.equal(builtinPresetKeys({ id: "my-custom", trust: "system" }), undefined);
});

test("presetDisplayName/Description: 内置走 i18n，其余用元数据（缺省回退 id）", () => {
	const standard = { id: "standard", trust: "system" };
	assert.equal(presetDisplayName(standard, t), "[config.dsh.presetStandardName]");
	assert.equal(presetDisplayDescription(standard, t), "[config.dsh.presetStandardDesc]");

	const custom = { id: "my-agent", trust: "user", name: "我的预设", description: "本地创作" };
	assert.equal(presetDisplayName(custom, t), "我的预设");
	assert.equal(presetDisplayDescription(custom, t), "本地创作");

	const bare = { id: "my-agent", trust: "user" };
	assert.equal(presetDisplayName(bare, t), "my-agent");
	assert.equal(presetDisplayDescription(bare, t), undefined);
});
