import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// compactMiddlePackages 是纯展示层变换：不依赖 React/DOM，可直接在 node 环境测。
const { compactMiddlePackages } = loadTsCommonJs("src/renderer/src/utils/fileTreeCompact.ts");

/** 构造目录节点（默认 children 未加载 = undefined，模拟抽屉浅层 listing） */
function dir(name, { children, hasChildren = true } = {}) {
	return {
		name,
		path: `/proj/${name}`,
		relativePath: name,
		type: "directory",
		...(children ? { children } : {}),
		...(hasChildren === false ? { hasChildren: false } : { hasChildren }),
	};
}

/** 构造文件节点 */
function file(name) {
	return { name, path: `/proj/${name}`, relativePath: name, type: "file" };
}

test("合并单子目录且无文件的链为点分节点，path 取链尾", () => {
	// cn -> redinfo -> smarlink -> ops -> service -> [Ops.java]
	const service = dir("service", { children: [file("Ops.java")] });
	const ops = dir("ops", { children: [service] });
	const smarlink = dir("smarlink", { children: [ops] });
	const redinfo = dir("redinfo", { children: [smarlink] });
	const cn = dir("cn", { children: [redinfo] });

	const result = compactMiddlePackages([cn]);

	assert.equal(result.length, 1);
	const merged = result[0];
	assert.equal(merged.type, "directory");
	assert.equal(merged.name, "cn.redinfo.smarlink.ops.service");
	// path 取链尾（真实叶子目录），展开/点击仍作用于 service
	assert.equal(merged.path, "/proj/service");
	assert.equal(merged.relativePath, "service");
	assert.equal(merged.children.length, 1);
	assert.equal(merged.children[0].name, "Ops.java");
});

test("链中出现文件即停止折叠", () => {
	// pkg 有 1 个文件 + 1 个子目录 → 不是中间包，不合并
	const sub = dir("sub", { children: [file("B.java")] });
	const pkg = dir("pkg", { children: [file("A.java"), sub] });

	const result = compactMiddlePackages([pkg]);

	assert.equal(result.length, 1);
	assert.equal(result[0].name, "pkg");
	assert.equal(result[0].children.length, 2);
});

test("链中出现多个子项即停止折叠", () => {
	const a = dir("a", { children: [file("A.java")] });
	const b = dir("b", { children: [file("B.java")] });
	const root = dir("root", { children: [a, b] });

	const result = compactMiddlePackages([root]);

	assert.equal(result[0].name, "root");
	assert.equal(result[0].children.length, 2);
});

test("未加载的目录不折叠", () => {
	// java 已加载（children=[]），其唯一子目录 cn 未加载（children 省略）
	const cn = dir("cn", { hasChildren: true }); // 无 children 字段
	const java = dir("java", { children: [cn] });

	const result = compactMiddlePackages([java]);

	// cn 未加载，无法确定是否单子目录链，保持原样
	assert.equal(result[0].name, "java");
	assert.equal(result[0].children[0].name, "cn");
});

test("纯函数：不修改入参", () => {
	const leaf = dir("leaf", { children: [file("A.java")] });
	const mid = dir("mid", { children: [leaf] });
	const input = [mid];

	const before = JSON.stringify(input);
	compactMiddlePackages(input);
	assert.equal(JSON.stringify(input), before);
});
