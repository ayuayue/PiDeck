import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 「已安装扩展」列表的本地搜索是纯渲染层过滤（无 IPC）：过滤规则集中在
// src/renderer/src/utils/extensionFilter.ts，这里钉住它的匹配字段与匹配语义。
// 该函数同时服务 ExtensionsTab 的已安装行与运行时发现行（discovery），
// 两组共用同一套规则才不会出现「分组表头还在、行已被过滤空」的错位。
const { filterExtensionsByQuery, buildExtensionHaystack } = loadTsCommonJs("src/renderer/src/utils/extensionFilter.ts");

/** 构造最小扩展条目测试数据（只填过滤相关字段）。 */
function extension(id, source, extra = {}) {
	return { id, source, scope: "user", ...extra };
}

const extensions = [
	// 内置扩展：source 即文件名，id 带 local: 前缀
	extension("local:pi-deck-todo.ts", "pi-deck-todo.ts", { builtIn: true }),
	// npm 包：source 带协议前缀
	extension("user:npm:todo-tool", "npm:todo-tool"),
	// scoped 包：可见短名是去掉 @scope/ 之后的部分
	extension("user:npm:@acme/todo-helper", "npm:@acme/todo-helper"),
	extension("user:npm:@acme/vision-pack", "npm:@acme/vision-pack"),
	// 大小写混合的 npm 包名：大小写不敏感规则必须真的生效（haystack 侧也要归一化）
	extension("user:npm:@acme/TodoHelper", "npm:@acme/TodoHelper"),
	// 本地文件扩展：中文名按 source 子串命中
	extension("project:文件抽屉.ts", "file:文件抽屉.ts", { scope: "project" }),
];

const sourcesOf = (list) => list.map((entry) => entry.source);

test("empty or whitespace-only query returns the list unchanged", () => {
	// 恒等：空查询不得复制数组，调用方（useMemo 依赖、行 key 稳定性）依赖同一引用
	assert.equal(filterExtensionsByQuery(extensions, ""), extensions);
	assert.equal(filterExtensionsByQuery(extensions, "   "), extensions);
	assert.equal(filterExtensionsByQuery(extensions, "\t\n"), extensions);
});

test("query matches source, short name and id case-insensitively", () => {
	const matched = filterExtensionsByQuery(extensions, "todo");
	assert.deepEqual(sourcesOf(matched), ["pi-deck-todo.ts", "npm:todo-tool", "npm:@acme/todo-helper", "npm:@acme/TodoHelper"]);
	// 大小写不敏感：大写查询命中同一批，顺序不变
	assert.deepEqual(sourcesOf(filterExtensionsByQuery(extensions, "TODO")), sourcesOf(matched));
	// 命中 id（而非 source）的条目也要留下
	assert.deepEqual(sourcesOf(filterExtensionsByQuery(extensions, "local:pi-deck")), ["pi-deck-todo.ts"]);
	// scoped 包的可见短名同样可命中
	assert.deepEqual(sourcesOf(filterExtensionsByQuery(extensions, "vision")), ["npm:@acme/vision-pack"]);
});

test("query is trimmed before matching", () => {
	assert.deepEqual(sourcesOf(filterExtensionsByQuery(extensions, "  todo  ")), sourcesOf(filterExtensionsByQuery(extensions, "todo")));
});

test("unmatched query returns an empty list", () => {
	assert.deepEqual(filterExtensionsByQuery(extensions, "no-such-extension"), []);
	assert.ok(filterExtensionsByQuery(extensions, "todo").length > 0);
});

test("Chinese keywords match as a source substring", () => {
	assert.deepEqual(sourcesOf(filterExtensionsByQuery(extensions, "抽屉")), ["file:文件抽屉.ts"]);
});

test("runtime discovery rows without an id are filtered by the same rule", () => {
	// discovery 行（package/settings 声明）没有 id 字段，与已安装行共用同一入口
	const discovery = [
		{ source: "npm:@acme/todo-helper", path: "D:/p/node_modules/@acme/todo-helper", sourceId: "package-project", sourceLabel: "package", physicalScope: "project", enabled: true, managed: false },
		{ source: "npm:@acme/vision-pack", path: "D:/p/node_modules/@acme/vision-pack", sourceId: "package-project", sourceLabel: "package", physicalScope: "project", enabled: true, managed: false },
	];
	assert.deepEqual(sourcesOf(filterExtensionsByQuery(discovery, "todo")), ["npm:@acme/todo-helper"]);
	assert.equal(filterExtensionsByQuery(discovery, ""), discovery);
});

test("buildExtensionHaystack joins source, short name and id with newlines", () => {
	// 三段结构本身是搜索契约：短名段必须独立存在，「去掉协议/scope 后的名字」才能命中。
	// 压成单段或丢掉短名段都会让本用例红——防止将来重构静默丢段。
	assert.equal(buildExtensionHaystack({ id: "user:npm:@acme/todo-helper", source: "npm:@acme/todo-helper" }), "npm:@acme/todo-helper\ntodo-helper\nuser:npm:@acme/todo-helper");
	// 无 scope 形态：source 即文件名，短名段剥掉 .ts 后缀后仍与 source 段不同
	assert.equal(buildExtensionHaystack({ source: "pi-deck-todo.ts" }), "pi-deck-todo.ts\npi-deck-todo\n");
	// 本地文件扩展：短名段是去掉协议与 .ts 的中文名
	assert.equal(buildExtensionHaystack({ id: "project:文件抽屉.ts", source: "file:文件抽屉.ts" }), "file:文件抽屉.ts\n文件抽屉\nproject:文件抽屉.ts");
});

test("filtering never mutates or reorders the input list", () => {
	const input = [extensions[3], extensions[0]];
	const matched = filterExtensionsByQuery(input, "todo");
	assert.deepEqual(sourcesOf(input), ["npm:@acme/vision-pack", "pi-deck-todo.ts"]);
	assert.deepEqual(sourcesOf(matched), ["pi-deck-todo.ts"]);
});
