import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);

// codemirrorSetup.ts 是 ESM 源码，先 transpile 为 CommonJS 再 require 执行。
// Node 24 支持 require(esm)，@codemirror/* 的真实实现可被加载（纯 JS，无 DOM 依赖）。
function loadModule() {
  const output = ts.transpileModule(
    readFileSync("src/renderer/src/utils/codemirrorSetup.ts", "utf8"),
    {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      fileName: "codemirrorSetup.ts",
    },
  ).outputText;
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
  // readOnly 追加 EditorState.readOnly + EditorView.editable 两个扩展（Facet 不可序列化，用数量断言）
  const readOnly = baseEditorExtensions({ readOnly: true });
  assert.equal(readOnly.length, baseEditorExtensions().length + 2);
  // wordWrap 追加 lineWrapping 一个扩展
  const wrapped = baseEditorExtensions({ wordWrap: true });
  assert.equal(wrapped.length, baseEditorExtensions().length + 1);
  // language 追加一个扩展
  const withLang = baseEditorExtensions({ language: resolveEditorLanguage("md") });
  assert.equal(withLang.length, baseEditorExtensions().length + 1);
  // 组合叠加
  const all = baseEditorExtensions({ readOnly: true, wordWrap: true, language: resolveEditorLanguage("md") });
  assert.equal(all.length, baseEditorExtensions().length + 4);
});
