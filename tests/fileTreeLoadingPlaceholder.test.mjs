/**
 * 文件树「加载中...」占位卡死修复测试。
 *
 * 背景：展开目录的 children 拉取失败（目录被删/权限/超上限）或被代次丢弃时，
 * 节点保持「无 children 且 hasChildren=true」，FileNode 的占位分支
 * （expanded && hasChildren !== false && !node.children）永久成立，
 * 「加载中...」文本叠在文件名区域不消失。
 *
 * 修复三件套：
 * 1. markFileTreeLoadFailed：失败目录 hasChildren 置 false，占位立刻消失；
 * 2. toggleDirectory / drillCompactChain 失败路径调用打标（静态接线断言）；
 * 3. restoreExpandedDirs：打开抽屉时对「已展开 + 无 children + 未标失败」目录
 *    按需补拉（父目录先补），无待修复目录时返回 false。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { markFileTreeLoadFailed, mergeFileTreeChildren } = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

function dir(name, path, children, hasChildren = true) {
	return { name, path, relativePath: name, type: "directory", children, hasChildren };
}

function file(name, path) {
	return { name, path, relativePath: name, type: "file" };
}

test("markFileTreeLoadFailed 在顶层目录打标且不触碰 children", () => {
	const tree = [dir("src", "/p/src")];
	const next = markFileTreeLoadFailed(tree, "/p/src");
	assert.equal(next[0].hasChildren, false);
	// children 保持 undefined（未加载），占位分支因此不再成立。
	assert.equal(next[0].children, undefined);
	// 原树不被修改（纯函数）。
	assert.equal(tree[0].hasChildren, true);
});

test("markFileTreeLoadFailed 递归命中嵌套目录", () => {
	const tree = [dir("src", "/p/src", [dir("deep", "/p/src/deep")])];
	const next = markFileTreeLoadFailed(tree, "/p/src/deep");
	assert.equal(next[0].children[0].hasChildren, false);
	// 父层不受影响。
	assert.equal(next[0].hasChildren, true);
});

test("markFileTreeLoadFailed 目录不存在时节点引用原样保留", () => {
	const tree = [dir("src", "/p/src", [file("a.ts", "/p/src/a.ts")])];
	const next = markFileTreeLoadFailed(tree, "/p/other");
	// map 重建数组但未命中节点复用引用（避免无谓重建，与 compactMiddlePackages 同约定）。
	assert.equal(next[0], tree[0]);
	assert.equal(next.length, 1);
});

test("打标后重新 merge 成功结果可恢复（重试入口语义）", () => {
	let tree = [dir("src", "/p/src")];
	// 第一次展开失败 → 打标
	tree = markFileTreeLoadFailed(tree, "/p/src");
	assert.equal(tree[0].hasChildren, false);
	// 用户重试成功 → children 写入且 hasChildren 恢复为真实值
	tree = mergeFileTreeChildren(tree, "/p/src", [file("a.ts", "/p/src/a.ts")]);
	assert.equal(tree[0].hasChildren, true);
	assert.equal(tree[0].children.length, 1);
});

test("接线：toggleDirectory / drillCompactChain 失败路径调用 markFileTreeLoadFailed", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	// toggleDirectory 的 catch：打标 + 保留代次校验（切项目后不得写入）。
	const toggleCatch = app.match(/\.catch\(\(error\) => \{[\s\S]{0,400}?markFileTreeLoadFailed\(tree, path\)[\s\S]{0,200}?\}\);/);
	assert.ok(toggleCatch, "toggleDirectory expand failure should mark the directory");
	assert.match(toggleCatch[0], /activeProjectIdRef\.current !== projectId/);
	// drillCompactChain 的 catch：打标当前层而不是静默 break。
	const drillCatch = app.match(/} catch \{\s*\n[\s\S]{0,300}?markFileTreeLoadFailed\(tree, current\)\);\s*\n\s*break;/);
	assert.ok(drillCatch, "drillCompactChain failure should mark the current layer");
});

test("接线：restoreExpandedDirs 只补拉「已展开 + 无 children + 未标失败」目录", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	// 注意：biome 格式基线（tabs + 折行）会把签名与依赖数组拆行，正则必须容忍空白/换行，
	// 不能写死「两空格缩进 + 单行签名」，否则格式化一动测试就假失败。
	const fn = app.match(/const restoreExpandedDirs = useCallback\(\s*async \(projectId: string\): Promise<boolean> => \{[\s\S]*?\},\s*\[beginFileTreeRequest, isFileTreeRequestCurrent\],?\s*\);/);
	assert.ok(fn, "restoreExpandedDirs should exist with generation guards");
	const body = fn[0];
	// 判定条件与 FileNode 占位分支同构：expanded && !children && hasChildren !== false。
	assert.match(body, /const nodeKey = fileTreeNodeKey\(node\)/);
	assert.match(body, /expandedDirsRef\.current\.has\(nodeKey\)/);
	assert.match(body, /!Array\.isArray\(node\.children\)/);
	assert.match(body, /node\.hasChildren !== false/);
	// 父目录先补（merge 依赖父层节点先存在）。
	assert.match(body, /sort\(\(left, right\) => left\.path\.length - right\.path\.length\)/);
	// 补拉过程带代次校验，切项目后不得写入。
	assert.match(body, /isFileTreeRequestCurrent\(generation, projectId\)/);
	// 失败打标：补拉本身失败也不能留下永久占位。
	assert.match(body, /markFileTreeLoadFailed\(tree, directory\)/);
});

test("接线：打开文件抽屉先自愈，无待修复目录才静默 refreshFiles", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const block = app.match(/void restoreExpandedDirs\(activeProjectId\)\.then\(\(repaired\) => \{[\s\S]{0,200}?\}\);/);
	assert.ok(block, "drawer-open path should run restoreExpandedDirs");
	assert.match(block[0], /if \(!repaired\) void refreshVisibleFiles\(activeProjectId, true\)/);
});

test("接线：FileNode 占位独立成行并带 spinner，失败档不显示占位", () => {
	const surface = readFileSync("src/renderer/src/components/session/WorkspaceSurface.tsx", "utf8");
	// 占位分支条件不变（hasChildren !== false 挡住失败档）。
	assert.match(surface, /expanded && node\.hasChildren !== false && !node\.children/);
	// 占位使用 spinner + 独立 flex 行，不再依赖外层文本容器（旧实现是纯文本 div）。
	const placeholder = surface.match(/\{expanded && node\.hasChildren !== false && !node\.children && \(\s*<div className="file-children[^"]*">[\s\S]{0,400}?\)\}/);
	assert.ok(placeholder, "placeholder block should exist");
	assert.match(placeholder[0], /animate-pideck-spin/);
	assert.match(placeholder[0], /t\("drawer\.lazyLoading"\)/);
	// chevron 改按 expanded 显式旋转（受控 Collapsible 的 data-state 时序不可靠）。
	assert.match(surface, /expanded \? "rotate-90" : "rotate-0"/);
});
