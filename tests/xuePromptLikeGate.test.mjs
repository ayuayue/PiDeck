import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

/**
 * xueprompts.db SQL LIKE 静态契约守卫（AGENTS 领域硬约束，见「商店提示词库维护」）：
 * content/description 列是 gzip BLOB——SQL LIKE 对压缩字节恒不命中（尤其中文关键词），
 * 搜索必须走应用层 gunzip 后匹配（XuePromptManager.blobToString）。
 * 行为层已有 tests/xuePromptSearch.test.mjs（5 项，依赖真实 DB，dbAvailable 才跑）；
 * 本测试是**无条件运行**的源码契约层：未来任何对 xueprompts 表的 LIKE 直查在此红灯。
 * 正则空白容忍（AGENTS 格式化纪律），注释剥离后再判（实现注释里合法提及 LIKE 规则）。
 */

/** 引用 xueprompts 表的 src/main 文件（未来新增查询点自动纳入扫描）。 */
function xuePromptFiles() {
	return execFileSync("git", ["ls-files", "src/main"], { encoding: "utf8" })
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".ts"))
		.filter((line) => readFileSync(line, "utf8").includes("xueprompts"));
}

function stripComments(source) {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

test("引用 xueprompts 的主进程代码不得出现 SQL LIKE 直查", () => {
	const files = xuePromptFiles();
	// 基线：搜索主路径 + 更新器等。少于 3 个说明文件被挪走，测试自身需要更新。
	assert.ok(files.length >= 3, `fixture sanity: expect >=3 xueprompt files, got ${files.length}: ${files.join(", ")}`);
	const violations = [];
	for (const file of files) {
		const code = stripComments(readFileSync(file, "utf8"));
		if (/\bLIKE\b/i.test(code)) violations.push(file);
	}
	assert.deepEqual(violations, [], `content/description 是 gzip BLOB，SQL LIKE 恒不命中——搜索必须走应用层 gunzip（见 XuePromptManager.blobToString 与 tests/xuePromptSearch.test.mjs）：\n${violations.join("\n")}`);
});

test("搜索路径必须经应用层解压：description/content 都过 blobToString", () => {
	const code = stripComments(readFileSync("src/main/prompts/XuePromptManager.ts", "utf8"));
	// 搜索过滤 seam：row[4]=content、row[5]=description 都必须经解压函数后 includes
	assert.match(code, /blobToString\(row\[4\]\)/, "content BLOB 必须解压后再匹配");
	assert.match(code, /blobToString\(row\[5\]\)/, "description BLOB 必须解压后再匹配");
	assert.match(code, /import \{ gunzipSync \} from "node:zlib"/, "解压实现必须是 node:zlib gunzipSync");
});

test("损坏 BLOB 不炸列表：gunzip 失败降级 utf8 原文（旧未压缩数据兼容）", () => {
	const code = stripComments(readFileSync("src/main/prompts/XuePromptManager.ts", "utf8"));
	const m = code.match(/private blobToString[\s\S]*?\n\t\}/);
	assert.ok(m, "blobToString 实现必须存在");
	assert.match(m[0], /try \{[\s\S]*gunzipSync[\s\S]*\} catch \{[\s\S]*toString\("utf8"\)/, "gunzip 失败必须 catch 并降级为 utf8 原文，不得抛出中断列表");
});
