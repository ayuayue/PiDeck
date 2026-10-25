import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 输入预测 ghost 文案（回合结束后的下一句建议）的视觉契约。
 *
 * 用户反馈（2026-10）：「预测那个颜色好像不是灰色，太重了」——根因是类名写成了
 * `text-tertiary` / `border-subtle`（少了本仓库的 `text-` / `border-` 前缀），
 * 这两个 utility 根本不存在、不生成任何 CSS，ghost 于是继承 .rich-input 的正文原色，
 * 看起来就像用户已经打进去的字。
 */
const composer = readFileSync("src/renderer/src/components/session/composer/TipTapComposer.tsx", "utf8");
const composerArea = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
const tailwind = readFileSync("src/renderer/src/styles/tailwind.css", "utf8");

/** 去掉注释（注释里会引用错误写法做说明，不能当成真实类名）。 */
function stripComments(source) {
	return source
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.split("\n")
		.filter((line) => !line.trim().startsWith("//"))
		.join("\n");
}

/** 裸 token 判定：必须不是更长 class 的一部分（text-text-tertiary 里不含独立的 text-tertiary）。 */
function hasBareToken(source, token) {
	return new RegExp(`(?<![\\w-])${token}(?![\\w-])`, "u").test(stripComments(source));
}

test("ghost 文案用最浅文字档，键盘提示用描边色（都是真实存在的 token）", () => {
	// 主题里必须真的有这两档 token，否则类名又会静默失效。
	assert.match(tailwind, /--color-text-faint:\s*var\(--color-text-faint\)/);
	assert.match(tailwind, /--color-border-subtle:\s*var\(--color-border-subtle\)/);
	assert.match(composer, /text-text-faint/u, "ghost 层必须用 text-text-faint（比正文轻一档的灰）");
	assert.match(composer, /border-border-subtle/u, "Tab 键帽描边必须用 border-border-subtle");
	// 文案轻、键帽可读：Tab 提示自己再压一档颜色，但不能跟着 faint 一起叠 opacity
	assert.match(composer, /text-text-tertiary opacity-80/u, "Tab 键帽用 tertiary 保持可读");
});

test("composer 壳里不再出现无效的裸 token（静默不生效的类名）", () => {
	assert.equal(hasBareToken(composer, "text-tertiary"), false, "text-tertiary 不是本仓库 utility，写成它会退回正文原色");
	assert.equal(hasBareToken(composer, "border-subtle"), false, "border-subtle 同理，必须写 border-border-subtle");
	// 反证检测器本身有效：`text-text-tertiary` 这种合法写法不能被误判成裸 token
	assert.equal(hasBareToken('className="text-text-tertiary"', "text-tertiary"), false);
	assert.equal(hasBareToken('className="text-text-tertiary"', "text-text-tertiary"), true);
});

test("ghost 只做视觉层：不抢指针、不进读屏，字号行高跟随输入框", () => {
	assert.match(composer, /pointer-events-none absolute[^"]*text-text-faint/u);
	assert.match(composer, /aria-hidden="true"/u);
	assert.match(composer, /fontSize: "var\(--font-size-input\)"/u);
	assert.match(composer, /lineHeight: "var\(--line-height-input\)"/u);
	// 有预测时占位符必须让位（否则两层文案叠在一起）
	assert.match(composerArea, /composer\.suggestion\?\.visible\s*\?\s*""/u);
	// 只有 visible 时才把文案交给 ghost 层
	assert.match(composerArea, /suggestion=\{composer\.suggestion\?\.visible \? composer\.suggestion\?\.text : undefined\}/u);
});
