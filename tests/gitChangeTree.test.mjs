/**
 * Git 变更列表树形展示（右抽屉）：
 * 1. 纯函数建模——扁平 GitResource[] 折成嵌套目录行，供 GitPanel / GitResourceTree 渲染；
 * 2. 紧凑链合并必须保留真实目录段（目录名含 `.` 时不能用展示名反推路径）；
 * 3. 折叠键与「收起/展开全部」的判定一致：折叠态命中的目录只输出目录行；
 * 4. 接线契约——三个变更分组都传 viewMode，模式持久化且默认平铺（升级后观感不变）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ROOT = process.cwd();
const load = (relativePath) => loadTsCommonJs(`${ROOT}/${relativePath}`);
const readSource = (relativePath) => readFileSync(`${ROOT}/${relativePath}`, "utf8");

const { GitStatus } = load("src/shared/types/git.ts");
const { buildChangeTreeRows, changeDirOf, collectChangeTreeDirPaths, collectUnstagedResources, toRelativeChangePath } = load("src/renderer/src/components/app/git/changeTree.ts");

/** 完整 GitResource 工厂：纯函数只读 path，仍构造形状完整的资源，避免半截对象混进断言 */
const file = (path, letter = "M") => ({ path, status: GitStatus.MODIFIED, letter });

/**
 * 行的紧凑快照，便于整体比对顺序、深度与路径。
 * 必须用 Array.from：vm 沙箱里 map 出来的数组原型与测试 realm 不同，deepStrictEqual 会判「同结构但非同一引用」。
 */
const shape = (rows) => Array.from(rows, (row) => (row.kind === "dir" ? `dir:${row.path}@${row.depth}=${row.resources.length}` : `file:${row.resource.path.replace(/\\/g, "/").split("/").pop()}@${row.depth}`));

test("toRelativeChangePath：分隔符归一、项目根裁剪、根外路径原样保留", () => {
	assert.equal(toRelativeChangePath("C:\\proj\\src\\a.ts", "C:\\proj"), "src/a.ts", "Windows 分隔符要归一成 POSIX 并裁掉项目根");
	assert.equal(toRelativeChangePath("/proj/src/a.ts", "/proj/"), "src/a.ts", "项目根尾部斜杠不能导致前缀匹配失败");
	assert.equal(toRelativeChangePath("/proj", "/proj"), "", "项目根自身裁成空串");
	assert.equal(toRelativeChangePath("/other/a.ts", "/proj"), "/other/a.ts", "根外路径保持原样，交给上层按段拆分");
	assert.equal(toRelativeChangePath("/proj/src/a.ts"), "/proj/src/a.ts", "无项目根时只做分隔符归一");

	assert.equal(changeDirOf("src/main/a.ts"), "src/main");
	assert.equal(changeDirOf("a.ts"), "", "根级文件的目录键是空串");
});

test("buildChangeTreeRows：目录行先于同级文件，深度逐级递增", () => {
	const rows = buildChangeTreeRows([file("C:\\proj\\src\\main\\a.ts"), file("C:\\proj\\src\\main\\b.ts"), file("C:\\proj\\README.md")], "C:\\proj");

	assert.deepEqual(shape(rows), ["dir:src/main@0=2", "file:a.ts@1", "file:b.ts@1", "file:README.md@0"], "目录优先 + 前序遍历：子目录文件排在根级文件之前");
	const firstFile = rows.find((row) => row.kind === "file");
	assert.equal(firstFile.resource.path, "C:\\proj\\src\\main\\a.ts", "文件行必须携带原始资源（后续 diff / 暂存按绝对路径定位，不能被树形相对路径覆盖）");
});

test("buildChangeTreeRows：单链目录合并成 a.b.c 一行，折叠键是链尾真实路径", () => {
	const rows = buildChangeTreeRows([file("/p/src/main/deep/a.ts")], "/p");
	const dir = rows.find((row) => row.kind === "dir");

	assert.equal(dir.label, "src.main.deep", "单子目录链用 `.` 连接成一行，避免把列表挤成竖条");
	assert.equal(dir.path, "src/main/deep", "折叠键是链尾真实路径（可用于后续文件操作）");
	assert.equal(dir.depth, 0, "合并后的链只占一个层级");
});

test("buildChangeTreeRows：目录名含点时不与同名嵌套目录混淆", () => {
	const resources = [file("/p/x.y/a.ts"), file("/p/x/y/b.ts")];
	const dirs = Array.from(buildChangeTreeRows(resources, "/p"), (row) => (row.kind === "dir" ? row : null)).filter(Boolean);

	assert.deepEqual(
		Array.from(dirs, (row) => row.label),
		["x.y", "x.y"],
		"两行展示名都可能落到 x.y",
	);
	// 目录名按 localeCompare 升序：`x` 在前，链合并后折叠键是 x/y；`x.y` 是另一个真实目录
	assert.deepEqual(
		Array.from(dirs, (row) => row.path),
		["x/y", "x.y"],
		"但折叠键必须区分真实目录与嵌套目录（不能用展示名反推路径）",
	);

	const collapsed = buildChangeTreeRows(resources, "/p", new Set(["x.y"]));
	assert.deepEqual(shape(collapsed), ["dir:x/y@0=1", "file:b.ts@1", "dir:x.y@0=1"], "折叠 x.y 不能连带折叠嵌套的 x/y");
});

test("buildChangeTreeRows：折叠目录只输出目录行，同级文件不受影响", () => {
	const resources = [file("/p/src/a.ts"), file("/p/src/b.ts"), file("/p/top.ts")];
	const rows = buildChangeTreeRows(resources, "/p", new Set(["src"]));

	assert.deepEqual(shape(rows), ["dir:src@0=2", "file:top.ts@0"], "折叠只剪子树，目录行与根级文件仍在");
	assert.equal(rows[0].resources.length, 2, "目录行始终携带整棵子树，折叠只影响渲染");
});

test("buildChangeTreeRows：目录行的 resources 覆盖整棵子树", () => {
	const rows = buildChangeTreeRows([file("/p/a/b/c1.ts"), file("/p/a/d1.ts"), file("/p/a/b/c2.ts")], "/p");
	const dir = rows.find((row) => row.kind === "dir" && row.path === "a");

	assert.deepEqual(Array.from(dir.resources, (resource) => resource.path.split("/").pop()).sort(), ["c1.ts", "c2.ts", "d1.ts"], "暂存目录 / 回滚目录 / 计数按整棵子树生效，不能只含直属文件");
});

test("collectChangeTreeDirPaths：与可折叠目录行一致，紧凑链中间层不算折叠键", () => {
	const resources = [file("/p/src/main/deep/a.ts"), file("/p/docs/readme.md")];
	const paths = collectChangeTreeDirPaths(resources, "/p");

	assert.deepEqual(Array.from(paths), ["docs", "src/main/deep"], "只收集真实渲染出来的目录行");
	assert.ok(!paths.includes("src") && !paths.includes("src/main"), "紧凑链中间层没有独立行，不能进入折叠键");

	const fileRows = Array.from(buildChangeTreeRows(resources, "/p", new Set(paths)), (row) => row.kind).filter((kind) => kind === "file");
	assert.deepEqual(fileRows, [], "「收起全部」后应只剩目录行——折叠键与渲染行不一致时这里会漏出文件行");
});

test("多仓路径：项目根外的绝对路径按自身段建树，各自归属自己的根目录", () => {
	const rows = buildChangeTreeRows([file("/repoA/src/a.ts"), file("/repoB/src/b.ts"), file("/repoA/readme.md")]);

	// 前导空段被丢弃；repoB 无直属文件且只有一个子目录，被紧凑链合并成 repoB/src，
	// 而 repoA 有直属文件（readme.md）所以不合并——同一列表里两种形态可以共存。
	assert.deepEqual(shape(rows), ["dir:repoA@0=2", "dir:repoA/src@1=1", "file:a.ts@2", "file:readme.md@1", "dir:repoB/src@0=1", "file:b.ts@1"], "两个根目录各自成树，文件不会挂到对方根下");
	assert.equal(rows.find((row) => row.kind === "dir" && row.label === "repoB.src").path, "repoB/src", "合并后的折叠键仍是链尾真实路径");
});

test("collectUnstagedResources：Changes 组只取工作区侧改动，已暂存资源不留在未暂存列表（issue #391）", () => {
	const stagedOnly = { path: "/p/only.ts", status: GitStatus.INDEX_MODIFIED, letter: "M" };
	const stagedThenEditedInIndex = { path: "/p/both.ts", status: GitStatus.INDEX_MODIFIED, letter: "M" };
	const stagedThenEditedInWorktree = { path: "/p/both.ts", status: GitStatus.MODIFIED, letter: "M" };
	const untracked = { path: "/p/new.ts", status: GitStatus.UNTRACKED, letter: "U" };
	// index 组对纯函数不是必需入参，显式传进来验证已有暂存资源不会混进返回值
	const groups = { merge: [], index: [stagedOnly, stagedThenEditedInIndex], workingTree: [stagedThenEditedInWorktree], untracked: [untracked] };

	assert.deepEqual(
		Array.from(collectUnstagedResources(groups), (resource) => `${resource.letter}:${resource.path}`),
		["M:/p/both.ts", "U:/p/new.ts"],
		"只暂存的文件彻底离开未暂存组（否则暂存后还会留一行，点它按 workingTree 组取 diff 会失败）；暂存后又改的文件保留工作区侧那一条",
	);
	assert.equal(collectUnstagedResources({ workingTree: [], untracked: [] }).length, 0, "无未暂存改动时返回空列表");
});

test("接线契约：三个变更分组都传 viewMode，模式持久化且默认平铺", () => {
	const panel = readSource("src/renderer/src/components/app/GitPanel.tsx");
	const tree = readSource("src/renderer/src/components/app/git/GitResourceTree.tsx");

	assert.equal((panel.match(/viewMode\s*=\s*\{changesViewMode\}/g) ?? []).length, 3, "merge / staged / working 三处都要透传视图模式");
	assert.match(panel, /useState<GitChangeViewMode>\s*\(\s*\(\s*\)\s*=>\s*readChangesViewMode\(\)\s*\)/, "视图模式要能从持久化偏好初始化");
	assert.match(panel, /localStorage\.getItem\(\s*GIT_CHANGES_VIEW_MODE_STORAGE_KEY\s*\)\s*===\s*"tree"\s*\?\s*"tree"\s*:\s*"flat"/, "非法值/无缓存回落平铺（默认与旧版一致，树形需主动开启）");
	assert.match(panel, /writeChangesViewMode\s*\(/, "切换后要写回偏好");
	// 两种视图的折叠键含义不同，切换时必须清空折叠态，否则会出现「看不见却被折叠」的行
	assert.match(panel, /toggleChangesViewMode[\s\S]{0,400}?setCollapsedChangeDirs\(new Set\(\)\)/, "切换视图要重置折叠态");
	assert.match(panel, /changesViewMode\s*===\s*"tree"\s*\?\s*collectChangeTreeDirPaths\(/, "树形的「收起/展开全部」按树形折叠键收集");
	assert.match(tree, /props\.viewMode\s*===\s*"tree"[\s\S]{0,200}?buildChangeTreeRows\(props\.resources,\s*props\.projectRoot,\s*props\.collapsedDirs\)/, "FileTree 在树形模式下用 buildChangeTreeRows 渲染");
});
