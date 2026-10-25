import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * detectTrigger 回归：普通正文里的 @ / & 不能打开建议框，
 * 否则后续按键会被当成「还在引用会话/文件」，Esc/Enter 会改写正文，
 * 粘贴含 & 的文本后再输入也会把光标/文本搅乱。
 */
function loadAppUtils() {
	const source = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	const { outputText } = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	});
	const sandbox = {
		exports: {},
		location: { href: "file:///Users/test/app" },
		require: (id) => {
			if (id === "../session/composer/chips") {
				return { formatFilePathRef: (p, opts) => (opts?.isDirectory ? `@${p}/` : `@${p}`) };
			}
			return {};
		},
	};
	vm.runInNewContext(outputText, sandbox, { filename: "AppUtils.ts" });
	return sandbox.exports;
}

const { detectTrigger, applySuggestion, clearSuggestionTrigger, buildSuggestionItems, mergeCommands } = loadAppUtils();

const sessions = new Set(["alpha", "beta long"]);

/** vm 跨 realm 时 deepEqual 会因原型不同误报，统一 JSON 比较。 */
function assertJsonEqual(actual, expected) {
	assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function atEnd(text, refs = sessions) {
	return detectTrigger(text, text.length, refs);
}

test("file suggestion shows basename in label and parent dir as description", () => {
	// 无关键词：只展平第一层；根级文件 label 是文件名，description 为 "."
	const files = [{ name: "main.ts", path: "/p/main.ts", relativePath: "main.ts", type: "file" }];
	const items = buildSuggestionItems("看 @", 3, [], files);
	assertJsonEqual(
		items.map((i) => ({ label: i.label, description: i.description, value: i.value })),
		[{ label: "@main.ts", description: ".", value: "@main.ts" }],
	);
});

test("file suggestion with keyword shows parent dir, root level uses dot", () => {
	// 关键词搜索：深层文件 description 是父目录而非完整相对路径
	const files = [{ name: "main.ts", path: "/p/src/main.ts", relativePath: "src/main.ts", type: "file" }];
	const items = buildSuggestionItems("看 @main", 6, [], files);
	assertJsonEqual(
		items.map((i) => ({ label: i.label, description: i.description })),
		[{ label: "@main.ts", description: "src" }],
	);
	// 根级文件：父目录为 "."
	const rootFiles = [{ name: "readme.md", path: "/p/readme.md", relativePath: "readme.md", type: "file" }];
	const rootItems = buildSuggestionItems("看 @rea", 6, [], rootFiles);
	assertJsonEqual(
		rootItems.map((i) => ({ label: i.label, description: i.description })),
		[{ label: "@readme.md", description: "." }],
	);
	// 深层目录项：description 是父目录（非自身全路径）
	const deepFiles = [{ name: "constants", path: "/p/src/app/constants", relativePath: "src/app/constants", type: "directory" }];
	const deepItems = buildSuggestionItems("看 @con", 6, [], deepFiles);
	assertJsonEqual(
		deepItems.map((i) => ({ label: i.label, description: i.description })),
		[{ label: "@constants/", description: "src/app" }],
	);
});

test("plain prose ampersand does not open a session trigger", () => {
	assert.equal(atEnd("Tom & Jerry"), null);
	assert.equal(atEnd("A & B"), null);
	assert.equal(atEnd("use && to run both"), null);
	assert.equal(atEnd("https://ex.com?a=1&b=2"), null);
	assert.equal(atEnd("cmd&x"), null);
	assert.equal(atEnd("100% & more"), null);
});

test("session trigger stays open only while query is a prefix of a known session", () => {
	assertJsonEqual(atEnd("&"), { start: 0, char: "&", query: "" });
	assertJsonEqual(atEnd("see &al"), { start: 4, char: "&", query: "al" });
	assertJsonEqual(atEnd("&beta"), { start: 0, char: "&", query: "beta" });
	assertJsonEqual(atEnd("&beta l"), { start: 0, char: "&", query: "beta l" });
	assertJsonEqual(atEnd("&beta long"), { start: 0, char: "&", query: "beta long" });
	// 完整会话名后再跟空格/正文 = 引用已结束，不能继续钉住建议框
	assert.equal(atEnd("&beta long next"), null);
	assert.equal(atEnd("&ghost"), null);
	assert.equal(atEnd("&alpha "), null);
});

test("empty session whitelist treats & as ordinary text", () => {
	assert.equal(detectTrigger("&", 1, new Set()), null);
	assert.equal(detectTrigger("&alpha", 6, new Set()), null);
});

test("email and mid-word @ / slash are not mention triggers", () => {
	assert.equal(atEnd("user@host.com"), null);
	assert.equal(atEnd("and/or"), null);
	assert.equal(atEnd("src/index.ts"), null);
	assert.equal(atEnd("https://example.com/foo"), null);
	assert.equal(atEnd("C:/Users/me"), null);
});

test("intentional @file and /command triggers still work", () => {
	assertJsonEqual(atEnd("@"), { start: 0, char: "@", query: "" });
	assertJsonEqual(atEnd("see @src/a"), { start: 4, char: "@", query: "src/a" });
	assertJsonEqual(atEnd("/comp"), { start: 0, char: "/", query: "comp" });
	assert.equal(atEnd("@src/a 说明"), null);
});

test("applySuggestion does not rewrite ordinary ampersand prose", () => {
	const current = "A & B";
	const result = applySuggestion(current, current.length, "&alpha", sessions);
	assert.equal(result.text, "A & B&alpha ");
	assert.equal(result.cursor, result.text.length);
});

test("applySuggestion noTrailingSpace keeps directory path continuation", () => {
	const result = applySuggestion("see @sr", 7, "@src/", sessions, { noTrailingSpace: true });
	assert.equal(result.text, "see @src/");
	assert.equal(result.cursor, result.text.length);
});

test("applySuggestion default still appends trailing space", () => {
	// 光标在 @ 之后（文本末尾 position 5），触发分支替换整个 @ 段
	const result = applySuggestion("see @", 5, "@src", sessions);
	assert.equal(result.text, "see @src ");
	assert.equal(result.cursor, result.text.length);
});

test("applySuggestion noTrailingSpace inserts at cursor without trigger", () => {
	const result = applySuggestion("abc", 1, "@x/", undefined, { noTrailingSpace: true });
	assert.equal(result.text, "a@x/bc");
	assert.equal(result.cursor, 4);
});

test("clearSuggestionTrigger only strips a fresh empty trigger", () => {
	assertJsonEqual(clearSuggestionTrigger("&", 1, sessions), { text: "", cursor: 0 });
	assertJsonEqual(clearSuggestionTrigger("see &al", 7, sessions), {
		text: "see &al",
		cursor: 7,
	});
	const prose = "A & B";
	assertJsonEqual(clearSuggestionTrigger(prose, prose.length, sessions), {
		text: prose,
		cursor: prose.length,
	});
});

test("/new is visible in slash suggestions and hidden CLI commands stay out", () => {
	const names = mergeCommands([]).map((command) => command.name);
	assert.equal(names.includes("new"), true);
	assert.equal(names.includes("model"), false);
	assert.equal(names.includes("resume"), false);
	assert.equal(names.includes("fork"), false);
	// pi 的 builtin 斜杠命令只在交互式 TUI 里执行（RPC 的 prompt 路径只跑 extension/模板/技能），
	// 桌面已有等价入口的几个必须不进菜单，否则点了只会得到「命令被模型回答」。
	for (const dead of ["copy", "export", "share", "session", "settings", "clone", "tree", "reload"]) {
		assert.equal(names.includes(dead), false, `${dead} 不应出现在 / 菜单：它在 RPC 模式下不会执行`);
	}
	// hotkeys 相反：菜单里保留供发现，发送时由桌面接管到设置里的快捷键页。
	assert.equal(names.includes("hotkeys"), true);
	assert.equal(names.includes("compact"), true);
});
