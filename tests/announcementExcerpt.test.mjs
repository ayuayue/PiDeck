/**
 * announcementExcerpt 公告摘要纯函数单测。
 * 守护：md 结构标记清洗（标题/引用/列表/加粗/行内码/链接/图片/围栏/横线）、
 * 空白折叠、长度截断（含词边界截断与省略号）、自定义 maxLen。
 * 纯函数零依赖，用项目惯例 loadTsModule 加载 TS 源码。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import vm from "node:vm";

/** 与 announcementService.test.mjs 同款：transpile TS → CJS 并在沙箱执行（零依赖）。 */
function loadTsModule(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, {
		module,
		exports: module.exports,
		require: () => {
			throw new Error("unexpected require");
		},
		console,
	});
	return module.exports;
}

const { announcementExcerpt } = loadTsModule("src/renderer/src/utils/announcementExcerpt.ts");

test("纯文本短内容原样返回（无省略号）", () => {
	assert.equal(announcementExcerpt("普通公告内容"), "普通公告内容");
});

test("清洗加粗/行内码/链接标记保留文本", () => {
	assert.equal(announcementExcerpt("**重点** 与 `code` 与 [链接](https://x.com)"), "重点 与 code 与 链接");
});

test("图片整段剔除", () => {
	assert.equal(announcementExcerpt("![截图](https://x/a.png) 后文"), "后文");
});

test("多行结构（标题/列表/引用/横线）清洗后折叠为单行", () => {
	const md = ["# 标题", "- 项目一", "* 项目二", "1. 项目三", "> 引用语", "---", "结束语"].join("\n");
	assert.equal(announcementExcerpt(md), "标题 项目一 项目二 项目三 引用语 结束语");
});

test("代码围栏整行剔除", () => {
	const md = ["介绍：", "```", "const a = 1;", "```", "完成"].join("\n");
	assert.equal(announcementExcerpt(md), "介绍： 完成");
});

test("超长截断补省略号，且优先词边界（英文）", () => {
	const body = "word one two three four five six seven eight";
	const clean = "word one two three four five six seven eight";
	const cut = announcementExcerpt(body, 20);
	assert.ok(cut.endsWith("…"));
	assert.ok(cut.length <= 20 + 1, `截断后不超过 maxLen+1：${cut}`);
	// 词边界：去掉省略号后必须是原文的完整词前缀（词尾截断，不切断单词）
	const base = cut.slice(0, -1);
	assert.ok(clean === base || clean.startsWith(base + " "), `不在词中间截断：${cut}`);
});

test("中文长文本按字符截断（无空格退化为纯长度截断）", () => {
	const body = "这是一段特别特别特别特别特别特别特别特别特别特别特别特别特别长的中文公告内容";
	const cut = announcementExcerpt(body, 10);
	assert.equal(cut, "这是一段特别特别特别特别特别特别…".slice(0, 10) + "…");
	assert.equal(cut.length, 11);
});

test("自定义 maxLen 生效", () => {
	const body = "1234567890";
	assert.equal(announcementExcerpt(body, 5), "12345…");
});

test("清洗后为空（纯 md 结构）返回空串", () => {
	assert.equal(announcementExcerpt("```\n```\n---\n> "), "");
});

test("双星不残留半边标记（先双星后单星顺序）", () => {
	assert.equal(announcementExcerpt("a **bold** b *em* c"), "a bold b em c");
});
