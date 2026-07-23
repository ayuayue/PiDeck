import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/RichInput.tsx", "utf8");

test("RichInput keeps native Enter handling without execCommand normalization", () => {
	assert.match(source, /function insertPlainTextAtSelection\(root: HTMLElement, text: string\): void/);
	assert.doesNotMatch(source, /execCommand\("insertText"/);
	assert.match(source, /insertPlainTextAtSelection\(root, event\.clipboardData\.getData\("text\/plain"\)\);\s*handleInput\(\);/s);
	assert.match(source, /不 preventDefault，让浏览器原生的 contentEditable Enter 行为/);
	assert.doesNotMatch(source, /insertPlainTextAtSelection\(root, "\\n"\)/);
});

test("RichInput preserves the browser DOM while native input awaits controlled confirmation", () => {
	assert.match(source, /const nativeInputValueRef = useRef<string \| null>\(null\)/);
	assert.match(source, /nativeInputValueRef\.current = nextValue;\s*nativeInputCaretRef\.current = nextCaret;\s*onChange\(nextValue, nextCaret\);/s);
	// 新架构：value !== domText 时，先检查是否为 React 正在确认用户输入，
	// 若是则跳过 DOM 操作；否则执行外部变更重建。
	assert.match(source, /if \(value !== domText\) \{[\s\S]*?if \(nativeInputValue !== null && value === nativeInputValue\)/);
	assert.match(source, /if \(nativeInputValue === value\) \{\s*nativeInputValueRef\.current = null;\s*nativeInputCaretRef\.current = null;/s);
});
