import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { findLoadedDirectory, findDirectoryNodeByRelativePath, fileTreeNodeKey, projectFileKey, findDirectoryNodeByPath, mergeFileTreeChildren, hydrateExpandedFileTree, markFileTreeLoadFailed, resolveAtDrillDirectory, shouldSearchFileNames, loadAtFileNameSearch, mergeAtFileNameSearchFiles } =
	loadTsCommonJs("src/renderer/src/utils/fileTreeLazy.ts");

/**
 * 夹具说明（W1 之后）：树里的键是**项目作用域身份**，不再等于本机绝对路径。
 * `path` 仍然存在（本机节点有绝对路径），但它不再是键——这正是本轮要去掉的「双重语义」。
 * 所以下面的用例统一用 `k(node)` / `projectFileKey(...)` 取键，而不是拿 `/p/src` 当键。
 */
const PROJECT = "p1";
const relOf = (path) => path.replace(/^\/p\//, "");
const targetOf = (path) => ({ projectId: PROJECT, relativePath: relOf(path) });
const k = (node) => fileTreeNodeKey(node);

function dir(name, path, children) {
	return { name, path, relativePath: relOf(path), target: targetOf(path), type: "directory", children, hasChildren: true };
}

function file(name, path) {
	return { name, path, relativePath: relOf(path), target: targetOf(path), type: "file" };
}

test("hydrateExpandedFileTree prefers the directory target returned by files:list", async () => {
	const tree = [dir("src", "/p/src")];
	let requested;
	const hydrated = await hydrateExpandedFileTree(
		async (target) => {
			requested = target;
			return [file("main.ts", "/p/src/main.ts")];
		},
		tree,
		[k(tree[0])],
	);
	assert.equal(requested.projectId, PROJECT);
	assert.equal(requested.relativePath, "src");
	assert.equal(hydrated[0].children[0].name, "main.ts");
});

test("path-free file nodes hydrate by project target without inventing a local path", async () => {
	const tree = [{ name: "src", relativePath: "src", target: { projectId: PROJECT, relativePath: "src" }, type: "directory", hasChildren: true }];
	assert.equal("path" in tree[0], false);
	const directoryKey = fileTreeNodeKey(tree[0]);
	assert.equal(directoryKey, `project:${PROJECT}\u0000src`);
	assert.equal(findDirectoryNodeByPath(tree, directoryKey), tree[0]);
	let requested;
	const hydrated = await hydrateExpandedFileTree(
		async (target) => {
			requested = target;
			return [{ name: "main.ts", relativePath: "src/main.ts", target: { projectId: PROJECT, relativePath: "src/main.ts" }, type: "file" }];
		},
		tree,
		[directoryKey],
	);
	assert.deepEqual(requested, { projectId: PROJECT, relativePath: "src" });
	assert.equal("path" in hydrated[0], false);
	assert.equal(hydrated[0].children[0].target.relativePath, "src/main.ts");
});

test("findLoadedDirectory treats missing children as not loaded", () => {
	const tree = [dir("src", "/p/src")];
	assert.equal(findLoadedDirectory(tree, k(tree[0])), undefined);
	const loaded = mergeFileTreeChildren(tree, k(tree[0]), []);
	assert.equal(findLoadedDirectory(loaded, k(tree[0]))?.name, "src");
});

test("mergeFileTreeChildren writes listing into the matching directory", () => {
	const tree = [dir("src", "/p/src"), file("README.md", "/p/README.md")];
	const next = mergeFileTreeChildren(tree, k(tree[0]), [file("App.tsx", "/p/src/App.tsx")]);
	assert.equal(next[0].children[0].name, "App.tsx");
	assert.equal(next[0].hasChildren, true);
	assert.equal(next[1].name, "README.md");
});

test("mergeFileTreeChildren leaves the tree unchanged when the directory is missing", () => {
	const tree = [file("README.md", "/p/README.md")];
	const next = mergeFileTreeChildren(tree, projectFileKey({ projectId: PROJECT, relativePath: "src" }), [file("App.tsx", "/p/src/App.tsx")]);
	assert.deepEqual(next, tree);
	// 同一引用是「内容没变」的判据（useFileTreeContentState 据此决定是否推进内容代次）：
	// 返回新数组会把迟到/落空的 listing 误判成内容变化，白跑一轮 Git 着色重拉。
	assert.equal(next, tree, "无变化时返回原数组引用");
});

test("hydrateExpandedFileTree loads shorter parent paths first", async () => {
	const listed = [];
	const tree = [dir("src", "/p/src")];
	const components = dir("components", "/p/src/components");
	// hydrate 对「树里看得到的目录」传的是 target，对深层未知目录才传键字符串：两者都归一成键再断言。
	const asKey = (entry) => (typeof entry === "string" ? entry : projectFileKey(entry));
	const hydrated = await hydrateExpandedFileTree(
		async (directory) => {
			listed.push(directory);
			if (asKey(directory) === k(tree[0])) return [components];
			if (asKey(directory) === k(components)) return [file("Button.tsx", "/p/src/components/Button.tsx")];
			return [];
		},
		tree,
		[k(components), k(tree[0])],
	);
	assert.deepEqual(listed.map(asKey), [k(tree[0]), k(components)]);
	assert.equal(hydrated[0].children[0].children[0].name, "Button.tsx");
});

test("hydrateExpandedFileTree 并发拉取但按父先子后合并（2027-02 性能治理）", async () => {
	let inFlight = 0;
	let maxInFlight = 0;
	const tree = [dir("src", "/p/src")];
	const rootKey = k(tree[0]);
	const expanded = [rootKey];
	const children = [];
	// 构造 12 个目录：src 与 src/d1..d11（全部以 src 为父）
	for (let index = 1; index <= 11; index += 1) {
		const child = dir(`d${index}`, `/p/src/d${index}`);
		children.push(child);
		expanded.push(k(child));
	}
	const hydrated = await hydrateExpandedFileTree(
		async (directory) => {
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await new Promise((resolve) => setImmediate(resolve));
			inFlight -= 1;
			const key = typeof directory === "string" ? directory : projectFileKey(directory);
			if (key === rootKey) return children;
			return [file("f.ts", `${key}/f.ts`)];
		},
		tree,
		expanded,
	);
	assert.ok(maxInFlight > 1, `listing 必须并发（实际最大并发 ${maxInFlight}）`);
	assert.ok(maxInFlight <= 8, `并发不得超过上限 8（实际 ${maxInFlight}）`);
	// 合并仍父先子后：每个 dN 的子项都并进去了
	for (let index = 1; index <= 11; index += 1) {
		const name = `d${index}`;
		const parent = hydrated[0].children.find((node) => node.type === "directory" && node.name === name);
		assert.equal(parent?.children?.[0]?.name, "f.ts", `${name} 的子项应已合并`);
	}
});

test("findDirectoryNodeByRelativePath finds unexpanded directory", () => {
	const tree = [dir("src", "/p/src"), file("README.md", "/p/README.md")];
	assert.equal(findDirectoryNodeByRelativePath(tree, "src")?.path, "/p/src");
	assert.equal(findDirectoryNodeByRelativePath(tree, "README.md"), undefined);
});

test("findDirectoryNodeByRelativePath finds nested loaded directory", () => {
	const tree = [{ ...dir("src", "/p/src"), children: [dir("components", "/p/src/components")] }];
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
	const src = dir("src", "/p/src");
	const components = { ...dir("components", "/p/src/components"), children: undefined };
	const tree = [src, components];
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
	const tree = [{ ...dir("src", "/p/src", [dir("deep", "/p/src/deep")]) }];
	// src 已展开但 deep 未拉：链条停在 deep（下一级待加载目录）
	assert.equal(resolveAtDrillDirectory("src/deep/nope/I", tree)?.path, "/p/src/deep");
});

test("resolveAtDrillDirectory returns undefined when nothing to drill", () => {
	const tree = [dir("src", "/p/src")];
	assert.equal(resolveAtDrillDirectory("index", tree), undefined);
	assert.equal(resolveAtDrillDirectory("", tree), undefined);
});

test("markFileTreeLoadFailed 在顶层目录打标且不触碰 children", () => {
	const tree = [dir("src", "/p/src", [file("a.ts", "/p/src/a.ts")])];
	const next = markFileTreeLoadFailed(tree, k(tree[0]));
	assert.equal(next[0].hasChildren, false);
	assert.equal(next[0].children?.length, 1);
});

test("markFileTreeLoadFailed 递归命中嵌套目录", () => {
	const deep = dir("deep", "/p/src/deep");
	const tree = [{ ...dir("src", "/p/src", [deep]) }];
	const next = markFileTreeLoadFailed(tree, k(deep));
	assert.equal(next[0].hasChildren, true, "父层不受影响");
	assert.equal(next[0].children[0].hasChildren, false);
});

test("打标后重新 merge 成功结果可恢复（重试入口语义）", () => {
	const tree = [dir("src", "/p/src")];
	const failed = markFileTreeLoadFailed(tree, k(tree[0]));
	assert.equal(failed[0].hasChildren, false);
	// 重新展开时 findLoadedDirectory 未命中 → 再次发起拉取 → merge 覆盖标记。
	assert.equal(findLoadedDirectory(failed, k(tree[0])), undefined);
	const recovered = mergeFileTreeChildren(failed, k(tree[0]), [file("a.ts", "/p/src/a.ts")]);
	assert.equal(recovered[0].hasChildren, true);
	assert.equal(recovered[0].children[0].name, "a.ts");
});

test("@ 纯文件名搜索只请求一次有界搜索，保留项目 target 并过滤目录浏览重复项", async () => {
	const calls = [];
	const snapshot = await loadAtFileNameSearch(PROJECT, "leaf", async (projectId, query) => {
		calls.push({ projectId, query });
		return [{ name: "leaf.ts", relativePath: "nested/deep/leaf.ts", path: "/p/nested/deep/leaf.ts", type: "file" }];
	});
	assert.deepEqual(calls, [{ projectId: PROJECT, query: "leaf" }]);
	assert.equal(snapshot.projectId, PROJECT);
	assert.equal(snapshot.query, "leaf");
	assert.equal(snapshot.files[0].path, "/p/nested/deep/leaf.ts");
	assert.equal(snapshot.files[0].type, "file");
	assert.equal(snapshot.files[0].target.projectId, PROJECT);
	assert.equal(snapshot.files[0].target.relativePath, "nested/deep/leaf.ts");

	const loaded = [file("leaf.ts", "/p/nested/deep/leaf.ts"), file("other.ts", "/p/other.ts")];
	const merged = mergeAtFileNameSearchFiles(loaded, snapshot.files);
	assert.equal(merged[0], snapshot.files[0], "保留搜索命中的 target，不以本机路径节点覆盖");
	assert.equal(merged.length, 2);
	assert.equal(mergeAtFileNameSearchFiles(loaded, []), loaded);
});

test("shouldSearchFileNames requires real non-path search intent", () => {
	assert.equal(shouldSearchFileNames("index"), true);
	assert.equal(shouldSearchFileNames("in"), true);
	assert.equal(shouldSearchFileNames("i"), false);
	assert.equal(shouldSearchFileNames(""), false);
	assert.equal(shouldSearchFileNames("src/"), false);
	assert.equal(shouldSearchFileNames("src/com"), false);
	assert.equal(shouldSearchFileNames("C:\\Users\\me\\a.ts"), false);
	assert.equal(shouldSearchFileNames("C:/Users/me/a.ts"), false);
});
