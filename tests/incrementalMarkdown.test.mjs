import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function loadModule() {
	const source = readFileSync("src/renderer/src/components/session/markdown/incrementalMarkdown.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = { exports: {}, module: { exports: {} } };
	sandbox.module.exports = sandbox.exports;
	vm.runInNewContext(outputText, sandbox, { filename: "incrementalMarkdown.ts" });
	return sandbox.exports;
}

test("appending a paragraph only grows the unstable tail; earlier blocks stay frozen", () => {
	const { IncrementalMarkdownFrontier } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	// 4 个内容块：UNSTABLE_TAIL_BLOCKS=1 → 冻住前 3 个，只有最后一段留在 tail。
	const first = frontier.update("# Title\n\nHello world.\n\nSecond para.\n\nMore text");
	assert.ok(first.prefix.includes("# Title"));
	assert.ok(first.prefix.includes("Hello world."));
	assert.ok(first.prefix.includes("Second para."));
	assert.match(first.tail, /More text/);
	assert.doesNotMatch(first.tail, /Second para/);
	assert.equal(first.generation, 0);

	const second = frontier.update("# Title\n\nHello world.\n\nSecond para.\n\nMore text continues");
	assert.equal(second.prefix, first.prefix);
	assert.match(second.tail, /More text continues/);
	assert.equal(second.generation, 0);
});

test("an open fence is never frozen into the prefix", () => {
	const { IncrementalMarkdownFrontier } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	// 足够多的稳定块 + 未闭合围栏：围栏必须整段落在 tail。
	const split = frontier.update("# Intro\n\nHello world.\n\nSecond para.\n\n```ts\nconst x = 1;\n");
	assert.ok(split.prefix.includes("# Intro"));
	assert.match(split.tail, /```ts/);
	assert.doesNotMatch(split.prefix, /```ts/);
});

test("non-append input bumps generation so callers drop frozen nodes", () => {
	const { IncrementalMarkdownFrontier } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	const first = frontier.update("alpha\n\nbeta\n\ngamma");
	const second = frontier.update("totally different");
	assert.equal(first.generation, 0);
	assert.equal(second.generation, 1);
	assert.equal(second.prefixEnd, 0);
});

test("shrink to a prefix does not bump generation", () => {
	const { IncrementalMarkdownFrontier } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	const first = frontier.update("alpha\n\nbeta\n\ngamma");
	const second = frontier.update("alpha");
	assert.equal(first.generation, 0);
	assert.equal(second.generation, 0);
});

test("identical input is idempotent", () => {
	const { IncrementalMarkdownFrontier } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	const text = "# A\n\npara one\n\npara two";
	const first = frontier.update(text);
	const second = frontier.update(text);
	assert.equal(first, second);
});

test("prefix grows when the frozen boundary moves forward (cache must reslice)", () => {
	const { IncrementalMarkdownFrontier } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	// 首帧：3 个内容块，冻住前 2 个（"# Title" + "Hello world."），tail 含 "Second para."。
	const first = frontier.update("# Title\n\nHello world.\n\nSecond para.");
	// 追加两个新块后 "Second para." 也稳定下来 → 冻结边界前移，prefix 必须重切片变长
	// （防回归：frontier 在边界未动时复用 prefix 字符串对象，边界动了必须重新 slice）。
	const second = frontier.update("# Title\n\nHello world.\n\nSecond para.\n\nThird para.\n\nFourth para.");
	assert.ok(second.prefixEnd > first.prefixEnd);
	assert.ok(second.prefix.startsWith(first.prefix));
	assert.ok(second.prefix.includes("Second para."));
	assert.ok(second.prefix.includes("Third para."));
	// tail 只保留最后一个内容块
	assert.match(second.tail, /Fourth para/);
	assert.doesNotMatch(second.tail, /Third para/);
	// 边界稳定后继续追加（段内追加，内容块数不变）：prefix 内容保持不变
	const third = frontier.update("# Title\n\nHello world.\n\nSecond para.\n\nThird para.\n\nFourth para. continues");
	assert.equal(third.prefix, second.prefix);
	assert.equal(third.prefixEnd, second.prefixEnd);
});

test("closed code fence freezes into prefix once the next block starts", () => {
	const { IncrementalMarkdownFrontier } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	// 单个闭合围栏：只有 1 个内容块，暂不可冻结（整段在 tail）
	const first = frontier.update("```ts\nconst a = 1;\n```");
	assert.equal(first.prefixEnd, 0);
	assert.match(first.tail, /```ts/);
	// 后续段落到达：围栏稳定，冻进 prefix，tail 只留新段落（防大围栏滞留尾部每帧重解析）
	const second = frontier.update("```ts\nconst a = 1;\n```\n\nExplanation follows.");
	assert.ok(second.prefix.includes("```ts"));
	assert.ok(second.prefix.includes("const a = 1;"));
	assert.match(second.tail, /Explanation follows/);
	assert.doesNotMatch(second.tail, /```/);
});

test("setext heading retroactively merges the preceding paragraph (incremental rescan re-derives it)", () => {
	const { IncrementalMarkdownFrontier } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	// 先形成 3 个内容块：前 2 块冻结、tail 是最后一段
	const first = frontier.update("para one\n\npara two\n\npara three");
	assert.ok(first.prefix.includes("para one"));
	// 追加 setext 下划线（===，--- 会被判成分隔线）：最后一段并入标题块
	// （追溯只影响最后一块，增量重扫必须捕获：冻结边界不得前移）
	const second = frontier.update("para one\n\npara two\n\npara three\n===");
	assert.equal(second.generation, 0);
	assert.equal(second.prefixEnd, first.prefixEnd);
	assert.equal(second.prefix, first.prefix);
	assert.match(second.tail, /para three/);
	assert.match(second.tail, /===/);
});

test("incremental rescan is identical to full rescan across append sequences (property test)", () => {
	const { IncrementalMarkdownFrontier, resolveFrozenPrefixEnd } = loadModule();

	// 流式追加语料：段落/标题/列表/围栏/引用/空行混合，模拟 AI 长回答
	const chunks = [
		"# Title one\n\n",
		"Some paragraph text with `inline code` and **bold**.\n\n",
		"- item one\n- item two\n- item three\n\n",
		"> quote line one\n> quote line two\n\n",
		"```ts\nconst x = 1;\nfunction f() { return x; }\n```\n\n",
		"Another paragraph explaining the code above, with more words to make it longer.\n\n",
		"1. numbered one\n2. numbered two\n\n",
		"```ts\nconst y = 2;\n```\n\n",
		"Final paragraph before an open fence.\n\n",
		"```python\nprint('hello')\nprint('world')\n",
		"  indented continuation?\n\n",
		"# Second heading\n\n",
		"Text after heading.\n",
		"---\n\n",
		"setext heading below\n===\n\n",
		"```\nunclosed fence keeps growing\nmore lines\n",
		"and even more\n",
	];
	const makeRng = (seed) => () => {
		// 简单确定性 PRNG（mulberry32）
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};

	for (let seed = 1; seed <= 5; seed += 1) {
		const rand = makeRng(seed * 7919);
		const frontier = new IncrementalMarkdownFrontier();
		let text = "";
		// 每次测试随机挑选 8~20 个 chunk 追加（含重复/乱序，模拟真实输出节奏）
		const count = 8 + Math.floor(rand() * 13);
		for (let i = 0; i < count; i += 1) {
			const chunk = chunks[Math.floor(rand() * chunks.length)];
			text += chunk;
			const split = frontier.update(text);
			const expected = resolveFrozenPrefixEnd(text);
			assert.equal(split.prefixEnd, expected.prefixEnd, `seed=${seed} step=${i}: prefixEnd mismatch for text:\n${text}`);
			assert.equal(split.prefix, text.slice(0, expected.prefixEnd), `seed=${seed} step=${i}: prefix mismatch`);
			assert.equal(split.tail, text.slice(expected.prefixEnd), `seed=${seed} step=${i}: tail mismatch`);
			assert.equal(split.generation, 0, `seed=${seed} step=${i}: generation must stay 0 on append`);
		}
	}
});

test("incremental rescan recovers from non-append replacement", () => {
	const { IncrementalMarkdownFrontier, resolveFrozenPrefixEnd } = loadModule();
	const frontier = new IncrementalMarkdownFrontier();
	frontier.update("# A\n\npara one\n\npara two");
	// 非 append：整段替换 + 追加继续，结果必须与全量重扫一致
	frontier.update("completely different content\n\nsecond para");
	const after = frontier.update("completely different content\n\nsecond para\n\nthird para");
	const expected = resolveFrozenPrefixEnd("completely different content\n\nsecond para\n\nthird para");
	assert.equal(after.prefixEnd, expected.prefixEnd);
	assert.equal(after.prefix, "completely different content\n\nsecond para\n\nthird para".slice(0, expected.prefixEnd));
	assert.equal(after.generation, 1);
});

test("MarkdownStream streams through frozen prefix + tail split", () => {
	const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
	assert.match(stream, /IncrementalMarkdownFrontier/);
	assert.match(stream, /FrozenMarkdownChunk/);
	assert.match(stream, /UNSTABLE_TAIL_BLOCKS/);
	assert.match(stream, /data-md-frozen/);
});

test("MarkdownStream keeps streaming plugin arrays as stable module references", () => {
	// 防回归：流式精简插件若内联 []（每帧新引用），pipe 的 useMemo 依赖随之变化
	// → pipe 每帧重建 → FrozenMarkdownChunk 的 memo 比较 props.pipe 引用变化
	// → 冻结 prefix 每帧全量重解析（掉帧/抖动/GC 压力的根源）。
	const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
	assert.match(stream, /NO_STREAM_REMARK_PLUGINS/);
	assert.match(stream, /NO_STREAM_REHYPE_PLUGINS/);
	// 流式分支必须引用常量，不得内联新数组
	assert.match(stream, /isStreamingNow\s*\?\s*NO_STREAM_REMARK_PLUGINS/);
	assert.match(stream, /isStreamingNow\s*\?\s*NO_STREAM_REHYPE_PLUGINS/);
	assert.doesNotMatch(stream, /isStreamingNow\s*\?\s*\[\]/);
});

test("MarkdownStream plain fallback splits into frozen + live spans (split-plain)", () => {
	// 防回归：纯文本兜底路径必须拆分冻结/活动两段，防止大文本每次内容到达
	// 整体替换文本节点导致 layout O(n) 每帧重排（IPC 积压 → 原生内存爬升的根源之一）。
	const stream = readFileSync("src/renderer/src/components/session/MarkdownStream.tsx", "utf8");
	assert.match(stream, /PlainStreamSplit/);
	assert.match(stream, /data-md-plain-frozen/);
	assert.match(stream, /data-md-plain-live/);
	assert.match(stream, /PLAIN_SPLIT_STEP/);
});
