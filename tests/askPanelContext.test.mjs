import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 并行问询上下文块构建纯逻辑测试（src/renderer/src/utils/askPanelContext.ts）。
 * 该模块无依赖，直接 transpile + vm 运行，无需 stub。
 */
function loadContext() {
	const source = readFileSync("src/renderer/src/utils/askPanelContext.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
		fileName: "askPanelContext.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, console }, { filename: "askPanelContext.ts" });
	return module.exports;
}

const c = loadContext();

test("empty input returns null (no context to carry)", () => {
	assert.equal(c.buildAskContextBlock([]), null);
	assert.equal(c.buildAskContextBlock(null), null);
});

test("only user/assistant non-empty text is collected", () => {
	const messages = [
		{ role: "system", text: "ignored system" },
		{ role: "user", text: "hi" },
		{ role: "assistant", text: "hello" },
		{ role: "user", text: "   " }, // 空白正文跳过
	];
	const block = c.buildAskContextBlock(messages);
	assert.ok(block.includes("用户：hi"));
	assert.ok(block.includes("助手：hello"));
	assert.ok(!block.includes("ignored system"));
});

test("keeps only the newest maxMessages entries", () => {
	const messages = Array.from({ length: 20 }, (_, i) => ({
		role: i % 2 === 0 ? "user" : "assistant",
		text: `msg-${i}`,
	}));
	const block = c.buildAskContextBlock(messages, { maxMessages: 5 });
	// 旧→新顺序，最新的 5 条是 msg-15..msg-19
	assert.ok(!block.includes("msg-0"));
	assert.ok(block.includes("msg-15"));
	assert.ok(block.includes("msg-19"));
	// 顺序检查：后面的行序不会乱
	assert.ok(block.indexOf("msg-15") < block.indexOf("msg-19"));
});

test("truncates from the oldest when over maxChars", () => {
	const messages = Array.from({ length: 20 }, (_, i) => ({
		role: "user",
		text: `x`.repeat(500), // 每条 500 字符
	}));
	const block = c.buildAskContextBlock(messages, { maxChars: 1200 });
	// 1200 容得下 2 条完整（2*500+前缀），第 3 条起全被丢掉
	const lines = block.split("\n");
	assert.ok(lines.length <= 2, `expected ≤2 lines, got ${lines.length}`);
	assert.ok(!block.includes("x".repeat(1500)));
});

test("a single oversized message is truncated in place", () => {
	const messages = [{ role: "user", text: "y".repeat(5000) }];
	const block = c.buildAskContextBlock(messages, { maxChars: 300 });
	// 单行截断保留 200 字符 + 省略号
	assert.ok(block.includes("…"));
	assert.ok(block.startsWith("用户："));
	assert.ok(block.length < 250);
});

test("title is prepended when provided", () => {
	const block = c.buildAskContextBlock([{ role: "user", text: "hi" }], { title: "上下文" });
	assert.ok(block.startsWith("上下文\n"));
});

test("custom role labels are honored", () => {
	const block = c.buildAskContextBlock(
		[
			{ role: "user", text: "hi" },
			{ role: "assistant", text: "yo" },
		],
		{ userLabel: "U", assistantLabel: "A" },
	);
	assert.ok(block.includes("U：hi"));
	assert.ok(block.includes("A：yo"));
});
