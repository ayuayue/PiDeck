import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 模板参数解析与占位替换（逐条对齐 pi 的 `parseCommandArgs` / `substituteArgs`）。
 * 这是「模板作者写的 `$1`/`$@` 在两个展开端产出同样正文」的前提。
 */

const { parseCommandArgs, substituteArgs, hasArgPlaceholders } = loadTsCommonJs("src/renderer/src/utils/templateArgs.ts");

test("切词：空白分隔，双引号内的空格不切", () => {
	assert.deepEqual(plain(parseCommandArgs("重构 高优先")), ["重构", "高优先"]);
	assert.deepEqual(plain(parseCommandArgs('"重构 大模块" 高优先')), ["重构 大模块", "高优先"]);
	assert.deepEqual(plain(parseCommandArgs("  a   b  ")), ["a", "b"]);
});

test("切词：单引号同样生效；引号空串算一个空参数", () => {
	assert.deepEqual(plain(parseCommandArgs("'a b' c")), ["a b", "c"]);
	assert.deepEqual(plain(parseCommandArgs('"" x')), ["", "x"]);
});

test("替换：$@ / $ARGUMENTS 展开为全部参数", () => {
	assert.equal(substituteArgs("Focus:\n\n$@\n", ["重构", "高优先"]), "Focus:\n\n重构 高优先\n");
	assert.equal(substituteArgs("[$ARGUMENTS]", ["a", "b"]), "[a b]");
});

test("替换：$1 / $2 按位置取，越界为空串", () => {
	assert.equal(substituteArgs("Level: $1 / $2", ["重构"]), "Level: 重构 / ");
	assert.equal(substituteArgs("$9", []), "");
});

test("替换：${N:-默认} 与 ${@:-默认} 在缺失/为空时用默认值", () => {
	assert.equal(substituteArgs("Level: ${1:-常规}", []), "Level: 常规");
	assert.equal(substituteArgs("Level: ${1:-常规}", ["高"]), "Level: 高");
	assert.equal(substituteArgs("Focus: ${@:-全部}", []), "Focus: 全部");
});

test("替换：${@:N} 与 ${@:N:L} 切片（bash 习惯从 1 开始）", () => {
	assert.equal(substituteArgs("$ ${@:2}", ["a", "b", "c"]), "$ b c");
	assert.equal(substituteArgs("$ ${@:2:2}", ["a", "b", "c"]), "$ b c");
	assert.equal(substituteArgs("$ ${@:1:1}", ["a", "b"]), "$ a");
});

test("替换：参数内容里的 $1 / $@ 不会被二次展开（pi 明确保证）", () => {
	assert.equal(substituteArgs("$1", ["$2"]), "$2");
});

test("替换：不匹配的 $ 保持原样（$HOME / ${HOME}）", () => {
	assert.equal(substituteArgs("echo $HOME ${HOME}", ["x"]), "echo $HOME ${HOME}");
});

test("占位探测：与替换行为一致", () => {
	assert.equal(hasArgPlaceholders("$@"), true);
	assert.equal(hasArgPlaceholders("$1"), true);
	assert.equal(hasArgPlaceholders("${1:-默认}"), true);
	assert.equal(hasArgPlaceholders("只是正文"), false);
	assert.equal(hasArgPlaceholders("价格 $HOME"), false);
});

const plain = (value) => JSON.parse(JSON.stringify(value));
