import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { appendFile, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 会话缓存命中率统计（cacheHitStats）：latest = 最后一条 assistant 消息，
 * average = 全部 assistant 消息的平均（「当前会话平均缓存率」）。
 *
 * 2026-09 大会话闪退回归：本模块原先 `readFile(utf8)` 整读会话文件，而它挂在
 * `AgentManager.getRuntimeState` 轮询路径上。Codex 导入的 1GB 级会话会让主进程
 * 先建出几百 MB 字符串、再撞 384MB 老生代堆上限 → V8 FatalProcessOutOfMemory
 * **abort 整个主进程**（无堆栈，表现为应用闪退）。因此这里额外锁三条不变式：
 *  1. 读取器只允许流式扫描（不得出现 readFile / split 整文件）；
 *  2. 会话只追加时只扫描尾部新增内容（增量续算）；
 *  3. 文件未变化时零扫描（O(1) 复用）。
 */

/**
 * 用真实的模块图加载（而不是 require:()=>({}) 的 vm 桩）。
 * 增量续算依赖 `node:fs/promises` 的 open() 读前缀锚点，桩掉 require 会让锚点读取
 * 静默失败并退化成整扫——那样测出来的「增量」是假的，所以这里必须接通真实 fs。
 */
function loadCacheHitStats() {
	return loadTsCommonJs("src/main/pi/cacheHitStats.ts");
}

/** 构造一条 assistant 消息 JSONL；usage 缺省时不给 usage 字段 */
function assistantLine(overrides = {}) {
	const usage = overrides.usage === undefined ? { input: 100, cacheRead: 50, cacheWrite: 50 } : overrides.usage;
	return JSON.stringify({
		type: "message",
		id: `e${overrides.id ?? 1}`,
		parentId: null,
		timestamp: "2026-08-02T00:00:00.000Z",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			...(usage ? { usage } : {}),
		},
	});
}

function userLine() {
	return JSON.stringify({
		type: "message",
		id: "u1",
		parentId: null,
		message: { role: "user", content: [{ type: "text", text: "hi" }] },
	});
}

const json = (value) => JSON.stringify(value);

/**
 * 构造「行数组 → 内存 JSONL 文本」的流式扫描替身，并统计真实扫描过的字节量。
 * 完全在内存里跑，避免单测为了验证流式就必须造几百 MB 文件。
 */
function makeScanHarness(text, { withContext = true } = {}) {
	const calls = { scans: 0, bytesScanned: 0, ranges: [] };
	const scanLines = async (filePath, visitor, options = {}) => {
		calls.scans += 1;
		const start = options.start ?? 0;
		calls.ranges.push(start);
		// 允许传「文本提供者」：增量续算用例需要在两次扫描之间改内容而不重建 reader
		const body = (typeof text === "function" ? text() : text).slice(start);
		let offset = start;
		for (const piece of body.split("\n")) {
			// split 的末项对应「原文本以 \n 结尾」时的空尾，跳过
			if (piece === "" && offset >= text.length) break;
			calls.bytesScanned += Buffer.byteLength(piece);
			visitor(piece, withContext ? { offset, byteLength: Buffer.byteLength(piece), complete: true } : undefined);
			offset += Buffer.byteLength(piece) + 1;
		}
	};
	return { scanLines, calls };
}

test("computeCacheHitStats: 空文件/无样本返回 undefined", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	assert.equal(json(computeCacheHitStats("")), json({ latest: undefined, average: undefined, sampleCount: 0, conversationTokens: 0 }));
	// 只有 user 消息与无 usage 的 assistant 消息：无样本（估算仍统计）
	const noUsage = `${userLine()}\n${assistantLine({ usage: null })}\n`;
	const stats = computeCacheHitStats(noUsage);
	// "hi"、"ok" 各自向上取整 1 token（逐条取整累加），合计 2
	assert.equal(json(stats), json({ latest: undefined, average: undefined, sampleCount: 0, conversationTokens: 2 }));
});

test("computeCacheHitStats: 单条消息 latest === average", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	// cacheRead 50 / (100 + 50 + 50) = 25%
	const stats = computeCacheHitStats(assistantLine());
	assert.equal(stats.sampleCount, 1);
	assert.equal(stats.latest, 25);
	assert.equal(stats.average, 25);
});

test("computeCacheHitStats: 多条消息取平均，latest 取最后一条", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const line1 = assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } }); // 50%
	const line2 = assistantLine({ id: 2, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } }); // 0%
	const line3 = assistantLine({ id: 3, usage: { input: 100, cacheRead: 75, cacheWrite: 25 } }); // 37.5%
	// 中间夹 user 消息与坏行，不应影响统计
	const raw = [line1, userLine(), "not-json{{{", line2, userLine(), line3].join("\n");
	const stats = computeCacheHitStats(raw);
	assert.equal(stats.sampleCount, 3);
	assert.equal(stats.latest, 37.5);
	assert.equal(stats.average, (50 + 0 + 37.5) / 3);
});

test("computeCacheHitStats: 无有效 token 的 usage 跳过", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const raw = [
		assistantLine({ id: 1, usage: { input: 0, cacheRead: 0, cacheWrite: 0 } }),
		assistantLine({ id: 2, usage: { input: 100, cacheRead: 25, cacheWrite: 75 } }), // 12.5%
	].join("\n");
	const stats = computeCacheHitStats(raw);
	assert.equal(stats.sampleCount, 1);
	assert.equal(stats.latest, 12.5);
	assert.equal(stats.average, 12.5);
});

test("hitRateFromUsage: 口径为 cacheRead / (input + cacheRead + cacheWrite)", () => {
	const { hitRateFromUsage } = loadCacheHitStats();
	assert.equal(hitRateFromUsage(undefined), undefined);
	assert.equal(hitRateFromUsage({}), undefined);
	assert.equal(hitRateFromUsage({ input: 100, cacheRead: 50, cacheWrite: 50 }), 25);
});

test("computeCacheHitStats: conversationTokens 统计消息文本（CJK 加权，含裸 text 字段与坏行容忍）", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	// assistantLine 的 content 是 [{type:"text",text:"ok"}]（2 字符），userLine 是 "hi"（2 字符）
	const raw = [
		assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } }),
		userLine(),
		// 兼容裸 text 字段消息（content 数组缺失时按 text 计数）
		JSON.stringify({ type: "message", id: "u2", parentId: null, message: { role: "user", text: "hello 世界" } }),
		"not-json{{{",
	].join("\n");
	const stats = computeCacheHitStats(raw);
	// 非中文字符 12 个（ok+hi+"hello "）÷4 = 3，中文 2 字 ÷1.5 ≈ 1.33，向上取整 = 5；坏行不计数不中断
	assert.equal(stats.conversationTokens, 5);
	assert.equal(stats.sampleCount, 1);
});

test("computeCacheHitStats: compaction 行重置纪元（对话估算与命中率样本归零重计）", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const compaction = JSON.stringify({
		type: "compaction",
		id: "c1",
		timestamp: "2026-10-01T00:00:00.000Z",
		firstKeptEntryId: "m2",
		tokensBefore: 50_000,
		summary: "前情摘要：修复了圆环指标",
	});
	const raw = [
		assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } }), // 50%，归档
		userLine(),
		compaction,
		// 压缩后的新纪元：只有这条 assistant 计入样本
		assistantLine({ id: 3, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } }), // 0%
	].join("\n");
	const stats = computeCacheHitStats(raw);
	assert.equal(stats.sampleCount, 1);
	assert.equal(stats.latest, 0);
	assert.equal(stats.average, 0);
	// 压缩摘要「前情摘要：修复了圆环指标」= 12 个 CJK 字符 → 12/1.5 = 8；新纪元 "ok"（2 字符）→ 1；合计 9；归档的 userLine("hi") 不再计入
	assert.equal(stats.conversationTokens, 9);
});

test("computeCacheHitStats: 系统消息重放为提示词装载（系统/工具两段），且不计入对话估算", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const systemLine = JSON.stringify({
		type: "message",
		id: "s1",
		parentId: null,
		message: { role: "system", content: "", sections: { preamble: "abcd", rules: "中文规则" }, toolsAdded: [{ name: "read", description: "read files here" }] },
	});
	const stats = computeCacheHitStats([systemLine, userLine()].join("\n"));
	// 系统段 1（abcd）+ 3（中文规则）；工具段来自声明 JSON，必须 > 0
	assert.equal(stats.systemTokens, 4);
	assert.ok(stats.toolsTokens > 0);
	// 系统消息的正文在 sections 里（对话估算不得重复计量）：只剩 userLine 的 "hi" → 1
	assert.equal(stats.conversationTokens, 1);
});

test("computeCacheHitStats: 无系统消息的老会话不给出系统/工具测量值", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const stats = computeCacheHitStats([assistantLine({ id: 1 }), userLine()].join("\n"));
	// 两段都缺失 = 无测量值：调用方据此退回「总占用 − 对话估算」口径，而不是当成 0
	assert.equal(stats.systemTokens, undefined);
	assert.equal(stats.toolsTokens, undefined);
});

test("computeCacheHitStats: 系统消息只做了删除补丁（装载空）时也不给出 0/0 测量值", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const removeOnly = JSON.stringify({ type: "message", id: "s2", parentId: null, message: { role: "system", content: "", sections: { preamble: null } } });
	const stats = computeCacheHitStats([removeOnly, userLine()].join("\n"));
	assert.equal(stats.systemTokens, undefined, "空装载不能当成「系统为 0」（那只是把所有常驻开销推给对话段）");
	assert.equal(stats.toolsTokens, undefined);
});

test("computeCacheHitStats: compaction 快照整体替换装载（不叠加旧节、不保留旧工具）", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const raw = [
		JSON.stringify({ type: "message", id: "s1", parentId: null, message: { role: "system", content: "", sections: { preamble: "old section" }, toolsAdded: [{ name: "old-tool", description: "zzzz" }] } }),
		JSON.stringify({
			type: "compaction",
			id: "c1",
			parentId: "s1",
			summary: "摘要",
			firstKeptEntryId: "s1",
			systemMessage: { role: "system", content: "", sections: { preamble: "new section" }, toolsAdded: [{ name: "read", description: "read" }] },
		}),
	].join("\n");
	const stats = computeCacheHitStats(raw);
	assert.equal(stats.systemTokens, 3); // "new section" 11 字符 ÷4 → 3（旧的 old section 已随快照丢弃）
	assert.ok(stats.toolsTokens > 0);
});

test("computeCacheHitStats: 工具调用参数与工具结果计入对话估算", () => {
	const { computeCacheHitStats } = loadCacheHitStats();
	const toolCallLine = JSON.stringify({
		type: "message",
		id: "a1",
		parentId: null,
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/some/path" } }],
			usage: { input: 100, cacheRead: 0, cacheWrite: 100 },
		},
	});
	const toolResultLine = JSON.stringify({
		type: "message",
		id: "r1",
		parentId: "a1",
		message: { role: "toolResult", content: "command output here", details: { exitCode: 0 } },
	});
	const stats = computeCacheHitStats(`${toolCallLine}\n${toolResultLine}`);
	// 无 text 时估算完全来自工具参数/结果文本，必须 > 0
	assert.ok(stats.conversationTokens > 0);
});

// ── 流式读取器（大会话闪退修复的核心）──

test("createCacheHitStatsReader: 通过流式扫描统计，且口径与内存版一致", async () => {
	const { createCacheHitStatsReader, computeCacheHitStats } = loadCacheHitStats();
	const text = [assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } }), userLine(), assistantLine({ id: 2, usage: { input: 100, cacheRead: 25, cacheWrite: 75 } })].join("\n");
	const { scanLines, calls } = makeScanHarness(text);
	const reader = createCacheHitStatsReader({
		scanLines,
		stat: async () => ({ size: text.length, mtimeMs: 1 }),
	});
	const stats = await reader("s1.jsonl");
	assert.equal(calls.scans, 1);
	assert.deepEqual(stats, computeCacheHitStats(text));
	assert.equal(stats.sampleCount, 2);
	assert.equal(stats.latest, 12.5);
});

test("createCacheHitStatsReader: 源文件不含 readFile 整读（大会话闪退守卫）", () => {
	// 先剥掉注释与字符串字面量再断言：文档里会提到 readFile 这个反例，
	// 直接对原文做正则会把「解释为什么不能用它」的注释误判成回归。
	const source = readFileSync("src/main/pi/cacheHitStats.ts", "utf8")
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/"(?:[^"\\]|\\.)*"/g, '""');
	// 本模块保持零 IO（只接收注入的 scanLines），因此自己不应 import fs
	assert.doesNotMatch(source, /readFile\s*\(/, "命中率统计不得整读会话文件（1GB 会话会让主进程 abort）");
	assert.doesNotMatch(source, /from\s+"node:fs\/promises"/, "读取器应通过注入的 scanLines 读盘，而不是自己读 fs");

	// 生产接线在 AgentManager：必须注入流式扫描（scanJsonlLines），不得注入 readFile。
	// 这是本修复的关键回归点——旧接线就是 `readFile: (path) => readFile(path, "utf8")`。
	const agentManager = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(agentManager, /scanLines:\s*async/, "AgentManager 必须向命中率读取器注入流式扫描");
	assert.match(agentManager, /scanJsonlLines\(filePath, visitor\)/, "注入的扫描必须是 scanJsonlLines");
});

test("createCacheHitStatsReader: 文件未变化时零扫描（高频轮询主路径）", async () => {
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const text = assistantLine();
	const { scanLines, calls } = makeScanHarness(text);
	const reader = createCacheHitStatsReader({
		scanLines,
		stat: async () => ({ size: text.length, mtimeMs: 1000 }),
	});
	const first = await reader("s1.jsonl");
	const second = await reader("s1.jsonl");
	assert.equal(calls.scans, 1, "文件未变化时不应再次扫描");
	assert.equal(first.average, 25);
	assert.equal(second.average, 25);
});

test("createCacheHitStatsReader: 只追加时仅扫描尾部新增内容（不重扫整个大会话）", async () => {
	// 用真实文件 + 真实流式扫描器：增量续算依赖 (a) 扫描器返回的行上下文
	// (b) 前缀锚点比对，两者都必须在真盘上验证（内存替身证明不了「只扫尾部」）。
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const { scanJsonlLines } = loadTsCommonJs("src/main/sessions/jsonlLineStream.ts");

	let scannedBytes = 0;
	const reader = createCacheHitStatsReader({
		scanLines: async (filePath, visitor, options = {}) => {
			const summary = await scanJsonlLines(filePath, visitor, options);
			scannedBytes = summary.bytesScanned;
		},
		stat,
	});

	const dir = await mkdtemp(join(tmpdir(), "pideck-cachehit-"));
	const file = join(dir, "s.jsonl");
	try {
		// 先写一段「大前缀」，模拟 1GB 会话里已扫过的部分
		const head = `${assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } })}\n`;
		await writeFile(file, head + "\n".repeat(1000));

		const first = await reader(file);
		assert.equal(first.sampleCount, 1);
		assert.equal(first.latest, 50);

		// pi 追加一条 assistant（0%）：应只扫新增字节，而不是重扫整个文件
		await appendFile(file, `${assistantLine({ id: 2, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } })}\n`);

		const second = await reader(file);
		assert.equal(second.sampleCount, 2, "增量续算后应含新增样本");
		assert.equal(second.latest, 0, "latest 应更新为新追加的那条");
		assert.equal(second.average, 25, "增量结果需与整扫口径一致（50 与 0 的平均）");
		assert.ok(scannedBytes < 4096, `只应扫描尾部新增内容（实际扫了 ${scannedBytes} 字节；退回整扫即大会话性能回归）`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("createCacheHitStatsReader: 增量续算保留提示词装载（系统消息只在文件头部也不丢）", async () => {
	// 系统消息条目通常只在头部（首请求）与提示词变化处出现，续扫只读尾部；
	// 装载状态必须随累加器一起缓存，否则每次轮询都会把「系统 / 工具」两段丢成无测量值。
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const systemLine = JSON.stringify({ type: "message", id: "s1", parentId: null, message: { role: "system", content: "", sections: { preamble: "abcd" }, toolsAdded: [{ name: "read", description: "read files here" }] } });
	let text = [systemLine, assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } })].join("\n");
	const { scanLines, calls } = makeScanHarness(() => text);
	const reader = createCacheHitStatsReader({ scanLines, stat: async () => ({ size: Buffer.byteLength(text, "utf8"), mtimeMs: calls.scans }) });

	const first = await reader("s1.jsonl");
	assert.equal(first.systemTokens, 1);
	assert.ok(first.toolsTokens > 0);

	// 追加一条消息（文件变大 → 走增量续算）：装载仍在，对话估算累加
	text = `${text}\n${assistantLine({ id: 2, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } })}`;
	const second = await reader("s1.jsonl");
	assert.equal(calls.scans, 2);
	assert.equal(second.systemTokens, first.systemTokens, "续扫不得丢失头部系统消息的装载");
	assert.equal(second.toolsTokens, first.toolsTokens);
	assert.equal(second.conversationTokens, 2, "续扫把新增消息累加进对话估算（ok ×2）");
});

test("createCacheHitStatsReader: 前缀被改写（rename/头部修复重写文件）时放弃续算重扫", async () => {
	// 关键正确性：rename 与头部修复走 rewriteJsonlLines —— 流式重写整文件后原子改名。
	// 这种文件同样会「变大」，但前缀已经换了样本，若只按 size 判断追加就会算错。
	// 锚点比对必须拦住它。
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const { scanJsonlLines } = loadTsCommonJs("src/main/sessions/jsonlLineStream.ts");
	const reader = createCacheHitStatsReader({
		scanLines: (filePath, visitor, options = {}) => scanJsonlLines(filePath, visitor, options),
		stat,
	});

	const dir = await mkdtemp(join(tmpdir(), "pideck-cachehit-rewrite-"));
	const file = join(dir, "s.jsonl");
	try {
		await writeFile(
			file,
			`${assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } })}
`,
		);
		const first = await reader(file);
		assert.equal(first.sampleCount, 1);

		// 重写成「新前缀 + 更多内容」，且比原文件更长（模拟 rename 后的产物）
		await writeFile(
			file,
			[
				assistantLine({ id: 9, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } }), // 0%
				assistantLine({ id: 10, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } }), // 0%
			].join("\n") + "\n",
		);

		const second = await reader(file);
		assert.equal(second.sampleCount, 2, "必须重扫新前缀（旧样本不得残留）");
		assert.equal(second.average, 0, "全部来自新文件：两条都是 0%");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("createCacheHitStatsReader: 文件变小（重写/换文件）时整扫重来", async () => {
	const { createCacheHitStatsReader } = loadCacheHitStats();
	let text = [assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } }), assistantLine({ id: 2, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } })].join("\n");
	const scan = (filePath, visitor, options = {}) => makeScanHarness(text).scanLines(filePath, visitor, options);
	let size = Buffer.byteLength(text, "utf8");
	const reader = createCacheHitStatsReader({
		scanLines: scan,
		stat: async () => ({ size, mtimeMs: size }),
	});

	const first = await reader("s1.jsonl");
	assert.equal(first.sampleCount, 2);

	// 会话被修剪/替换成更小的文件：不能沿用旧累加器
	text = assistantLine({ id: 3, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } }); // 0%
	size = Buffer.byteLength(text, "utf8");
	const second = await reader("s1.jsonl");
	assert.equal(second.sampleCount, 1, "旧样本必须丢弃，不能累加到新文件上");
	assert.equal(second.average, 0);
});

test("createCacheHitStatsReader: 末尾残行不计入已消费，下次重扫该行", async () => {
	// 用真实文件 + 真实扫描器：残行语义靠 scanJsonlLines 的 complete 标记，
	// 内存替身自己构造 complete 等于把待测逻辑写进替身（测了也白测）。
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const { scanJsonlLines } = loadTsCommonJs("src/main/sessions/jsonlLineStream.ts");

	const completeLine = assistantLine({ id: 1, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } });
	// 末尾是「被截断的一行」（pi 正在写）：无结尾换行 → complete=false。
	// 截断的必须是真实行本身的前缀：pi 写完时补上剩下部分 + 换行，
	// 而不是另起一行（后者会拼成非法 JSON，不反映真实写入方式）。
	const secondLine = assistantLine({ id: 2, usage: { input: 100, cacheRead: 0, cacheWrite: 100 } }); // 0%
	const truncated = secondLine.slice(0, 30);
	const starts = [];
	const reader = createCacheHitStatsReader({
		scanLines: async (filePath, visitor, options = {}) => {
			starts.push(options.start ?? 0);
			await scanJsonlLines(filePath, visitor, options);
		},
		stat,
	});

	const dir = await mkdtemp(join(tmpdir(), "pideck-cachehit-partial-"));
	const file = join(dir, "s.jsonl");
	try {
		await writeFile(file, `${completeLine}\n${truncated}`);
		const first = await reader(file);
		assert.equal(first.sampleCount, 1);
		assert.equal(first.conversationTokens, 1); // 只有完整行的 "ok"（2 字符→1 token），残行不算

		// 那一行写完了：补上剩余部分 + 换行，成为一个完整合法的 assistant 行
		await appendFile(file, `${secondLine.slice(truncated.length)}\n`);
		const second = await reader(file);
		assert.equal(second.sampleCount, 2, "补全的残行必须被统计到");
		assert.equal(second.latest, 0);
		// 续扫起点应落在第一行之后（不重扫已消费的完整行）
		assert.ok(starts[1] >= Buffer.byteLength(completeLine, "utf8"), `续扫应跳过已消费的完整行（实际从 ${starts[1]} 起）`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("createCacheHitStatsReader: 不同会话各自缓存互不干扰", async () => {
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const contents = new Map([
		["a.jsonl", assistantLine({ id: 1, usage: { input: 100, cacheRead: 50, cacheWrite: 50 } })],
		["b.jsonl", assistantLine({ id: 2, usage: { input: 100, cacheRead: 100, cacheWrite: 0 } })],
	]);
	const scan = (filePath, visitor, options = {}) => makeScanHarness(contents.get(filePath) ?? "").scanLines(filePath, visitor, options);
	const reader = createCacheHitStatsReader({
		scanLines: scan,
		stat: async (p) => ({ size: Buffer.byteLength(contents.get(p) ?? ""), mtimeMs: 1 }),
	});
	const a = await reader("a.jsonl");
	const b = await reader("b.jsonl");
	const a2 = await reader("a.jsonl"); // 命中缓存
	assert.equal(a.average, 25);
	assert.equal(b.average, 50);
	assert.equal(a2.average, 25);
});

test("createCacheHitStatsReader: 文件不可读返回空统计且不缓存", async () => {
	const { createCacheHitStatsReader } = loadCacheHitStats();
	const { scanLines } = makeScanHarness("");
	const reader = createCacheHitStatsReader({
		scanLines,
		stat: async () => {
			throw new Error("ENOENT");
		},
	});
	const result = await reader("missing.jsonl");
	assert.equal(result.sampleCount, 0);
	assert.equal(result.average, undefined);
});

test("createCacheHitStatsReader: 不设解析超时（超时+不写缓存 = 每次轮询重扫大会话）", () => {
	const source = readFileSync("src/main/pi/cacheHitStats.ts", "utf8");
	assert.doesNotMatch(source, /timeoutMs/, "解析超时会让 1GB 会话每次轮询都从 0 重扫，比慢更糟");
	// 不阻塞主线程靠 scanJsonlLines 的分块 + 让出事件循环，而不是靠放弃解析
	assert.match(source, /scanRange/);
});

// ── 类型与接线契约 ──

test("AgentRuntimeState 携带平均命中率与样本数字段", () => {
	const source = readFileSync("src/shared/types/agent.ts", "utf8");
	assert.match(source, /cacheHitAveragePercent\?: number \| null/);
	assert.match(source, /cacheHitSampleCount\?: number/);
});

test("AgentManager getRuntimeState 返回平均命中率，且接线到流式扫描", () => {
	const source = readFileSync("src/main/pi/AgentManager.ts", "utf8");
	assert.match(source, /getSessionCacheHitStats/);
	assert.match(source, /cacheHitAveragePercent/);
	assert.match(source, /cacheHitSampleCount: fileHitStats\.sampleCount/);
	// 旧的「只读最后一条」实现已移除
	assert.doesNotMatch(source, /getLatestCacheMessageHitRate/);
	// 关键回归守卫：命中率读取器不得再整读会话文件（1GB 会话会 abort 主进程）
	assert.match(source, /scanLines:\s*async/);
	assert.doesNotMatch(source, /readFile:\s*\(path\)\s*=>\s*readFile\(path, "utf8"\)/);
});

test("SessionStatus 优先使用主进程平均，快照历史仅作回退", () => {
	const source = readFileSync("src/renderer/src/components/session/SurfaceComponents.tsx", "utf8");
	assert.match(source, /state\.cacheHitAveragePercent/);
	assert.match(source, /cacheHitSampleCount/);
});
