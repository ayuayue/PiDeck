import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// estimateMessagesPayloadBytes：消息下发体量的近似值（2026-08 #213）。
// 用途是崩溃日志定位：#213 的日志只记了「加载 2162 条」，看不出实际是几 MB 还是几十 MB。
// 契约：量级必须准（与 JSON.stringify 的字节数同量级），且不能因为环形引用把日志打挂。

function compile(filePath) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: () => ({}),
			// messagePayloadSize 按 UTF-8 字节估体量，用到 Node 的 Buffer；
			// vm 沙箱是干净上下文，需显式注入运行时全局。
			Buffer,
		},
		{ filename: filePath },
	);
	return module.exports;
}

const { estimateMessagesPayloadBytes } = compile("src/main/pi/messagePayloadSize.ts");

function byteLengthOfJson(value) {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

test("与 JSON.stringify 的字节数同量级（±25%），足以判断 payload 体量", () => {
	const messages = Array.from({ length: 50 }, (_, index) => ({
		id: `msg-${index}`,
		role: index % 2 === 0 ? "user" : "assistant",
		content: "x".repeat(2000),
		timestamp: 1700000000000 + index,
	}));
	const actual = estimateMessagesPayloadBytes(messages);
	const expected = byteLengthOfJson(messages);
	const ratio = actual / expected;
	assert.ok(ratio > 0.75 && ratio < 1.25, `估计 ${actual} vs 实际 ${expected}（比值 ${ratio.toFixed(3)}）`);
});

test("中文按 UTF-8 字节计（不是 UTF-16 字符数）", () => {
	const messages = [{ role: "assistant", content: "中".repeat(1000) }];
	const actual = estimateMessagesPayloadBytes(messages);
	// 1000 个汉字 = 3000 字节；若按 str.length 算只会得到 ~1000
	assert.ok(actual >= 3000, `应至少计到 3000 字节，实际 ${actual}`);
});

test("嵌套工具结果（content blocks / 大载荷）计入体量", () => {
	const heavy = Array.from({ length: 20 }, (_, index) => ({
		type: "toolResult",
		toolCallId: `call-${index}`,
		content: [{ type: "text", text: "y".repeat(5000) }],
	}));
	const actual = estimateMessagesPayloadBytes(heavy);
	assert.ok(actual >= 100000, `20 × 5000 字节应计到 10 万字节以上，实际 ${actual}`);
});

test("空数组返回结构开销量级的小值（不是 0，也不夸张）", () => {
	const empty = estimateMessagesPayloadBytes([]);
	assert.ok(empty >= 0 && empty < 32, `空数组应接近 0，实际 ${empty}`);
});

test("非 JSON 字段（undefined / 函数）被忽略，不抛错", () => {
	const actual = estimateMessagesPayloadBytes([{ role: "user", content: undefined, callback: () => "ignored", flag: false }]);
	assert.ok(Number.isFinite(actual) && actual > 0);
});

test("环形引用不会无限递归（有深度上限，只影响这一条的量级）", () => {
	const cyclic = { role: "assistant", content: "z".repeat(100) };
	cyclic.self = cyclic;
	const actual = estimateMessagesPayloadBytes([cyclic]);
	assert.ok(Number.isFinite(actual), "必须返回有限值");
});
