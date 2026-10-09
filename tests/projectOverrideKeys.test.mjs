import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 项目作用域「继承全局资源是否已在本项目停用」的渲染层判定：
// 原生规则的键保留原始大小写（pi 在 Linux 上按大小写匹配路径），而 Windows 的盘符/家目录常带大写，
// 精确匹配会漏判 → 开关写对了却显示成未停用（看起来像开关弹回）。
const { buildProjectOverrideKeyIndex, matchesProjectOverride } = loadTsCommonJs("src/renderer/src/config/projectOverrideKeys.ts");

test("精确命中与大小写兜底命中都判停用，其余不判", () => {
	const index = buildProjectOverrideKeyIndex(["C:\\Users\\Me\\.pi\\agent\\skills\\a\\SKILL.md"]);
	assert.equal(matchesProjectOverride(index, "C:\\Users\\Me\\.pi\\agent\\skills\\a\\SKILL.md"), true);
	assert.equal(matchesProjectOverride(index, "c:\\users\\me\\.pi\\agent\\skills\\a\\skill.md"), true);
	assert.equal(matchesProjectOverride(index, "/home/u/.pi/agent/skills/b/SKILL.md"), false);
});

test("空列表/空串/空白/非字符串一律跳过，缺键不判停用", () => {
	const empty = buildProjectOverrideKeyIndex(undefined);
	assert.equal(empty.exact.size, 0);
	assert.equal(matchesProjectOverride(empty, "x"), false);
	assert.equal(matchesProjectOverride(empty, undefined), false);

	// IPC 数据不可信：非字符串与空白项不能进索引（否则会匹配到空键）
	const mixed = buildProjectOverrideKeyIndex(["", "   ", "  /home/u/a.md  ", null, 42]);
	assert.equal(mixed.exact.size, 1);
	assert.equal(matchesProjectOverride(mixed, "/home/u/a.md"), true);
	assert.equal(matchesProjectOverride(mixed, "  /home/u/a.md  "), true);
});

test("大小写兜底不改变精确语义：键值仅大小写不同视为同一项", () => {
	const index = buildProjectOverrideKeyIndex(["/home/u/A.md"]);
	assert.equal(index.exact.size, 1);
	assert.equal(matchesProjectOverride(index, "/home/u/a.md"), true);
	assert.equal(matchesProjectOverride(index, "/home/u/a.md.bak"), false);
});
