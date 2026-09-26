import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { findLoadedDirectory, findDirectoryNodeByRelativePath, fileTreeNodeKey, findDirectoryNodeByPath, mergeFileTreeChildren, hydrateExpandedFileTree, resolveAtDrillDirectory, shouldLoadFullTreeForAtSearch } = loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

function dir(name, path, children) {
	return { name, path, relativePath: name, type: "directory", children, hasChildren: true };
}

function file(name, path) {
	return { name, path, relativePath: name, type: "file" };
}

test("hydrateExpandedFileTree prefers the directory target returned by files:list", async () => {
	const tree = [{ ...dir("src", "/p/src"), relativePath: "src", target: { projectId: "project-1", relativePath: "src" } }];
	let requested;
	const hydrated = await hydrateExpandedFileTree(
		async (target) => {
			requested = target;
			return [file("main.ts", "/p/src/main.ts")];
		},
		tree,
		["/p/src"],
	);
	assert.equal(requested.projectId, "project-1");
	assert.equal(requested.relativePath, "src");
	assert.equal(hydrated[0].children[0].name, "main.ts");
});

test("path-free file nodes hydrate by project target without inventing a local path", async () => {
	const tree = [{ name: "src", relativePath: "src", target: { projectId: "project-1", relativePath: "src" }, type: "directory", hasChildren: true }];
	assert.equal("path" in tree[0], false);
	const directoryKey = fileTreeNodeKey(tree[0]);
	assert.equal(directoryKey, "project:project-1\u0000src");
	assert.equal(findDirectoryNodeByPath(tree, directoryKey), tree[0]);
	let requested;
	const hydrated = await hydrateExpandedFileTree(
		async (target) => {
			requested = target;
			return [{ name: "main.ts", relativePath: "src/main.ts", target: { projectId: "project-1", relativePath: "src/main.ts" }, type: "file" }];
		},
		tree,
		[directoryKey],
	);
	assert.deepEqual(requested, { projectId: "project-1", relativePath: "src" });
	assert.equal("path" in hydrated[0], false);
	assert.equal(hydrated[0].children[0].target.relativePath, "src/main.ts");
});

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
