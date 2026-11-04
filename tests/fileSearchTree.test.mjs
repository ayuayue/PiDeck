import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 文件名搜索结果从平铺改成树：命中路径的前缀目录由 buildFileSearchTree 补出来。
// 平铺时长路径挤在同一列，看不出命中集中在哪个目录（用户反馈的诉求来源）。
const { buildFileSearchTree, countSearchTreeFiles, normalizeSearchRelativePath } = loadTsCommonJs("src/renderer/src/utils/fileSearchTree.ts");

const file = (relativePath, type = "file") => ({ name: relativePath.split("/").at(-1), relativePath, type });

test("nested hits become nested directory rows", () => {
	const tree = buildFileSearchTree([file("src/a.ts"), file("src/nested/b.ts"), file("README.md")]);
	// 目录在前、文件在后；根层是 src 与 README.md
	assert.equal(tree.map((entry) => (entry.type === "directory" ? `dir:${entry.key}` : `file:${entry.item.relativePath}`)).join("|"), "dir:src|file:README.md");
	const src = tree[0];
	assert.equal(src.name, "src");
	assert.equal(src.item, undefined); // 纯前缀目录，不是命中项
	assert.equal(src.children.map((entry) => (entry.type === "directory" ? `dir:${entry.key}` : `file:${entry.item.relativePath}`)).join("|"), "dir:src/nested|file:src/a.ts");
	assert.equal(src.children[0].children[0].item.relativePath, "src/nested/b.ts");
});

test("sibling files share one directory row", () => {
	const tree = buildFileSearchTree([file("src/a.ts"), file("src/b.ts")]);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].children.length, 2);
	assert.equal(tree[0].children.map((child) => child.item.name).join("|"), "a.ts|b.ts");
});

test("a directory hit merges into the prefix row instead of duplicating it", () => {
	const tree = buildFileSearchTree([file("src", "directory"), file("src/a.ts")]);
	assert.equal(tree.length, 1);
	assert.equal(tree[0].key, "src");
	// 目录自身命中：item 挂在同一行上，点击仍可右键「在文件夹中显示」
	assert.equal(tree[0].item?.relativePath, "src");
	assert.equal(tree[0].children.length, 1);
});

test("directories sort before files and names sort alphabetically", () => {
	const tree = buildFileSearchTree([file("zzz.ts"), file("aaa.ts"), file("middle/b.ts"), file("alpha/c.ts")]);
	assert.equal(tree.map((entry) => (entry.type === "directory" ? entry.name : entry.item.name)).join("|"), "alpha|middle|aaa.ts|zzz.ts");
});

test("backslashes and leading/trailing slashes are normalized", () => {
	assert.equal(normalizeSearchRelativePath("\\src\\a.ts"), "src/a.ts");
	assert.equal(normalizeSearchRelativePath("/src/a.ts/"), "src/a.ts");
	const tree = buildFileSearchTree([{ name: "a.ts", relativePath: "\\src\\deep\\a.ts", type: "file" }]);
	assert.equal(tree[0].key, "src");
	assert.equal(tree[0].children[0].key, "src/deep");
});

test("countSearchTreeFiles counts hits at every depth", () => {
	const tree = buildFileSearchTree([file("src/a.ts"), file("src/deep/b.ts"), file("src/deep/deeper/c.ts")]);
	assert.equal(countSearchTreeFiles(tree), 3);
	assert.equal(countSearchTreeFiles(tree[0].children), 3);
});

test("file search panel renders the tree instead of a flat row list", () => {
	const src = readFileSync("src/renderer/src/components/session/FileSearchResults.tsx", "utf8");
	assert.match(src, /buildFileSearchTree\(results\)/);
	assert.match(src, /<SearchTreeRow/);
	// 平铺实现在抽屉里已被树取代；回退成 rows.map 就是这次修复被撤销
	assert.doesNotMatch(src, /rows\.map\(/);
});
