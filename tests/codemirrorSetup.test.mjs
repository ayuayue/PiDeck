import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

// codemirrorSetup.ts 是 ESM 源码，先 transpile 为 CommonJS 再 require 执行。
// Node 24 支持 require(esm)，@codemirror/* 的真实实现可被加载（纯 JS，无 DOM 依赖）。
function loadModule() {
	const output = ts.transpileModule(readFileSync("src/renderer/src/utils/codemirrorSetup.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "codemirrorSetup.ts",
	}).outputText;
	const tmpFile = `${process.cwd()}/tests/.tmp-codemirrorSetup-${Date.now()}.cjs`;
	const { writeFileSync, rmSync } = require("node:fs");
	writeFileSync(tmpFile, output);
	try {
		return require(tmpFile);
	} finally {
		rmSync(tmpFile, { force: true });
	}
}

test("resolveEditorLanguage maps common extensions to language packages", () => {
	const { resolveEditorLanguage } = loadModule();
	// 常用扩展名应有语言包（LanguageSupport.language.name 为解析器名）
	for (const ext of ["ts", "jsx", "json", "md", "css", "scss", "less", "html", "yaml", "py", "go", "rs", "java", "cpp", "sql"]) {
		const lang = resolveEditorLanguage(ext);
		assert.ok(lang, `extension ${ext} should resolve to a language`);
	}
	// legacy-modes 冷门语言（StreamLanguage 包装，language.name 存在）
	assert.ok(resolveEditorLanguage("sh"));
	assert.ok(resolveEditorLanguage("toml"));
	assert.ok(resolveEditorLanguage("dockerfile"));
	assert.ok(resolveEditorLanguage("rb"));
});

test("resolveEditorLanguage accepts legacy Monaco language ids", () => {
	const { resolveEditorLanguage } = loadModule();
	// 旧调用点传 Monaco id（如 FileDiffViewer 旧代码的 "markdown"/"typescript"）
	assert.ok(resolveEditorLanguage("markdown"));
	assert.ok(resolveEditorLanguage("typescript"));
	assert.ok(resolveEditorLanguage("plaintext") === null);
});

test("resolveEditorLanguage falls back to plaintext for unknown/cold languages", () => {
	const { resolveEditorLanguage } = loadModule();
	// 无官方包的冷门类型明确降级纯文本（null），不允许抛错
	assert.equal(resolveEditorLanguage("graphql"), null);
	assert.equal(resolveEditorLanguage("makefile"), null);
	assert.equal(resolveEditorLanguage("unknown-ext"), null);
	assert.equal(resolveEditorLanguage(""), null);
	assert.equal(resolveEditorLanguage(undefined), null);
});

test("baseEditorExtensions applies readOnly and wordWrap", () => {
	const { baseEditorExtensions, resolveEditorLanguage } = loadModule();
	// readOnly 只追加 EditorState.readOnly 一个扩展：不设 editable.of(false)，
	// 否则 contenteditable 被移除后双击选词/三击选行/拖拽选块全部失效（只读仍要能选中）
	const readOnly = baseEditorExtensions({ readOnly: true });
	assert.equal(readOnly.length, baseEditorExtensions().length + 1);
	// wordWrap 追加 lineWrapping 一个扩展
	const wrapped = baseEditorExtensions({ wordWrap: true });
	assert.equal(wrapped.length, baseEditorExtensions().length + 1);
	// language 追加一个扩展
	const withLang = baseEditorExtensions({ language: resolveEditorLanguage("md") });
	assert.equal(withLang.length, baseEditorExtensions().length + 1);
	// 组合叠加
	const all = baseEditorExtensions({ readOnly: true, wordWrap: true, language: resolveEditorLanguage("md") });
	assert.equal(all.length, baseEditorExtensions().length + 3);
});

test("editorTheme is a valid theme extension without legacy merge classes", () => {
	const { editorTheme } = loadModule();
	// editorTheme 是合法主题扩展（theme() 构建不抛 Unsupported selector）
	assert.ok(editorTheme);
	const src = readFileSync("src/renderer/src/utils/codemirrorSetup.ts", "utf8");
	// diff 渲染已迁移到独立渲染库（CodeDiffView），编辑器主题不再残留 merge 类名
	assert.doesNotMatch(src, /cm-merge-pane/);
	assert.doesNotMatch(src, /cm-merge-gap/);
	assert.doesNotMatch(src, /cm-merge-chunk/);
	assert.doesNotMatch(src, /cm-merge-collapsed/);
	assert.doesNotMatch(src, /cm-collapsedLines/);
	// theme() 不支持 &light/&dark 选择器（仅 baseTheme 支持），出现会抛 "Unsupported selector"
	assert.doesNotMatch(src, /"&light|"&dark/);
});

// 回归守卫：当前行用实色 --color-bg-active 铺满整行时，正文会被压进同色相底色，
// 在 Windows ClearType 下笔画发虚、字符发糊（用户实测反馈「这行看不清」）。
// 选区同理：drawSelection 只接管背景，::selection 必须显式给前景色，
// 否则 GTK/Linux 的 UA 样式会把选区文字反白，叠在浅色选区块上直接失读。
test("editor active line stays a light accent wash and selection pins its foreground", () => {
	const src = readFileSync("src/renderer/src/utils/codemirrorSetup.ts", "utf8");
	// 空白容忍：格式化/换行不得让守卫失效（见 AGENTS.md 正则扫描契约要求）
	assert.doesNotMatch(src, /\.cm-activeLine["']?\s*:\s*\{[^}]*backgroundColor:\s*"var\(--color-bg-(active|hover)\)"/);
	assert.match(src, /\.cm-activeLine["']?\s*:\s*\{\s*backgroundColor:\s*"color-mix\(in srgb, var\(--color-accent\) \d+%, transparent\)"/);
	assert.doesNotMatch(src, /\.cm-activeLineGutter["']?\s*:\s*\{[^}]*backgroundColor:\s*"var\(--color-bg-(active|hover)\)"/);
	assert.match(src, /::selection["']?\s*:\s*\{[^}]*color:\s*"currentColor"/);
});
