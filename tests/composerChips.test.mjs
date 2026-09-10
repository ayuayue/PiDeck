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
	formatFileChipLabel,
	isDirectoryFileChip,
	formatChipDisplayLabel,
	stripChipDisplayPrefix,
	extractPastedPath,
} = loadChips();

test("formatChipDisplayLabel keeps only the @ prefix and strips the pi skill wire prefix", () => {
	assert.equal(formatChipDisplayLabel("file", "a.ts"), "@a.ts");
	// 对齐 Proma：/ 与 & 由图标表达，不再拼字符前缀；skill 的 skill: 是 wire 细节
	assert.equal(formatChipDisplayLabel("skill", "skill:review"), "review");
	assert.equal(formatChipDisplayLabel("skill", "review"), "review");
	assert.equal(formatChipDisplayLabel("session", "会话A"), "会话A");
	assert.equal(formatChipDisplayLabel("quote", "号已更新为 0.15.11…"), "号已更新为 0.15.11…");
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

test("formatFileChipLabel shows the file name only, full path stays in raw/title", () => {
	assert.equal(formatFileChipLabel("src/session/SurfaceComponents.tsx"), "SurfaceComponents.tsx");
	assert.equal(formatFileChipLabel("C:\\Users\\me\\a.png"), "a.png");
	assert.equal(formatFileChipLabel("C:/Program Files/"), "Program Files");
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

test("session chip without whitelist falls back to first word for timeline display", () => {
	const chips = parseRichInputChips("see &alpha next");
	assertJsonEqual(
		chips.filter((c) => c.kind === "session").map((c) => c.raw),
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
	// raw 是原始发送/打开路径，不能因视觉截断而改变；展示只给文件名（Proma 同款）
	assert.equal(chips[0].raw, `@${path}`);
	assert.equal(chips[0].label, "455f949b57b937a5491cbb0a6f7bd07a.png");
});

test("unquoted spaced absolute path stops before following text and URLs", () => {
	const withText = parseRichInputChips("@C:/Program Files/nodejs 帮我看看");
	assertJsonEqual(
		withText.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/Program Files/nodejs", label: "nodejs" }],
	);
	// 延伸不跨过 URL：https:// 是正文，不是路径的一部分
	const withUrl = parseRichInputChips("@C:/foo https://x.com/a");
	assertJsonEqual(
		withUrl.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/foo", label: "foo" }],
	);
});

test("unquoted spaced absolute path supports backslashes and dir suffix", () => {
	const backslash = parseRichInputChips("@C:\\Users\\Tencent Files\\a.png");
	assertJsonEqual(
		backslash.map((c) => ({ raw: c.raw, label: c.label })),
		[
			{
				raw: "@C:\\Users\\Tencent Files\\a.png",
				label: "a.png",
			},
		],
	);
	const dir = parseRichInputChips("@C:/Program Files/");
	assertJsonEqual(
		dir.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@C:/Program Files/", label: "Program Files" }],
	);
});

test("POSIX absolute path with spaces is extended", () => {
	const chips = parseRichInputChips("@/Users/me/My Documents/a.txt");
	assertJsonEqual(
		chips.map((c) => ({ raw: c.raw, label: c.label })),
		[{ raw: "@/Users/me/My Documents/a.txt", label: "a.txt" }],
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
		[{ raw: "@C:/foo/bar.txt", label: "bar.txt" }],
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
