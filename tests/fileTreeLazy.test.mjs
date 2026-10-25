import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { findLoadedDirectory, findDirectoryNodeByRelativePath, mergeFileTreeChildren, hydrateExpandedFileTree, resolveAtDrillDirectory, shouldLoadFullTreeForAtSearch } = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

function dir(name, path, children) {
	return { name, path, relativePath: name, type: "directory", children, hasChildren: true };
}

function file(name, path) {
	return { name, path, relativePath: name, type: "file" };
}

test("findLoadedDirectory treats missing children as not loaded", () => {
	const tree = [dir("src", "/p/src")];
	assert.equal(findLoadedDirectory(tree, "/p/src"), undefined);
	const loaded = mergeFileTreeChildren(tree, "/p/src", []);
	assert.equal(findLoadedDirectory(loaded, "/p/src")?.name, "src");
});

test("mergeFileTreeChildren writes listing into the matching directory", () => {
	const tree = [dir("src", "/p/src"), file("README.md", "/p/README.md")];
	const next = mergeFileTreeChildren(tree, "/p/src", [file("App.tsx", "/p/src/App.tsx")]);
	assert.equal(next[0].children[0].name, "App.tsx");
	assert.equal(next[0].hasChildren, true);
	assert.equal(next[1].name, "README.md");
});

test("mergeFileTreeChildren leaves the tree unchanged when the directory is missing", () => {
	const tree = [file("README.md", "/p/README.md")];
	const next = mergeFileTreeChildren(tree, "/p/src", [file("App.tsx", "/p/src/App.tsx")]);
	assert.deepEqual(next, tree);
	// 同一引用是「内容没变」的判据（useFileTreeContentState 据此决定是否推进内容代次）：
	// 返回新数组会把迟到/落空的 listing 误判成内容变化，白跑一轮 Git 着色重拉。
	assert.equal(next, tree, "无变化时返回原数组引用");
});

test("hydrateExpandedFileTree loads shorter parent paths first", async () => {
	const listed = [];
	const tree = [dir("src", "/p/src")];
	const hydrated = await hydrateExpandedFileTree(
		async (directory) => {
			listed.push(directory);
			if (directory === "/p/src") return [dir("components", "/p/src/components")];
			if (directory === "/p/src/components") return [file("Button.tsx", "/p/src/components/Button.tsx")];
			return [];
		},
		tree,
		["/p/src/components", "/p/src"],
	);
	assert.deepEqual(listed, ["/p/src", "/p/src/components"]);
	assert.equal(hydrated[0].children[0].children[0].name, "Button.tsx");
});

test("hydrateExpandedFileTree 并发拉取但按父先子后合并（2027-02 性能治理）", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const resolveOrder = [];
	const tree = [dir("src", "/p/src")];
	const expanded = [];
	// 构造 12 个目录：/p/src 与 /p/src/d1..d11（全部以 /p/src 为父）
	for (let index = 1; index <= 11; index += 1) expanded.push(`/p/src/d${index}`);
	expanded.unshift("/p/src");
	const hydrated = await hydrateExpandedFileTree(
		async (directory) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setImmediate(resolve));
			resolveOrder.push(directory);
			inFlight -= 1;
			if (directory === "/p/src") return expanded.slice(1).map((path) => dir(path.slice("/p/src/".length), path));
			return [file("f.ts", `${directory}/f.ts`)];
		},
		tree,
		expanded,
	);
	assert.ok(maxInFlight > 1, `listing 必须并发（实际最大并发 ${maxInFlight}）`);
	assert.ok(maxInFlight <= 8, `并发不得超过上限 8（实际 ${maxInFlight}）`);
	// 合并仍父先子后：每个 dN 的子项都并进去了
	for (let index = 1; index <= 11; index += 1) {
		const parent = hydrated[0].children.find((node) => node.type === "directory" && node.path === `/p/src/d${index}`);
		assert.equal(parent?.children?.[0]?.name, "f.ts", `d${index} 的子项应已合并`);
	}
});

test("findDirectoryNodeByRelativePath finds unexpanded directory", () => {
	const tree = [dir("src", "/p/src"), file("README.md", "/p/README.md")];
	assert.equal(findDirectoryNodeByRelativePath(tree, "src")?.path, "/p/src");
	assert.equal(findDirectoryNodeByRelativePath(tree, "README.md"), undefined);
});

test("findDirectoryNodeByRelativePath finds nested loaded directory", () => {
	const tree = [
		{
			...dir("src", "/p/src"),
			children: [{ ...dir("components", "/p/src/components"), relativePath: "src/components" }],
		},
	];
	assert.equal(findDirectoryNodeByRelativePath(tree, "src/components")?.path, "/p/src/components");
});

test("findDirectoryNodeByRelativePath cannot see under unloaded directories", () => {
	// src 未展开（children 为 undefined），src/deep 不在树中
	const tree = [dir("src", "/p/src")];
	assert.equal(findDirectoryNodeByRelativePath(tree, "src/deep"), undefined);
});

test("findDirectoryNodeByRelativePath returns undefined for unknown path", () => {
	const tree = [dir("src", "/p/src")];
	assert.equal(findDirectoryNodeByRelativePath(tree, "nope"), undefined);
});

test("resolveAtDrillDirectory drills into last slash prefix directory", () => {
	const tree = [
		{ ...dir("src", "/p/src"), relativePath: "src" },
		{
			...dir("components", "/p/src/components", [{ ...file("Button.tsx", "/p/src/components/Button.tsx"), relativePath: "src/components/Button.tsx" }]),
			relativePath: "src/components",
			children: undefined,
		},
	];
	// @src/com → 取 src 目录下钻（src/components 未展开，先用已加载的 src）
	assert.equal(resolveAtDrillDirectory("src/com", tree)?.path, "/p/src");
	// @src/components/ → 目标本身就是目录，直接命中
	assert.equal(resolveAtDrillDirectory("src/components/", tree)?.path, "/p/src/components");
});

test("resolveAtDrillDirectory falls back along loaded-prefix chain on paste", () => {
	const tree = [dir("src", "/p/src"), dir("tests", "/p/tests")];
	// 整段粘贴 @src/components/Button.ts：先拉 src 一层，merge 后链条自动推进
	assert.equal(resolveAtDrillDirectory("src/components/Button.ts", tree)?.path, "/p/src");
});

test("resolveAtDrillDirectory advances past loaded segments", () => {
	const tree = [
		{
			...dir("src", "/p/src", [{ ...dir("deep", "/p/src/deep"), relativePath: "src/deep" }]),
			relativePath: "src",
		},
	];
	// src 已展开但 deep 未拉：链条停在 deep（下一级待加载目录）
	assert.equal(resolveAtDrillDirectory("src/deep/nope/I", tree)?.path, "/p/src/deep");
});

test("resolveAtDrillDirectory returns undefined when nothing to drill", () => {
	const tree = [dir("src", "/p/src")];
	assert.equal(resolveAtDrillDirectory("index", tree), undefined);
	assert.equal(resolveAtDrillDirectory("", tree), undefined);
});

test("shouldLoadFullTreeForAtSearch requires real search intent", () => {
	assert.equal(shouldLoadFullTreeForAtSearch("index"), true);
	assert.equal(shouldLoadFullTreeForAtSearch("in"), true);
	assert.equal(shouldLoadFullTreeForAtSearch("i"), false); // 太短，可能只是 @ 后随手一敲
	assert.equal(shouldLoadFullTreeForAtSearch(""), false);
	assert.equal(shouldLoadFullTreeForAtSearch("src/"), false); // 有 / ，走目录下钻
	assert.equal(shouldLoadFullTreeForAtSearch("src/com"), false);
	assert.equal(shouldLoadFullTreeForAtSearch("C:\\Users\\me\\a.ts"), false); // 盘符绝对路径
	assert.equal(shouldLoadFullTreeForAtSearch("C:/Users/me/a.ts"), false);
});
