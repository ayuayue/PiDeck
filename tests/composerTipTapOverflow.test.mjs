import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const composer = readFileSync("src/renderer/src/components/session/composer/TipTapComposer.tsx", "utf8");
const timelineCss = readFileSync("src/renderer/src/styles/timeline.css", "utf8");

test("TipTap composer keeps EditorContent inside a height-constrained overflow host", () => {
	// overflow-hidden 把滚动关进 ProseMirror；host 不能 min-h-0，否则正文无法把 shrink-0 输入卡撑开。
	assert.match(composer, /tiptap-composer-host[^"]*overflow-hidden/);
	assert.match(composer, /tiptap-composer-surface[^"]*overflow-hidden/);
});

test("TipTap ProseMirror grows with typed text then scrolls at the composer cap", () => {
	assert.match(timelineCss, /\.composer \.tiptap-composer-host \{[\s\S]*?overflow:\s*hidden;/);
	assert.match(timelineCss, /\.composer \.tiptap-composer-host \.tiptap-composer-surface \{[\s\S]*?overflow:\s*hidden;/);
	assert.match(timelineCss, /\.composer \.tiptap-composer-host \.ProseMirror,\s*\.composer \.tiptap-composer-host \.rich-input \{[\s\S]*?max-height:\s*var\(--composer-text-max-height,\s*336px\);[\s\S]*?overflow-y:\s*auto;/);
});
