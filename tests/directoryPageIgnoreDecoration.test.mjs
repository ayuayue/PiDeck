import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { directoryPageNode, fileTreeIgnoredField } = loadTsCommonJs("src/renderer/src/utils/directoryPageNode.ts");
const rows = readFileSync("src/renderer/src/components/session/FileTreeRows.tsx", "utf8");
const read = (path) => readFileSync(path, "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

/**
 * T6 收尾：目录页的 Git ignore 修饰进入文件树。
 *
 * 钉三件事：
 * 1. 宿主把所有条目送进公共目录页，`ignored: true` 才落到节点上；
 * 2. 字段缺失 = 没判定（未知），不能伪造成 `false`；
 * 3. 文件行与目录行都必须消费这个修饰（只改一行等于半接线）。
 */
const entry = (overrides = {}) => ({
	target: { projectId: "p1", relativePath: "dist/index.js" },
	relativePath: "dist/index.js",
	type: "file",
	hasChildren: false,
	...overrides,
});

test("目录页条目 → 文件树节点：只转发确定的 ignored 修饰", () => {
	const decorated = directoryPageNode(entry({ ignored: true }));
	assert.equal(decorated.ignored, true);
	assert.equal(decorated.type, "file");
	assert.equal(decorated.relativePath, "dist/index.js");

	// 没判定（字段缺失）与 false 都不制造修饰：置灰只表达「git 说它被忽略」。
	for (const value of [undefined, false]) {
		const node = directoryPageNode(entry(value === undefined ? {} : { ignored: value }));
		assert.equal(Object.hasOwn(node, "ignored"), false, String(value));
	}
	// 目录条目同样带修饰。
	const directory = directoryPageNode(entry({ type: "directory", relativePath: "dist", hasChildren: "unknown" }));
	assert.equal(directory.type, "directory");
	assert.equal(Object.hasOwn(directory, "ignored"), false);
});

test("文件行与目录行都消费 ignored：修饰只影响样式，不改变行身份/过滤", () => {
	const consumers = rows.match(/node\.ignored === true/g) ?? [];
	assert.equal(consumers.length, 2, "FileRow 与 DirectoryRow 各一处，漏一行就是半接线");
	// 只加视觉修饰：不得据此过滤节点，也不得改变行键/目标身份。
	assert.doesNotMatch(rows, /ignored[^\n]*\.filter\(/);
	assert.match(rows, /<span className=\{cn\("file-node-name", gitStatusClass, node\.ignored === true && "opacity-60"\)\}>\{node\.name\}<\/span>/);
});

test("ignored 转发只有一处实现：本机树与远端树都调用 fileTreeIgnoredField", () => {
	assert.deepEqual(plain(fileTreeIgnoredField({ ignored: true })), { ignored: true });
	assert.deepEqual(plain(fileTreeIgnoredField({ ignored: false })), {}, "false 不制造修饰");
	assert.deepEqual(plain(fileTreeIgnoredField({})), {}, "没判定保持缺失");

	// 两棵树各自映射条目；任何一处漏调用，「ignored 行置灰」就半边生效（并行 e2e 抓到的缺口）。
	const localTree = read("src/renderer/src/utils/directoryPageNode.ts");
	const remoteTree = read("src/renderer/src/hooks/useRemoteFileTree.ts");
	assert.match(localTree, /\.\.\.fileTreeIgnoredField\(entry\)/, "本机树转发 ignored");
	assert.match(remoteTree, /\.\.\.fileTreeIgnoredField\(entry\)/, "远端树也必须转发 ignored");
	// 判定逻辑只在 fileTreeIgnoredField 里出现一次；两棵树都只做转发，不各写一份。
	assert.equal((localTree.match(/entry\.ignored === true/g) ?? []).length, 1, "ignored 判定只允许一处实现");
	assert.doesNotMatch(remoteTree, /entry\.ignored === true/, "远端树不得再手写第二份转发");
});
