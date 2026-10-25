import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// 剪贴板粘贴一致性契约：
// Windows 剪贴板按格式分槽存储，纯文本复制（记事本/终端）只更新 text 槽，
// HTML 槽残留上一次富文本复制的内容。readClipboardHtml 直接读会粘出旧内容，
// 必须用 readClipboardHtmlConsistent（HTML 纯文本形态与当前纯文本同源才返回）。

test("clipboard helper exposes consistent html read with whitespace-normalized comparison", () => {
	const src = readFileSync("src/renderer/src/utils/clipboard.ts", "utf8");
	assert.match(src, /export function isClipboardHtmlConsistent\(htmlPlain: string, text: string\)/);
	// 归一化空白后全等比较：富文本/纯文本源的细微空白差异（&nbsp;、行尾空格）不误判
	assert.match(src, /htmlPlain\.replace\(\/\\s\+\/g, " "\) === text\.replace\(\/\\s\+\/g, " "\)/);
	// 无纯文本槽时无从校验，信任 HTML（保持原行为）
	assert.match(src, /if \(!text\) return html;/);
});

test("composer and git commit input paste through the consistent html read", () => {
	const composer = readFileSync("src/renderer/src/components/session/composer/TipTapComposer.tsx", "utf8");
	// 右键粘贴：同源 HTML 只用来还原换行，最终仍按纯文本插入；禁止 insertContent(html)
	assert.match(composer, /readClipboardHtmlConsistent/);
	assert.match(composer, /htmlToPlainText/);
	assert.match(composer, /insertComposerPlainTextFromEditor/);
	assert.doesNotMatch(composer, /readClipboardHtml\(\)/);
	assert.doesNotMatch(composer, /commands\.insertContent\(html\)/);

	const gitPanel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
	assert.match(gitPanel, /readClipboardHtmlConsistent/);
	assert.doesNotMatch(gitPanel, /readClipboardHtml\(\)/);
});

test("Ctrl+V composer paste inserts clipboard text/plain, never TipTap HTML", () => {
	const props = readFileSync("src/renderer/src/components/session/composer/tiptap/buildComposerEditorProps.ts", "utf8");
	assert.match(props, /insertComposerPlainText\(view, payload\)/);
	assert.match(props, /getData\("text\/plain"\)/);
});
