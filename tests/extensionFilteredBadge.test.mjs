/**
 * 「过滤式安装」徽标的显示门控（用户反馈：只是关了扩展开关，却被标成过滤式安装）。
 *
 * pi list 把任何对象形态的 packages 条目都标成 (filtered)，而 PiDeck 的整包停用写的
 * 四类空数组也是对象。徽标必须在停用行隐藏；重新启用后条目会被折回纯字符串
 * （piResourceRules.collapsePackageEntry），徽标只在「真的还有过滤」时出现。
 *
 * 纯 UI 展示规则没有渲染级测试设施，按仓库惯例用源码契约锁住（空白容忍）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const rows = readFileSync("src/renderer/src/config/extensionsTableRows.tsx", "utf8");

test("过滤式安装徽标只在行处于生效启用状态时显示", () => {
	assert.match(rows, /\{extension\.filtered\s*&&\s*effectiveEnabled\s*&&\s*<span[\s\S]{0,160}?config\.extensionFiltered/, "徽标渲染必须同时要求 extension.filtered 与 effectiveEnabled");
	assert.doesNotMatch(rows, /\{extension\.filtered\s*&&\s*<span/, "不允许退回「只要 filtered 就显示」的旧写法");
});
