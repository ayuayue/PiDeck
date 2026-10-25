// MorphingSearch 的检索规则（纯函数）：子串命中 + 拼音通道，顺序不改写。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { filterSearchItems } = loadTsCommonJs("src/renderer/src/components/motion/morphingSearchFilter.ts");
const { pinyinKeys, ensurePinyinTable } = loadTsCommonJs("src/renderer/src/utils/pinyinSearch.ts");
// 拼音字典按需装载后，同步的 pinyinKeys 只在表就绪后产出真实键；先装载再构造条目。
await ensurePinyinTable();

/** 构造一个会话项：标题中文、描述英文，贴近侧栏真实数据。 */
function item(id, title, description = "") {
	return { id, title, description, pinyin: pinyinKeys(title) };
}

const items = [item("p1", "pi-desktop-dev", "/Users/a/pi-desktop-dev"), item("s1", "用量查询弹窗", "providerUsage 面板"), item("s2", "搜索会话弹框跑出屏幕", "MorphingSearch"), item("s3", "重庆项目迁移", "wsl")];

test("空查询返回原数组（引用不变），供调用方按身份记忆", () => {
	assert.equal(filterSearchItems(items, ""), items);
	assert.equal(filterSearchItems(items, "   "), items);
});

test("子串命中 title / description，大小写不敏感", () => {
	assert.deepEqual(
		filterSearchItems(items, "morphingsearch").map((entry) => entry.id),
		["s2"],
	);
	assert.deepEqual(
		filterSearchItems(items, "DEV").map((entry) => entry.id),
		["p1"],
	);
	assert.deepEqual(
		filterSearchItems(items, "providerusage").map((entry) => entry.id),
		["s1"],
	);
});

test("首字母查询命中中文标题，可跨多个项", () => {
	assert.deepEqual(
		filterSearchItems(items, "ylcx").map((entry) => entry.id),
		["s1"],
	);
	assert.deepEqual(
		filterSearchItems(items, "sshh").map((entry) => entry.id),
		["s2"],
	);
	assert.deepEqual(
		filterSearchItems(items, "cq").map((entry) => entry.id),
		["s3"],
		"异读：cq 应命中重庆",
	);
	assert.deepEqual(
		filterSearchItems(items, "zq").map((entry) => entry.id),
		["s3"],
		"异读：zq 也应命中重庆",
	);
});

test("全拼与跳字首字母同样能命中", () => {
	assert.deepEqual(
		filterSearchItems(items, "yongliang").map((entry) => entry.id),
		["s1"],
	);
	assert.deepEqual(
		filterSearchItems(items, "lcx").map((entry) => entry.id),
		["s1"],
		"跳字：跳过「用」",
	);
});

test("中文查询仍走子串匹配（不进拼音通道）", () => {
	assert.deepEqual(
		filterSearchItems(items, "用量").map((entry) => entry.id),
		["s1"],
	);
	assert.deepEqual(
		filterSearchItems(items, "不存在的词").map((entry) => entry.id),
		[],
	);
});

test("纯 ASCII 项没有拼音键也不受影响；未命中返回空数组", () => {
	assert.deepEqual(
		filterSearchItems(items, "zzzzzz").map((entry) => entry.id),
		[],
	);
	assert.equal(items[0].pinyin, null, "纯英文标题不生成拼音键");
});

test("命中只决定留下，保持调用方原有顺序（不按分数重排）", () => {
	// 两个标题共享前缀「用量」：前缀查询 yl 同时命中，输出顺序必须与入参一致。
	const both = [item("s9", "用量统计"), item("s1", "用量查询")];
	assert.deepEqual(
		filterSearchItems(both, "yl").map((entry) => entry.id),
		["s9", "s1"],
	);
	assert.deepEqual(
		filterSearchItems(both, "用量").map((entry) => entry.id),
		["s9", "s1"],
	);
	// 整名对齐的分数更高，但依然不重排：s1 只被 exact 命中，位置不变。
	assert.deepEqual(
		filterSearchItems(both, "ylcx").map((entry) => entry.id),
		["s1"],
	);
});

test("侧栏装配：会话项与项目项都带拼音键（源码契约）", () => {
	// 组件层无法在 node 里跑，这里钉住「装配点仍然喂了 pinyin」——
	// 漏掉这一行会让拼音通道静默失效（面板能开、只是搜不到），必须靠契约测试兜住。
	const source = readFileSync("src/renderer/src/components/sidebar/SidebarContent.tsx", "utf8");
	// import 名单允许伴随导入（ensurePinyinTable 按需装载字典），只钉住 pinyinKeys 仍从该模块装配。
	assert.match(source, /import\s*\{[^}]*\bpinyinKeys\b[^}]*\}\s*from\s*"\.\.\/\.\.\/utils\/pinyinSearch";/);
	assert.match(source, /pinyin:\s*pinyinKeys\(projectTitle\)/);
	assert.match(source, /pinyin:\s*pinyinKeys\(sessionTitle\)/);
	// 标题必须先用变量取一次再传给搜索项，否则两处会算出不同字符串（fork/空标题兜底）。
	assert.match(source, /const\s+sessionTitle\s*=\s*sessionDisplayName\([^)]*\)\s*\?\?\s*session\.title;/);

	const component = readFileSync("src/renderer/src/components/motion/morphing-search.tsx", "utf8");
	assert.match(component, /filterSearchItems\(items,\s*query\)/);
	assert.match(component, /pinyin\?:/);
});
