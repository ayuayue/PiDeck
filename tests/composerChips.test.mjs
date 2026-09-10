import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** vm 跨 realm 时 deepEqual 会因原型不同误报，统一 JSON 比较。 */
function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

// chips.ts 现在依赖 ./quoteChip，改用共享 helper 加载完整依赖图
function loadChips() {
	return loadTsCommonJs("src/renderer/src/components/session/composer/chips.ts");
}

const {
	parseRichInputChips,
	formatFilePathRef,
	unwrapFileChipPath,
	isDirectoryFileChip,
	formatChipDisplayLabel,
	stripChipDisplayPrefix,
	extractPastedPath,
} = loadChips();

test("formatChipDisplayLabel reproduces the original text (prefixes kept)", () => {
	// 展示即原文：file/skill/session 都要把用户输入的前缀拼回去，
	// 否则气泡里看到的字与发出去的字不一致（用户实测「错误渲染」）。
	assert.equal(formatChipDisplayLabel("file", "src/a.ts"), "@src/a.ts");
	assert.equal(formatChipDisplayLabel("skill", "skill:review"), "/skill:review");
	assert.equal(formatChipDisplayLabel("session", "会话A"), "&会话A");
	// quote 例外：raw 是 #q<id> 快照指针，展示用快照预览
	assert.equal(formatChipDisplayLabel("quote", "号已更新为 0.15.11…"), "号已更新为 0.15.11…");
});

/**
 * 展示即原文（回归）：chip 只允许「加壳」，不得改写字符。
 * 用户实测的五类错误渲染都在这里锁住：`/skill:` 与 `/` 前缀被吞、路径缩成 basename、
 * 散文里的 `&` 被当成会话引用（`AT&T 的季度财报` → `AT⟦T⟧ 的季度财报`）。
 */
test("rendered chip text reproduces the original message verbatim", () => {
	const samples = [
		"请用 /skill:cv-writer 写一份项目经历",
		"执行 /permit 然后继续",
		"A & B 的关系是什么",
		"AT&T 的季度财报",
		"读取 &skill 的内容",
		"看下 @src/a.ts 和 @unknown.txt",
		"1/2 + 3/4 等于多少",
		"/usr/bin/node 找不到",
		"C# 与 F# 的区别",
		"profit & loss",
	];
	const files = new Set(["src/a.ts"]);
	const cmds = new Set(["compact", "permit"]);
	for (const sample of samples) {
		const chips = parseRichInputChips(sample, cmds, files);
		const parts = [];
		let cursor = 0;
		for (const chip of chips) {
			if (chip.start > cursor) parts.push(sample.slice(cursor, chip.start));
			parts.push(formatChipDisplayLabel(chip.kind, chip.label));
			cursor = chip.end;
		}
		if (cursor < sample.length) parts.push(sample.slice(cursor));
		assert.equal(parts.join(""), sample, `渲染结果必须等于发送文本：${sample}`);
	}
});

test("stripChipDisplayPrefix is kind-aware and never eats label-leading / & ❝", () => {
	assert.equal(stripChipDisplayPrefix("file", "@a.ts"), "a.ts");
	// skill：新版展示无前缀，旧版 wire 形态 /skill:名称 / /名称 都能还原
	assert.equal(stripChipDisplayPrefix("skill", "/skill:review"), "review");
	assert.equal(stripChipDisplayPrefix("skill", "/review"), "review");
	assert.equal(stripChipDisplayPrefix("skill", "review"), "review");
	// 回归：引用/会话的 label 本身可能以 / & @ ❝ 开头（如引用一段路径），不得误剥
	assert.equal(stripChipDisplayPrefix("quote", "/src/foo 为什么"), "/src/foo 为什么");
	assert.equal(stripChipDisplayPrefix("quote", "❝ 开头的内容"), "❝ 开头的内容");
	assert.equal(stripChipDisplayPrefix("session", "&alpha"), "&alpha");
	assert.equal(stripChipDisplayPrefix("file", "no-prefix.ts"), "no-prefix.ts");
});

test("isDirectoryFileChip distinguishes @dir/ and @\"dir with space/\"", () => {
	assert.equal(isDirectoryFileChip("@src/"), true);
	assert.equal(isDirectoryFileChip('@"my docs/"'), true);
	assert.equal(isDirectoryFileChip("@src/a.ts"), false);
});

test("formatFilePathRef quotes spaced paths and marks directories", () => {
	assert.equal(formatFilePathRef("src/a.ts"), "@src/a.ts");
	assert.equal(formatFilePathRef("src/components", { isDirectory: true }), "@src/components/");
	assert.equal(formatFilePathRef("my docs/a.ts"), '@"my docs/a.ts"');
});

test("unwrapFileChipPath strips @ quotes and trailing separators", () => {
	assert.equal(unwrapFileChipPath("@src/a.ts"), "src/a.ts");
	assert.equal(unwrapFileChipPath("@src/"), "src");
	assert.equal(unwrapFileChipPath('@"my docs/"'), "my docs");
});

test("parseRichInputChips respects file and command whitelists", () => {
	const files = new Set(["src/a.ts"]);
	const cmds = new Set(["compact"]);
	const chips = parseRichInputChips(
		"看 @src/a.ts 和 @src/b.ts 再 /compact /unknown",
		cmds,
		files,
	);
	assertJsonEqual(
		chips.map((c) => ({ kind: c.kind, raw: c.raw })),
		[
			{ kind: "file", raw: "@src/a.ts" },
			{ kind: "skill", raw: "/compact" },
		],
	);
});

test("pi skill invocations stay chips even when runtime only exposes generic commands", () => {
	const chips = parseRichInputChips(
		"执行 /skill:cv-project-writer 后再 /unknown",
		new Set(["compact"]),
	);
	assertJsonEqual(
		chips.map((chip) => ({ kind: chip.kind, raw: chip.raw, label: chip.label })),
		[{ kind: "skill", raw: "/skill:cv-project-writer", label: "skill:cv-project-writer" }],
	);
});

test("session chip with whitelist Set only matches known names", () => {
	const sessions = new Set(["alpha", "beta long"]);
	const chips = parseRichInputChips(
		"参考 &alpha 和 &beta long 还有 &ghost 以及 && cmd&x",
		undefined,
		undefined,
		sessions,
	);
	assertJsonEqual(
		chips.map((c) => c.raw),
		["&alpha", "&beta long"],
	);
});

test("session chip with empty whitelist creates no session chips", () => {
	const chips = parseRichInputChips("&& &oops cmd&x", undefined, undefined, new Set());
	assert.equal(chips.filter((c) => c.kind === "session").length, 0);
});

test("session chips require a whitelist; prose & is never chipped", () => {
	// 回归（用户实测）：气泡侧不传 validSessionRefs，曾经的「回退首词」把散文里的 &
	// 当成会话引用 —— `AT&T 的季度财报` 被渲染成 `AT⟦T⟧ 的季度财报`。
	assertJsonEqual(parseRichInputChips("see &alpha next"), []);
	assertJsonEqual(
		parseRichInputChips("AT&T 的季度财报").map((c) => c.raw),
		[],
	);
	// 白名单命中仍要成 chip（composer 侧行为不变）
	assertJsonEqual(
		parseRichInputChips("see &alpha next", undefined, undefined, new Set(["alpha"])).map((c) => c.raw),
		["&alpha"],
	);
});

test("URL path segments are not parsed as chips", () => {
	const chips = parseRichInputChips(
		"https://example.com/foo @src/a.ts",
		undefined,
		new Set(["src/a.ts"]),
	);
	assertJsonEqual(
		chips.map((c) => c.raw),
		["@src/a.ts"],
	);
});

test("unquoted absolute path with spaces is extended into one file chip", () => {
	const path = "C:/Users/528/Documents/Tencent Files/473812916/nt_qq/nt_data/Pic/2026-08/Ori/455f949b57b937a5491cbb0a6f7bd07a.png";
	const chips = parseRichInputChips(`@${path}`);
	assert.equal(chips.length, 1);
	assert.equal(chips[0].kind, "file");
	// raw 是原始发送/打开路径，不能因视觉截断而改变；label 是同一路径（展示时拼回 @）
	assert.equal(chips[0].raw, `@${path}`);
	assert.equal(chips[0].label, path);
});

test("unquoted spaced absolute path stops before following text and URLs", () => {
	const withText = parseRichInputChips("@C:/Program Files/nodejs 帮我看看");
	assertJsonEqual(
		withText.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/Program Files/nodejs", label: "C:/Program Files/nodejs" }],
	);
	// 延伸不跨过 URL：https:// 是正文，不是路径的一部分
	const withUrl = parseRichInputChips("@C:/foo https://x.com/a");
	assertJsonEqual(
		withUrl.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/foo", label: "C:/foo" }],
	);
});

test("unquoted spaced absolute path supports backslashes and dir suffix", () => {
	const backslash = parseRichInputChips("@C:\\Users\\Tencent Files\\a.png");
	assertJsonEqual(
		backslash.map((c) => ({ raw: c.raw, label: c.label })),
		[
			{
				raw: "@C:\\Users\\Tencent Files\\a.png",
				label: "C:/Users/Tencent Files/a.png",
			},
		],
	);
	const dir = parseRichInputChips("@C:/Program Files/");
	assertJsonEqual(
		dir.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/Program Files/", label: "C:/Program Files/" }],
	);
});

test("POSIX absolute path with spaces is extended", () => {
	const chips = parseRichInputChips("@/Users/me/My Documents/a.txt");
	assertJsonEqual(
		chips.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@/Users/me/My Documents/a.txt", label: "/Users/me/My Documents/a.txt" }],
	);
});

test("extended unquoted paths preserve raw length for caret mapping", () => {
	const text = "@C:/Program Files/nodejs next";
	const chips = parseRichInputChips(text);
	assert.equal(chips[0].raw.length, chips[0].end - chips[0].start);
	assert.equal(chips[0].raw, text.slice(chips[0].start, chips[0].end));
});

test("space-free absolute path keeps raw unquoted", () => {
	const chips = parseRichInputChips("@C:/foo/bar.txt");
	assertJsonEqual(
		chips.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/foo/bar.txt", label: "C:/foo/bar.txt" }],
	);
});

test("extractPastedPath recognizes single absolute path pastes", () => {
	assert.equal(
		extractPastedPath("C:/Users/528/Documents/Tencent Files/455f949b57b937a5491cbb0a6f7bd07a.png"),
		"C:/Users/528/Documents/Tencent Files/455f949b57b937a5491cbb0a6f7bd07a.png",
	);
	assert.equal(extractPastedPath("@C:/Users/x.png"), "C:/Users/x.png");
	assert.equal(extractPastedPath('"C:\\Users\\Tencent Files\\x.png"'), "C:\\Users\\Tencent Files\\x.png");
	assert.equal(extractPastedPath('@"C:/a b.txt"'), "C:/a b.txt");
	assert.equal(extractPastedPath("/Users/me/a.txt"), "/Users/me/a.txt");
});

test("extractPastedPath rejects non-path text and relative paths", () => {
	assert.equal(extractPastedPath("看下 C:/foo.txt 这个文件"), null);
	assert.equal(extractPastedPath("src/foo bar/a.ts"), null);
	assert.equal(extractPastedPath("C:/foo.txt\nC:/bar.txt"), null);
	assert.equal(extractPastedPath(""), null);
	assert.equal(extractPastedPath("C:"), null);
});

test("extractPastedPath rejects slash commands that only look like POSIX paths", () => {
	// 代码块复制 /maestro-next "…" 再粘到 composer：旧规则把任意 / 开头单行当成绝对路径，
	// formatFilePathRef 再包成 @"/maestro-next \"…\""。
	assert.equal(extractPastedPath('/maestro-next "修复登录页重定向 bug"'), null);
	assert.equal(extractPastedPath("/compact"), null);
	assert.equal(extractPastedPath("/permission workspace-write"), null);
	// 真 POSIX 路径仍要认：多段路径，或空格出现在第二段之后。
	assert.equal(extractPastedPath("/Users/me/a.txt"), "/Users/me/a.txt");
	assert.equal(extractPastedPath("/Users/me/My Documents/a.txt"), "/Users/me/My Documents/a.txt");
});

test("quote token becomes a chip only when whitelisted, with snapshot label", () => {
	const text = "看 #qabcdef12 为什么不生效";
	const quotes = new Map([["qabcdef12", "这里的重试逻辑没有生…"]]);

	// 白名单命中：成 chip，label 来自快照预览
	const chips = parseRichInputChips(text, undefined, undefined, undefined, quotes);
	assert.equal(chips.length, 1);
	assertJsonEqual(chips[0], {
		start: 2,
		end: 12,
		raw: "#qabcdef12",
		kind: "quote",
		label: "这里的重试逻辑没有生…",
	});

	// 未传白名单（时间线展示）：保持裸文本
	assertJsonEqual(parseRichInputChips(text), []);

	// 白名单未命中（手工敲出的同形 token）：不成 chip
	const miss = parseRichInputChips(
		text,
		undefined,
		undefined,
		undefined,
		new Map([["qffffffff", "别的引用"]]),
	);
	assertJsonEqual(miss, []);
});
