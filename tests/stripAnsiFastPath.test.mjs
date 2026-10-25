/**
 * stripAnsi 行为契约（2027-02 性能治理配套）。
 *
 * 流式通道把 ANSI 剥离从 per-delta 挪到 emit 开口（每 100ms 一次），依赖：
 * 1. 无 ESC 字符的文本走快速路径返回**原引用**（零分配——这是把 per-delta 全文
 *    正则扫描成本降下来的关键，回归成每次新建字符串会把治理打回原形）；
 * 2. CSI 序列照常剥离。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { stripAnsi } = loadTsCommonJs("src/main/pi/agentUtils.ts");

test("无 ESC 字符时返回原引用（零分配快速路径）", () => {
	const clean = "正常模型正文，没有任何控制序列。normal text without escapes";
	assert.equal(stripAnsi(clean), clean);
	assert.ok(stripAnsi(clean) === clean, "快速路径必须返回原字符串引用，不得新建");
	assert.ok(stripAnsi("") === "", "空串同样返回原引用");
});

test("CSI 序列照常剥离；不含 ESC 的部分保持原样", () => {
	assert.equal(stripAnsi("\u001b[31m红\u001b[0m普通"), "红普通");
	assert.equal(stripAnsi("\u001b[1;32mOK\u001b[0m done"), "OK done");
	const mixed = "前缀\u001b[2m中段\u001b[22m后缀";
	assert.equal(stripAnsi(mixed), "前缀中段后缀");
});
