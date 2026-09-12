import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// 更新日志弹窗的两条「UI 塌陷」回归。
//
// 这两个都是「代码看着对、界面是坏的」类问题，纯靠读代码发现不了，必须靠断言把
// 结论钉住，否则下次改样式时极易回潮。

const DIALOG_SRC = "src/renderer/src/components/app/settings/ChangelogDialog.tsx";

/**
 * 回归一：DialogContent 基础类自带 `sm:max-w-lg`，而 tailwind-merge 只消解**同断点前缀**
 * 的冲突 —— `sm:max-w-lg` 与无前缀的 `max-w-[760px]` 不属于同一冲突组，两者会共存，
 * 且 `sm:` 变体在 ≥640px 视口下胜出 → 弹窗被压回 512px（实测产物确认）。
 *
 * 因此覆盖宽度必须写成 **同断点的 `sm:` 变体**。
 */
test("changelog dialog overrides the dialog max-width at the same breakpoint", () => {
	const src = readFileSync(DIALOG_SRC, "utf8");
	// 必须存在 sm: 前缀的宽度覆盖 —— 这是唯一能压过 DialogContent 自带 sm:max-w-lg 的形式。
	assert.match(
		src,
		/sm:max-w-\[min\(760px/,
		"弹窗宽度必须用 sm: 前缀覆盖，否则 DialogContent 自带的 sm:max-w-lg 会胜出",
	);
	// 不能只有无前缀 max-w-*：那样在 ≥640px 视口下无效（正是这个 bug 的形态）。
	assert.doesNotMatch(
		src,
		/className="[^"]*\bmax-w-\[760px\][^"]*"/,
		"无前缀的 max-w-[760px] 压不过 sm:max-w-lg，已回退到坏形态",
	);
});

/**
 * 回归二：MarkdownStream 自身不挂 `markdown-body` 类（会话里由 AssistantText 挂）。
 * 正文的「压缩宽内容」全靠 .markdown-body 的 overflow-x: clip + 子元素 min-width:0
 * （见 styles/timeline.css）。不挂该类，长段落会被判成不可断行的单行文本，
 * 横向撑破弹窗 —— 既不出换行也不出滚动条。
 */
test("changelog dialog wraps markdown in a markdown-body container", () => {
	const src = readFileSync(DIALOG_SRC, "utf8");
	assert.match(
		src,
		/className="markdown-body\b/,
		"MarkdownStream 外面必须挂 markdown-body，否则宽内容会撑破弹窗且不换行",
	);
});

/**
 * 回归三：流式纯文本兜底（PlainStreamSplit）自带 whitespace-pre-wrap 保住换行，
 * 一旦它被绕过，pre-wrap 语义就必须由容器补上。锁住这条契约的前提是
 * `.markdown-body` 确实提供换行语义（子选择器 white-space: pre-wrap）。
 */
test("markdown-body provides pre-wrap for paragraphs so plain text still wraps", () => {
	const css = readFileSync("src/renderer/src/styles/timeline.css", "utf8");
	assert.match(
		css,
		/\.markdown-body p\s*\{[^}]*white-space:\s*pre-wrap/,
		".markdown-body p 必须保留 white-space: pre-wrap，这是更新日志等静态场景换行的依赖",
	);
});
