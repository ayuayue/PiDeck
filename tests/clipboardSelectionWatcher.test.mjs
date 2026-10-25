import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const mod = loadTsCommonJs("src/main/selection/clipboardSelectionWatcher.ts");
const { ClipboardSelectionWatcher, CLIPBOARD_SELECTION_MIN_CHARS, normalizeClipboardText, resolveClipboardSelectionCandidate } = mod;

function createWatcher(initialText, options = {}) {
	let text = initialText;
	let focused = false;
	let now = 0;
	const captured = [];
	const watcher = new ClipboardSelectionWatcher({
		readText: () => {
			if (options.readThrows) throw new Error("clipboard locked");
			return text;
		},
		isOwnWindowFocused: () => focused,
		onCaptured: (value) => captured.push(value),
		now: () => now,
		...options,
	});
	return {
		watcher,
		captured,
		setText: (value) => {
			text = value;
		},
		setFocused: (value) => {
			focused = value;
		},
		advance: (ms) => {
			now += ms;
		},
	};
}

test("normalizeClipboardText strips NUL and trims like the shortcut reader", () => {
	assert.equal(normalizeClipboardText(" \u0000 hello \u0000 "), "hello");
	assert.equal(normalizeClipboardText("   "), "");
});

test("clipboard trigger policy: new non-empty text triggers, own focused/suppressed/short do not", () => {
	const base = { lastText: "", currentText: "", ownWindowFocused: false, suppressed: false };
	assert.deepEqual({ ...resolveClipboardSelectionCandidate({ ...base, currentText: "你好" }) }, { nextLastText: "你好", triggerText: "你好" });
	assert.deepEqual({ ...resolveClipboardSelectionCandidate({ ...base, lastText: "你好", currentText: " 你好 " }) }, { nextLastText: "你好", triggerText: null });
	assert.deepEqual({ ...resolveClipboardSelectionCandidate({ ...base, currentText: "a" }) }, { nextLastText: "a", triggerText: null });
	assert.equal(CLIPBOARD_SELECTION_MIN_CHARS, 2);
	// 焦点/抑制仍更新基线：之后焦点移开或抑制结束，不会补弹同一段文本。
	assert.deepEqual({ ...resolveClipboardSelectionCandidate({ ...base, currentText: "own copy", ownWindowFocused: true }) }, { nextLastText: "own copy", triggerText: null });
	assert.deepEqual({ ...resolveClipboardSelectionCandidate({ ...base, currentText: "suppressed", suppressed: true }) }, { nextLastText: "suppressed", triggerText: null });
});

test("watcher starts from clipboard baseline and only fires for later external copies", () => {
	const t = createWatcher("已有内容");
	t.watcher.pollOnce();
	assert.deepEqual(t.captured, []);

	t.setText("外部复制的一段话");
	t.watcher.pollOnce();
	assert.deepEqual(t.captured, ["外部复制的一段话"]);
	t.watcher.pollOnce();
	assert.equal(t.captured.length, 1);

	// 自己的窗口复制：不弹，但基线更新；之后焦点移开也不补弹。
	t.setFocused(true);
	t.setText("PiDeck 内部复制");
	t.watcher.pollOnce();
	t.setFocused(false);
	t.watcher.pollOnce();
	assert.equal(t.captured.length, 1);

	t.setText("另一段外部文本");
	t.watcher.pollOnce();
	assert.deepEqual(t.captured, ["外部复制的一段话", "另一段外部文本"]);
});

test("watcher suppressFor covers sentinel/restore writes from the shortcut reader", () => {
	const t = createWatcher("original");
	t.watcher.suppressFor(1000);
	t.setText("pideck-selection-probe:sentinel");
	t.watcher.pollOnce();
	t.setText("模拟复制结果");
	t.watcher.pollOnce();
	assert.deepEqual(t.captured, []);
	t.advance(1001);
	t.setText("之后的真实复制");
	t.watcher.pollOnce();
	assert.deepEqual(t.captured, ["之后的真实复制"]);
});

test("watcher truncates oversized clipboard text and survives read failures", () => {
	const t = createWatcher("baseline");
	t.setText("x".repeat(20_000));
	t.watcher.pollOnce();
	assert.equal(t.captured.length, 1);
	assert.equal(t.captured[0].length, 16_000);

	const broken = createWatcher("baseline", { readThrows: true });
	assert.doesNotThrow(() => broken.watcher.pollOnce());
	assert.deepEqual(broken.captured, []);
	broken.watcher.dispose();
});

test("main wires copy-trigger to the same selection service and stops with the switch", () => {
	const main = readFileSync("src/main/index.ts", "utf8");
	assert.match(main, /new ClipboardSelectionWatcher\(/);
	assert.match(main, /selectionClipboardWatcher\?\.setEnabled\(systemEnabled\)/);
	assert.match(main, /suppressClipboardWatcher:/);
	assert.match(main, /BrowserWindow\.getAllWindows\(\)\.some/);
	assert.match(main, /selectionClipboardWatcher\?\.dispose\(\)/);
});
