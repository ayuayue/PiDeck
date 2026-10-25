import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 文件树排序纯函数（renderer utils）：维度切换 + 方向 + 目录优先 + 递归子节点
const { sortFileNodes, FILE_SORT_DEFAULT_DIRECTION } = loadTsCommonJs("src/renderer/src/utils/fileTreeSort.ts");

function node(name, overrides = {}) {
	return { name, path: `/${name}`, relativePath: name, type: "file", ...overrides };
}

test("name asc keeps directories first then localeCompare", () => {
	const nodes = [node("b.txt"), node("a-dir", { type: "directory", children: [] }), node("a.txt")];
	const sorted = sortFileNodes(nodes, "name", "asc");
	assert.deepEqual(
		sorted.map((n) => n.name),
		["a-dir", "a.txt", "b.txt"],
	);
});

test("name desc reverses name order within same type", () => {
	const nodes = [node("a.txt"), node("b.txt"), node("z-dir", { type: "directory", children: [] })];
	const sorted = sortFileNodes(nodes, "name", "desc");
	// 目录仍在前，目录/文件各自倒序
	assert.deepEqual(
		sorted.map((n) => n.name),
		["z-dir", "b.txt", "a.txt"],
	);
});

test("mtime desc orders newest first, asc orders oldest first", () => {
	const nodes = [node("old.txt", { mtimeMs: 100 }), node("new.txt", { mtimeMs: 300 }), node("mid.txt", { mtimeMs: 200 })];
	assert.deepEqual(
		sortFileNodes(nodes, "mtime", "desc").map((n) => n.name),
		["new.txt", "mid.txt", "old.txt"],
	);
	assert.deepEqual(
		sortFileNodes(nodes, "mtime", "asc").map((n) => n.name),
		["old.txt", "mid.txt", "new.txt"],
	);
});

test("ctime sort keeps dirs first, respects direction", () => {
	const nodes = [node("file-old", { ctimeMs: 100 }), node("dir-new", { type: "directory", ctimeMs: 900, children: [] }), node("file-new", { ctimeMs: 500 })];
	assert.deepEqual(
		sortFileNodes(nodes, "ctime", "desc").map((n) => n.name),
		["dir-new", "file-new", "file-old"],
	);
	assert.deepEqual(
		sortFileNodes(nodes, "ctime", "asc").map((n) => n.name),
		["dir-new", "file-old", "file-new"],
	);
});

test("size sort orders by bytes, dirs (size 0) stay first", () => {
	const nodes = [node("small.txt", { size: 5 }), node("big.txt", { size: 500 }), node("dir", { type: "directory", size: 0, children: [] })];
	assert.deepEqual(
		sortFileNodes(nodes, "size", "desc").map((n) => n.name),
		["dir", "big.txt", "small.txt"],
	);
	assert.deepEqual(
		sortFileNodes(nodes, "size", "asc").map((n) => n.name),
		["dir", "small.txt", "big.txt"],
	);
});

test("missing metadata falls back to name order within the same dimension", () => {
	const nodes = [node("b.txt"), node("a.txt")]; // 无 mtime
	assert.deepEqual(
		sortFileNodes(nodes, "mtime", "desc").map((n) => n.name),
		["a.txt", "b.txt"],
	);
});

test("default direction per dimension: name asc, time/size desc", () => {
	assert.equal(FILE_SORT_DEFAULT_DIRECTION.name, "asc");
	assert.equal(FILE_SORT_DEFAULT_DIRECTION.mtime, "desc");
	assert.equal(FILE_SORT_DEFAULT_DIRECTION.ctime, "desc");
	assert.equal(FILE_SORT_DEFAULT_DIRECTION.size, "desc");
});

test("sorting recurses into children without mutating the input tree", () => {
	const input = [
		node("root-dir", {
			type: "directory",
			children: [node("z.txt", { size: 1 }), node("a.txt", { size: 99 })],
		}),
	];
	const sorted = sortFileNodes(input, "size", "desc");
	assert.deepEqual(
		sorted[0].children.map((n) => n.name),
		["a.txt", "z.txt"],
	);
	assert.deepEqual(
		input[0].children.map((n) => n.name),
		["z.txt", "a.txt"],
	);
});
