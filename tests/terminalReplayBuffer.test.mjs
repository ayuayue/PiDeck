/**
 * 终端回放缓冲（分段存储）单元测试。
 *
 * 契约（见 terminalReplayBuffer.ts 头注释）：
 * 1. 追加是 O(1) 摊还——上限附近不再每个 chunk 都整段拷贝；
 * 2. 总长有界（<= MAX + 最老一段），封顶常驻内存的目的不变；
 * 3. join 出的回放文本尾部与全量拼接结果一致（重建 xterm 不能丢最近内容）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { appendTerminalReplay, createTerminalReplayBuffer, terminalReplayText, MAX_TERMINAL_REPLAY_BUFFER } = loadTsCommonJs("src/main/terminal/terminalReplayBuffer.ts");

test("常量与初始状态", () => {
	assert.equal(MAX_TERMINAL_REPLAY_BUFFER, 200_000);
	const buffer = createTerminalReplayBuffer();
	assert.equal(buffer.length, 0);
	assert.equal(terminalReplayText(buffer), "");
});

test("未达上限时原样保留（顺序不变）", () => {
	const buffer = createTerminalReplayBuffer();
	appendTerminalReplay(buffer, "ab");
	appendTerminalReplay(buffer, "");
	appendTerminalReplay(buffer, "cd");
	assert.equal(terminalReplayText(buffer), "abcd");
	assert.equal(buffer.length, 4);
});

test("超限后丢整段头部，回放文本尾部与全量拼接一致", () => {
	const buffer = createTerminalReplayBuffer();
	const full = [];
	// 30K 段 × ~11 字符 ≈ 330K，确保跨过 200K 上限（5000 段只有 55K，触发不了丢头部）
	for (let index = 0; index < 30_000; index += 1) {
		const chunk = `chunk-${index};`;
		full.push(chunk);
		appendTerminalReplay(buffer, chunk);
	}
	const text = terminalReplayText(buffer);
	const expected = full.join("");
	// 上界：MAX + 当前最老一段（压实后最老段可能是合并 blob，按实际值断言；
	// 丢头部的前提是丢完后仍有 >= MAX 的内容，所以总长不可能超过 MAX + 最老段）
	assert.ok(text.length <= MAX_TERMINAL_REPLAY_BUFFER + (buffer.chunks[0]?.length ?? 0), "总长不得超过上限+最老一段");
	assert.ok(text.length >= MAX_TERMINAL_REPLAY_BUFFER, "不应丢掉还有效的近期内容");
	// 尾部一致性：回放必须与全量拼接的尾部完全一致（重建 scrollback 不能错位）
	assert.equal(text, expected.slice(expected.length - text.length));
});

test("分段数有界：大 chunk 靠丢头部收敛，微小 chunk 靠压实收敛", () => {
	// 大 chunk：丢整段头部即可收敛
	const big = createTerminalReplayBuffer();
	for (let index = 0; index < 20_000; index += 1) {
		appendTerminalReplay(big, "0123456789");
	}
	assert.ok(big.chunks.length < 2500, `分段数应收敛，实际 ${big.chunks.length}`);
	assert.ok(big.length <= MAX_TERMINAL_REPLAY_BUFFER + 10);

	// 交互式微小 chunk（每键 1 字符、总量远未达字符上限）：分段数靠压实收敛，
	// 否则每段一个字符串对象的开销会随会话寿命线性增长（长跑终端 10 万键 = 10 万段）
	const tiny = createTerminalReplayBuffer();
	for (let index = 0; index < 100_000; index += 1) {
		appendTerminalReplay(tiny, "x");
	}
	assert.ok(tiny.chunks.length <= 600, `微小 chunk 分段数应被压实收敛，实际 ${tiny.chunks.length}`);
	assert.equal(tiny.length, 100_000, "字符总量未达上限，不得丢内容");
	const text = terminalReplayText(tiny);
	assert.equal(text, "x".repeat(100_000), "压实不得改变内容");
});

test("单个超大 chunk（大于上限）退化为一次尾部截断，行为与旧实现一致", () => {
	const buffer = createTerminalReplayBuffer();
	appendTerminalReplay(buffer, "a".repeat(MAX_TERMINAL_REPLAY_BUFFER + 50_000));
	assert.equal(buffer.length, MAX_TERMINAL_REPLAY_BUFFER);
	assert.equal(terminalReplayText(buffer).length, MAX_TERMINAL_REPLAY_BUFFER);
	// 之后再追加小段：回到分段路径，尾部完整
	appendTerminalReplay(buffer, "TAIL");
	assert.ok(terminalReplayText(buffer).endsWith("TAIL"));
	assert.ok(buffer.length <= MAX_TERMINAL_REPLAY_BUFFER + 10);
});
