/**
 * docs/unified-api.md 契约守卫（TEST-PLAN F9，8 例：正向 6 + 负向 2）。
 * 无加载器（node:fs + 正则扫描）；正则一律空白容忍（\s*、^[\t ]* 锚点），
 * 防 biome 格式化打破（AGENTS.md 格式化纪律）。A18 围栏限定口径：只扫围栏代码块内，
 * 围栏外散文中的 require( 字样不违规。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(import.meta.dirname, "..");
const doc = readFileSync(join(repoRoot, "docs/unified-api.md"), "utf8");
const catalogSource = readFileSync(join(repoRoot, "src/shared/api/domainCatalog.ts"), "utf8");
const importerSource = readFileSync(join(repoRoot, "src/shared/api/importerCatalog.ts"), "utf8");

/** 提取一章正文（自 `## <title>` 行起至下一个 `## ` 行前）；找不到标题时返回空串。 */
function extractChapter(text, title) {
	const start = text.search(new RegExp(`^## ${title}\\s*$`, "m"));
	if (start === -1) return "";
	const rest = text.slice(text.indexOf("\n", start) + 1);
	const next = rest.search(/^## /m);
	return next === -1 ? rest : rest.slice(0, next);
}

/** 从 shared 目录表源码提取全部行 id（空白容忍：行首制表符/空格 + `{ id: "..."`）。 */
function catalogIdsFrom(source) {
	const ids = [];
	for (const match of source.matchAll(/^[\t ]*\{\s*id:\s*"([a-z0-9-]+)"/gm)) {
		ids.push(match[1]);
	}
	return ids;
}

/** 文档表格行（首列为反引号包裹的 kebab-case id）→ id 列表。 */
function backtickedRowIds(text) {
	const ids = [];
	for (const match of text.matchAll(/^[\t ]*\|\s*`([a-z0-9-]+)`\s*\|/gm)) {
		ids.push(match[1]);
	}
	return ids;
}

/** 取某域在文档中的表格行整行（红线关键词与域 id 邻近断言的载体）。 */
function domainRow(id) {
	const line = doc.split(/\r?\n/).find((row) => new RegExp(`^\\|\\s*\`${id}\`\\s*\\|`).test(row));
	return line ?? "";
}

/** 提取全部围栏代码块内容（``` 开闭行之间的正文，A18 扫描范围）。 */
function extractFencedBlocks(text) {
	const blocks = [];
	let current = null;
	for (const line of text.split(/\r?\n/)) {
		if (/^[\t ]*```/.test(line)) {
			if (current === null) {
				current = [];
			} else {
				blocks.push(current.join("\n"));
				current = null;
			}
		} else if (current !== null) {
			current.push(line);
		}
	}
	return blocks;
}

/** A18 加载器禁令形态（空白容忍）与违规描述。 */
const FORBIDDEN_FENCE_PATTERNS = [
	[/child_process/, "child_process"],
	[/spawn\s*\(/, "spawn("],
	[/require\s*\(/, "require("],
	[/eval\s*\(/, "eval("],
	[/new\s+Function/, "new Function"],
	[/import\s*\(/, "动态 import("],
	[/node:vm/, "node:vm"],
];

/** 对围栏块集合跑 A18 扫描，返回违规描述列表（空 = 干净）。 */
function scanFencesForLoaderForms(blocks) {
	const violations = [];
	for (const block of blocks) {
		for (const [pattern, label] of FORBIDDEN_FENCE_PATTERNS) {
			if (pattern.test(block)) {
				violations.push(label);
			}
		}
	}
	return violations;
}

const overview = extractChapter(doc, "API 总览");
const domainsChapter = extractChapter(doc, "按域调用面");
const pluginChapter = extractChapter(doc, "插件扩展点设计");
const themeChapter = extractChapter(doc, "主题壳扩展点设计");
const catalogIds = catalogIdsFrom(catalogSource);
const importerIds = catalogIdsFrom(importerSource);

test("F9-1 文档存在且含四章标题（API 总览 / 按域调用面 / 插件扩展点设计 / 主题壳扩展点设计）", () => {
	assert.ok(doc.length > 0, "docs/unified-api.md 应存在且非空");
	for (const title of ["API 总览", "按域调用面", "插件扩展点设计", "主题壳扩展点设计"]) {
		assert.ok(new RegExp(`^## ${title}\\s*$`, "m").test(doc), `文档缺章节标题「${title}」`);
	}
});

test("F9-2 API 总览含三错误码全名、装配机制关键词与消费前提标注", () => {
	assert.ok(overview.includes("PIDECK_API_DUPLICATE_DOMAIN"), "API 总览缺错误码 PIDECK_API_DUPLICATE_DOMAIN");
	assert.ok(overview.includes("PIDECK_API_REGISTRY_FROZEN"), "API 总览缺错误码 PIDECK_API_REGISTRY_FROZEN");
	assert.ok(overview.includes("PIDECK_API_INVALID_DOMAIN_ENTRY"), "API 总览缺错误码 PIDECK_API_INVALID_DOMAIN_ENTRY");
	assert.ok(overview.includes("registerDomain"), "API 总览缺装配关键词 registerDomain");
	assert.ok(overview.includes("freeze"), "API 总览缺装配关键词 freeze");
	assert.ok(overview.includes("piDeckApi 以 preload 齐备为消费前提"), "API 总览缺消费前提标注（S3/S7）");
});

test("F9-3 按域调用面覆盖 DOMAIN_CATALOG 全部 id 且表格行数一致", () => {
	assert.equal(catalogIds.length, 65, "DOMAIN_CATALOG 应为 65 行");
	const uniqueCatalogIds = new Set(catalogIds);
	assert.equal(uniqueCatalogIds.size, 65, "DOMAIN_CATALOG id 应无重复");
	const rowIds = backtickedRowIds(domainsChapter).filter((id) => uniqueCatalogIds.has(id));
	assert.equal(new Set(rowIds).size, 65, "按域调用面应恰好 65 个域表格行（无重复）");
	for (const id of catalogIds) {
		assert.ok(rowIds.includes(id), `按域调用面缺域 ${id}`);
	}
	// 表格行总数契约 = 域 64 行 + 导入器 11 行，无其他首列反引号表格行。
	assert.equal(backtickedRowIds(domainsChapter).length, 65 + importerIds.length, "按域调用面表格行数应为 65 域 + 11 导入器");
});

test("F9-4 四条例外与 DSH 插件体系在域行上标注红线（关键词与域 id 邻近）", () => {
	const redlineExpectations = [
		{ id: "pi", keywords: ["红线", "模型快照", "standby"], note: "模型快照端点与 standby 池宿主 pi 行" },
		{ id: "dsh", keywords: ["红线", "DSH", "透传"], note: "DSH 插件体系宿主 dsh 行" },
		{ id: "pi-auth", keywords: ["红线", "例外一", "pi-auth-host"], note: "例外一 pi-auth" },
		{ id: "enhance", keywords: ["红线", "例外四", "pi-enhance-host"], note: "例外四 enhance" },
	];
	for (const { id, keywords, note } of redlineExpectations) {
		const row = domainRow(id);
		assert.ok(row.length > 0, `文档缺域 ${id} 的表格行`);
		for (const keyword of keywords) {
			assert.ok(row.includes(keyword), `域 ${id} 表格行缺红线关键词「${keyword}」（${note}）`);
		}
	}
});

test("F9-5 插件扩展点设计章含 manifest / 权限四级 / 激活 / 失败隔离且标注设计稿", () => {
	assert.ok(pluginChapter.includes("manifest"), "插件章缺关键词 manifest");
	assert.ok(pluginChapter.includes("只读 UI"), "插件章缺权限分级「只读 UI」");
	assert.ok(pluginChapter.includes("读写指定目录"), "插件章缺权限分级「读写指定目录」");
	assert.ok(pluginChapter.includes("终端与进程"), "插件章缺权限分级「终端与进程」");
	assert.ok(pluginChapter.includes("网络与凭据"), "插件章缺权限分级「网络与凭据」");
	assert.ok(pluginChapter.includes("激活"), "插件章缺关键词 激活");
	assert.ok(pluginChapter.includes("失败隔离"), "插件章缺关键词 失败隔离");
	assert.ok(pluginChapter.includes("设计稿"), "插件章缺「设计稿」标注");
});

test("F9-6 主题壳扩展点设计章含 token 受限覆盖集 / 亮暗成对 / 主题是数据且标注设计稿", () => {
	assert.ok(themeChapter.includes("token"), "主题章缺关键词 token");
	assert.ok(themeChapter.includes("受限覆盖集"), "主题章缺「受限覆盖集」");
	assert.ok(themeChapter.includes("白名单"), "主题章缺「白名单」");
	assert.ok(themeChapter.includes("亮暗成对"), "主题章缺「亮暗成对」");
	assert.ok(themeChapter.includes("主题是数据不是代码"), "主题章缺「主题是数据不是代码」");
	assert.ok(themeChapter.includes("设计稿"), "主题章缺「设计稿」标注");
});

test("F9-7 A18：文档围栏代码块内无加载器可执行形态", () => {
	const violations = scanFencesForLoaderForms(extractFencedBlocks(doc));
	assert.deepEqual(violations, [], `围栏代码块内出现加载器形态：${violations.join("、")}`);
});

test("F9-8 A18 分辨力：同一扫描对内联坏样本必命中（防正则恒真）", () => {
	const badSample = ["# 假文档", "", "```js", 'const cp = require("child_process");', "```", "", "散文里的 require( 字样不违规（围栏外）。"].join("\n");
	const violations = scanFencesForLoaderForms(extractFencedBlocks(badSample));
	assert.ok(violations.includes("child_process"), "坏样本应命中 child_process");
	assert.ok(violations.includes("require("), "坏样本应命中 require(");
});
