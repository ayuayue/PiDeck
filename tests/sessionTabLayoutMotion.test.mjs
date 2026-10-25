import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * Tab 栏「关闭后收拢」的动画策略（P0-1）。
 *
 * 现状：关掉中间 Tab 后，右侧 Tab 直接瞬移到新位置，没有任何过渡。
 * 修法：给每个 Tab 套一层 motion.div 播 layout 位移，但只有在 **Tab 集合** 真的变化时
 * 才重新测量（resolveTabLayoutGeneration 的生成数 + layoutDependency）。
 *
 * 为什么重排不计入：拖拽重排时走原生 HTML5 drag，自带插入指示线；若同时播 layout 位移，
 * 行会跟着指针回弹。为什么重渲也不计入：状态徽章/标题每帧都可能变，无谓测量会拖慢整条 Tab 栏。
 */
const { resolveTabLayoutGeneration } = loadTsCommonJs("src/renderer/src/utils/sessionTabMotion.ts");

test("首帧不触发测量（挂载时不播位移）", () => {
	assert.equal(resolveTabLayoutGeneration(null, ["a", "b"], 0), 0);
});

test("同一集合重渲不触发测量", () => {
	assert.equal(resolveTabLayoutGeneration(["a", "b"], ["a", "b"], 7), 7);
});

test("关闭中间 Tab 时生成数 +1，右侧 Tab 才播收拢", () => {
	assert.equal(resolveTabLayoutGeneration(["a", "b", "c"], ["a", "c"], 0), 1);
});

test("新开 Tab 同样 +1（后续 Tab 让位）", () => {
	assert.equal(resolveTabLayoutGeneration(["a"], ["a", "b"], 0), 1);
});

test("纯重排（集合不变）不 +1：拖拽时不能让行跟着指针回弹", () => {
	assert.equal(resolveTabLayoutGeneration(["a", "b", "c"], ["c", "b", "a"], 3), 3);
});

test("关掉再开回同一个 id 是两次结构变化", () => {
	assert.equal(resolveTabLayoutGeneration(["a", "b"], ["b"], 0), 1);
	assert.equal(resolveTabLayoutGeneration(["b"], ["a", "b"], 1), 2);
});

test("接线：Tab 用 motion 包装层按生成数播位移，reduced-motion 下归零", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	assert.match(source, /import \{\s*motion,\s*useReducedMotion\s*\} from "motion\/react"/, "必须用仓库既有的 motion 库");
	assert.match(source, /from "\.\.\/\.\.\/lib\/ease"/, "运动常量统一从 @/lib/ease 取");
	assert.match(source, /resolveTabLayoutGeneration/, "生成数必须来自可单测的纯函数");
	// 包装层：key 在 motion.div 上，SessionTab 自己不再持 key（否则退出/重排会错位）
	assert.match(source, /<motion\.div\s+key=\{sessionId\}\s+layout="position"\s+layoutDependency=\{tabLayoutGeneration\}/, "Tab 必须包在 layout 动画层里并按生成数测量");
	assert.match(source, /duration: reduceMotion \? 0 : 0\.16/, "reduced-motion 下位移时长归零");
});

test("接线：待渲染顺序复用 flattenSessionTabBarEntries，不另写展开逻辑", () => {
	const source = readFileSync("src/renderer/src/components/session/SessionTabsBar.tsx", "utf8");
	assert.match(source, /flattenSessionTabBarEntries\(tabBarEntries\)/, "顺序必须与 Ctrl+Tab 循环同源（issue #346）");
});
