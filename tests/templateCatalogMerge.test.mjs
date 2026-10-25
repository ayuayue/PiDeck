import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 输入框模板表合并（W3）：用户目录/项目目录 ∪ pi 运行时模板。
 * 规则：同名正文取运行时（pi 的最终视图），展示元数据沿用本地；运行时独有条目追加。
 */

const { mergeRuntimeTemplates, assembleTemplates } = loadTsCommonJs("src/renderer/src/utils/templateCatalog.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

const local = (name, content, extra = {}) => ({ name, path: `C:/p/${name}.md`, description: `本地 ${name}`, content, scope: "global", enabled: true, ...extra });

test("同名的正文取运行时版本（与 pi 展开结果一致），本地描述保留", () => {
	const merged = mergeRuntimeTemplates([local("commit", "LOCAL-BODY")], [{ name: "commit", content: "RUNTIME-BODY" }]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].content, "RUNTIME-BODY");
	assert.equal(merged[0].description, "本地 commit");
	assert.equal(merged[0].path, "C:/p/commit.md");
});

test("运行时独占的模板被追加（如 npm 包声明的 pi.prompts）", () => {
	const merged = mergeRuntimeTemplates([local("commit", "LOCAL")], [{ name: "parallel-review", content: "---\ndescription: 评审\n---\nREVIEW", description: "评审" }]);
	assert.deepEqual(plain(merged.map((t) => t.name)), ["commit", "parallel-review"]);
	const added = merged.find((t) => t.name === "parallel-review");
	assert.equal(added.path, "");
	assert.equal(added.description, "评审");
});

test("运行时套件里的 argument-hint 被解析出来", () => {
	const merged = mergeRuntimeTemplates([], [{ name: "x", content: "---\nargument-hint: <file>\n---\nBODY" }]);
	assert.equal(merged[0].argumentHint, "<file>");
});

test("运行时为空时原样返回（不复制数组，节省渲染）", () => {
	const base = [local("commit", "LOCAL")];
	assert.equal(mergeRuntimeTemplates(base, []), base);
});

test("本地描述为空时用运行时的描述兜底", () => {
	const merged = mergeRuntimeTemplates([local("commit", "LOCAL", { description: "" })], [{ name: "commit", content: "RT", description: "来自 frontmatter" }]);
	assert.equal(merged[0].description, "来自 frontmatter");
});

test("本地多余模板不被删除（运行时只覆盖同名）", () => {
	const merged = mergeRuntimeTemplates([local("a", "A"), local("b", "B")], [{ name: "b", content: "B2" }]);
	assert.deepEqual(plain(merged.map((t) => t.name)), ["a", "b"]);
	assert.equal(merged[1].content, "B2");
});

/**
 * 来源 A 自身的合并（复刻 pi 的加载优先级）。
 * pi：project(0) < user(2) < package(4) < builtin(5)，先加载者胜；禁用模板不加载。
 */
test("同名时项目模板胜（与 pi 的 rank + 先到先得一致）", () => {
	const merged = assembleTemplates({
		project: [local("review", "PROJECT-BODY")],
		global: [local("review", "GLOBAL-BODY")],
	});
	assert.equal(merged.length, 1);
	assert.equal(merged[0].content, "PROJECT-BODY");
});

test("项目那份被禁用时回落到全局那份（而不是直接消失）", () => {
	const merged = assembleTemplates({
		project: [local("review", "PROJECT-BODY", { enabled: false })],
		global: [local("review", "GLOBAL-BODY")],
	});
	assert.equal(merged.length, 1);
	assert.equal(merged[0].content, "GLOBAL-BODY");
});

test("禁用的模板不进表（pi 根本不加载它，因此也不该被 /名称 展开）", () => {
	const merged = assembleTemplates({ global: [local("old", "BODY", { enabled: false })] });
	assert.deepEqual(plain(merged), []);
});

test("顺序是项目在前、全局在后（与 pi 的 rank 顺序对得上）", () => {
	const merged = assembleTemplates({
		project: [local("p", "P")],
		global: [local("g", "G")],
	});
	assert.deepEqual(plain(merged.map((t) => t.name)), ["p", "g"]);
});

test("缺省/空输入不炸", () => {
	assert.deepEqual(plain(assembleTemplates({})), []);
	assert.deepEqual(plain(assembleTemplates({ project: [], global: [] })), []);
});
