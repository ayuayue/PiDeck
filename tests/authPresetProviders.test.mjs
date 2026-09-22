import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 认证页「新增认证」预设列表的契约。
 *
 * 为什么要有：预设是纯数据表，漏项/重复项都不会在运行时报错——漏了用户在网格里
 * 找不到 provider（只能手输名字），重复 value 会让 React key 撞车、点选行为混乱。
 * 这里锁定 0.86/0.86.1 新增的 provider（radius / meta）与全表 value 唯一。
 *
 * 扫描使用空白容忍正则：预设条目允许被格式化成多行（AGENTS.md 的格式化约束）。
 */
const authTab = readFileSync("src/renderer/src/config/AuthTab.tsx", "utf8");

function presetListSource() {
	const match = /const PRESET_PROVIDERS\s*=\s*\[([\s\S]*?)\n\];/.exec(authTab);
	assert.ok(match, "AuthTab 必须保留 PRESET_PROVIDERS 数据表");
	return match[1];
}

/** 取某个 value 的预设条目原文（条目内没有嵌套大括号）。 */
function presetBlock(value) {
	const match = new RegExp(`\\{[^{}]*value:\\s*"${value}"[^{}]*\\}`).exec(presetListSource());
	assert.ok(match, `预设列表缺少 ${value}`);
	return match[0];
}

test("预设列表覆盖 pi 0.86/0.86.1 新增 provider（radius / meta）", () => {
	const meta = presetBlock("meta");
	assert.match(meta, /env:\s*"META_API_KEY"/, "Meta 走 META_API_KEY（订阅也可用 pi 的 /login meta）");
	assert.match(meta, /url:\s*"https:\/\/pi\.dev\/docs\/latest\/providers#meta-muse-subscription"/, "Meta 需要指向 pi 文档的订阅章节");

	// Radius 只有 OAuth（在 pi 终端执行 /login radius）：env 列不写具体环境变量名，
	// 用 oauth 说明，文档链接必须指向 pi 的 Radius 章节。
	const radius = presetBlock("radius");
	assert.match(radius, /env:\s*"oauth"/, "Radius 没有 API key 环境变量，env 列标 oauth");
	assert.match(radius, /url:\s*"https:\/\/pi\.dev\/docs\/latest\/providers#radius"/, "Radius 需要指向 pi 文档的 Radius 章节");
});

test("预设列表 value 唯一（重复会让网格 key 撞车）", () => {
	const values = [...presetListSource().matchAll(/value:\s*"([^"]+)"/g)].map((match) => match[1]);
	assert.ok(values.length > 20, `预设数量异常：${values.length}`);
	assert.equal(new Set(values).size, values.length, `预设 value 重复：${values.filter((value, index) => values.indexOf(value) !== index).join(", ")}`);
});
