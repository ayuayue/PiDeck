import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// 预览面板自动换行（Discussions #423）的契约：
// - diff 视图把 wordWrap 映射成库的 overflow（wrap / scroll），并进 useMemo 依赖，切换才重算；
// - 编辑器用 Compartment 热切换换行，不能把 wordWrap 塞进重建实例的依赖（会丢撤销栈）；
// - 面板默认不改任何人观感：没点过开关时源码换行、diff 横滚，点过才按 localStorage 里的偏好；
// - 三份词典都有这三个键（zh-TW 为生成物，手改会与生成结果不一致）。

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("diff 视图按 wordWrap 切换 overflow，且进入依赖数组", () => {
	const source = read("src/renderer/src/components/app/CodeDiffView.tsx");
	assert.match(source, /overflow: \(props\.wordWrap \? "wrap" : "scroll"\)/);
	assert.match(source, /\}, \[props\.viewMode, props\.wordWrap, theme, plan\]\);/);
});

test("编辑器换行走 Compartment 热切换，不重建实例", () => {
	const source = read("src/renderer/src/components/app/CodeMirrorEditor.tsx");
	assert.match(source, /new Compartment\(\)/);
	assert.match(source, /wrapCompartment\.of\(wordWrap \? EditorView\.lineWrapping : \[\]\)/);
	assert.match(source, /wrapCompartment\.reconfigure\(wordWrap \? EditorView\.lineWrapping : \[\]\)/);
	// 重建依赖必须仍只有语言/只读/换行符；wordWrap 一旦混进去，切开关就会清空撤销栈
	assert.match(source, /\}, \[language, readOnly, lineSeparator\]\);/);
	assert.doesNotMatch(source, /\}, \[language, readOnly, lineSeparator, wordWrap\]\);/);
	// 默认开启，保持编辑器原有观感
	assert.match(source, /wordWrap = true \}/);
});

test("面板按视图给默认值，并把偏好存进 localStorage", () => {
	const source = read("src/renderer/src/components/app/FileDiffViewer.tsx");
	assert.match(source, /const FILE_WORD_WRAP_KEY = "pideck\.filePreview\.wordWrap";/);
	assert.match(source, /const wordWrap = wordWrapPref \?\? !isDiffMode;/);
	assert.match(source, /<CodeMirrorEditor[^>]*wordWrap=\{wordWrap\}/);
	assert.match(source, /<CodeDiffView[^>]*wordWrap=\{wordWrap\}/);
});

test("三份词典都有换行开关文案", () => {
	for (const file of ["rendererCopy.zh-CN.ts", "rendererCopy.en-US.ts", "rendererCopy.zh-TW.ts"]) {
		const source = read(`src/renderer/src/i18n/${file}`);
		for (const key of ['"editor.wordWrap"', '"editor.wordWrapOn"', '"editor.wordWrapOff"']) {
			assert.ok(source.includes(key), `${file} 缺少 ${key}`);
		}
	}
});
