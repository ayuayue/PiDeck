import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * #547：会话正文行距可调（全局一档，只调行高；代码块和表格不跟随）。
 * 运行时覆盖归一化；接线/CSS 用源码断言（CSS 无法在单测里执行）。
 */
const { CHAT_LINE_HEIGHT_MODES, DEFAULT_CHAT_LINE_HEIGHT_MODE, normalizeChatLineHeightMode } = loadTsCommonJs("src/shared/chatLineHeight.ts");

test("归一化：三个合法档位原样保留", () => {
	for (const mode of ["default", "relaxed", "loose"]) {
		assert.equal(normalizeChatLineHeightMode(mode), mode);
	}
	assert.deepEqual([...CHAT_LINE_HEIGHT_MODES], ["default", "relaxed", "loose"]);
	assert.equal(DEFAULT_CHAT_LINE_HEIGHT_MODE, "default");
});

test("归一化：脏值/缺失回落到基线档，不写迁移框架", () => {
	assert.equal(normalizeChatLineHeightMode(undefined), "default");
	assert.equal(normalizeChatLineHeightMode(null), "default");
	assert.equal(normalizeChatLineHeightMode("huge"), "default");
	assert.equal(normalizeChatLineHeightMode(1.8), "default");
	assert.equal(normalizeChatLineHeightMode("bogus", "relaxed"), "relaxed", "显式 fallback 生效");
});

test("接线与 CSS：全局 dataset + 正文倍率可调 + 代码块/表格钉住基线", () => {
	const foundation = readFileSync("src/renderer/src/styles/foundation.css", "utf8");
	const streamdown = readFileSync("src/renderer/src/styles/streamdownChrome.css", "utf8");
	const appearance = readFileSync("src/renderer/src/hooks/appearance/useAppAppearance.ts", "utf8");
	const rows = readFileSync("src/renderer/src/components/app/settings/SettingRows.tsx", "utf8");
	const tab = readFileSync("src/renderer/src/components/app/settings/AppearanceTab.tsx", "utf8");
	const summary = readFileSync("src/renderer/src/components/app/settings/unsavedChangesSummary.ts", "utf8");

	// 代码块/表格的固定基线必须与正文基线同值，否则「默认档」下两块观感会变
	assert.match(foundation, /--line-height-chat:\s*1\.6;/);
	assert.match(foundation, /--line-height-chat-fixed:\s*1\.6;/);
	assert.match(foundation, /:root\[data-chat-line-height="relaxed"\]\s*\{\s*--line-height-chat:\s*1\.75;/);
	assert.match(foundation, /:root\[data-chat-line-height="loose"\]\s*\{\s*--line-height-chat:\s*1\.9;/);
	// 只调正文：代码块/表格用固定 token 覆盖数据集倍率
	assert.match(streamdown, /\[data-streamdown="code-block"\] pre[\s\S]{0,200}line-height:\s*var\(--line-height-chat-fixed\)/);
	assert.match(streamdown, /\[data-streamdown="table-wrapper"\] table[\s\S]{0,80}line-height:\s*var\(--line-height-chat-fixed\)/);
	// dataset 写入在唯一的字号装配函数里（设置弹窗预览与持久化共用）
	assert.match(appearance, /root\.dataset\.chatLineHeight = settings\.chatLineHeight;/);
	assert.match(appearance, /settings\.chatLineHeight,/);
	// 控件与未保存摘要
	assert.match(rows, /export function ChatLineHeightRow/);
	assert.match(tab, /<ChatLineHeightRow value=\{draft\.chatLineHeight\}/);
	assert.match(summary, /field: "chatLineHeight", tab: "appearance", itemKey: "settings\.chatLineHeight"/);
});
