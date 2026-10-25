import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

/** 加载 utils/commandPaletteFuzzy.ts（纯函数、无依赖） */
function loadFuzzy() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/renderer/src/utils/commandPaletteFuzzy.ts"), sandbox, {
		filename: "utils/commandPaletteFuzzy.ts",
	});
	return sandbox.exports;
}

/** 跨 VM realm 的对象先 JSON 归一化再断言（原型不同，直接 deepEqual 恒失败） */
function plain(value) {
	return JSON.parse(JSON.stringify(value));
}

test("fuzzyMatch：空 query 恒匹配且零分（调用方据此原序展示全部）", () => {
	const s = loadFuzzy();
	assert.deepEqual(plain(s.fuzzyMatch("", "任意标题")), { score: 0, indices: [] });
	assert.deepEqual(plain(s.fuzzyMatch("   ", "任意标题")), { score: 0, indices: [] });
});

test("fuzzyMatch：子序列按序命中并回传下标", () => {
	const s = loadFuzzy();
	const hit = s.fuzzyMatch("agt", "Agent");
	assert.ok(hit, "子序列应命中");
	// "agent"：a=0、g=1、t=4（g 紧跟 a，t 跳过 e/n）
	assert.deepEqual(plain(hit.indices), [0, 1, 4]);
});

test("fuzzyMatch：字符顺序不对则不命中", () => {
	const s = loadFuzzy();
	assert.equal(s.fuzzyMatch("tga", "Agent"), null);
	assert.equal(s.fuzzyMatch("zzz", "Agent"), null);
});

test("fuzzyMatch：大小写不敏感", () => {
	const s = loadFuzzy();
	const lower = s.fuzzyMatch("log", "Log");
	const upper = s.fuzzyMatch("LOG", "log");
	assert.ok(lower && upper);
	assert.deepEqual(plain(lower.indices), plain(upper.indices));
});

test("fuzzyMatch：query 中的空格不要求出现在原文（口语输入容错）", () => {
	const s = loadFuzzy();
	// 用户常打「重启 agent」（带空格），标题是「重启Agent」（无空格）
	const hit = s.fuzzyMatch("重启 agent", "重启Agent");
	assert.ok(hit, "带空格 query 应命中无空格标题");
	assert.deepEqual(plain(hit.indices), [0, 1, 2, 3, 4, 5, 6]);
});

test("fuzzyMatch：词首命中比词中命中得分高", () => {
	const s = loadFuzzy();
	// "ac" 在 "Agent Config" 里落在两个词首；在 "back" 里是词中
	const wordStarts = s.fuzzyMatch("ac", "Agent Config");
	const midWord = s.fuzzyMatch("ac", "back");
	assert.ok(wordStarts && midWord);
	assert.ok(wordStarts.score > midWord.score, `词首命中应更高分: ${wordStarts.score} vs ${midWord.score}`);
});

test("fuzzyMatch：连续命中比分散命中得分高", () => {
	const s = loadFuzzy();
	// 填充字符刻意用普通字母：下划线/短横线是词边界，会给分散命中额外加分，掩盖被测行为
	const contiguous = s.fuzzyMatch("set", "set xyz");
	const scattered = s.fuzzyMatch("set", "sxxexxt");
	assert.ok(contiguous && scattered);
	assert.ok(contiguous.score > scattered.score, `连续命中应更高分: ${contiguous.score} vs ${scattered.score}`);
});

// rankFuzzy 的测试随实现一起下线：排序与可见性已交给 cmdk（依据 filter 返回的分数）。
// 上面这些 fuzzyMatch 用例仍覆盖打分内核；「命中下标 → 标题高亮」的新约定落在
// CommandPalette 的 filter 里（约定 keywords[0] 必须是标题，超出标题长度的下标丢弃）。
