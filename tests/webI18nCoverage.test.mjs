import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 错误码和它的文案必须双向对上，而且是逐份对。
 *
 * 为什么必须：`webPageTemplate.ts` 的前端取词是
 * `copy[key] || dictionaries["en-US"][key] || key` —— 三份字典都没有时，
 * 用户界面上直接显示 `webError.gitUnavailable` 这样的原始码。
 *
 * 2026-11-18 实测：源码在用的 43 个码里，30 个在三份字典里一条都没有，
 * 而那时候不管是 typecheck、单测还是 web 的 503 条测试，全是绿的——
 * 因为没人断言过「码表」与「文案表」是同一个集合。
 *
 * 两个方向都断言：
 * - 代码用了没文案 → 用户看到原始码（这个方向是真 bug）
 * - 有文案没人用 → 僵尸键，改码名时容易漏改（这个方向是债）
 *
 * 逐份而不是拼起来查：三份字典拼成一个字符串再比对，任何一份有文案就算通过，
 * 于是「zh-CN 有、zh-TW 没有」这种最该抓的缺口会被判绿。三个 locale 是三个用户。
 *
 * 字典这一侧走运行时加载：`webClientDictionaries` 是三份词典的真身，
 * 从源码文本里切只验了「文本里有这个串」，验不到「导出给前端的键就是这些」。
 * 只有「源码在用的码」那一侧必须静态扫——那要覆盖整个 `src/main/web` 目录。
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(here, "../src/main/web");

const { webClientDictionaries } = loadTsCommonJs(path.join(WEB, "WebI18n.ts"));

const codeFiles = fs
	.readdirSync(WEB)
	.filter((f) => f.endsWith(".ts") && !f.startsWith("WebI18n"))
	.map((f) => path.join(WEB, f));

function codesIn(text) {
	return new Set([...text.matchAll(/"(webError\.[A-Za-z0-9_]+)"/g)].map((m) => m[1]));
}

const usedCodes = new Set();
for (const file of codeFiles) for (const code of codesIn(fs.readFileSync(file, "utf8"))) usedCodes.add(code);

const dicts = Object.entries(webClientDictionaries).map(([locale, copy]) => [locale, new Set(Object.keys(copy).filter((key) => key.startsWith("webError.")))]);

test("三份字典都在（判据自己没坏）", () => {
	assert.deepEqual(dicts.map(([locale]) => locale).sort(), ["en-US", "zh-CN", "zh-TW"], `webClientDictionaries 只导出 ${dicts.length} 份，缺一份时下面的逐份断言会少跑一次`);
});

test("源码里能切出足够多的错误码（判据自己没坏）", () => {
	// 阈值守卫：正则或目录读错时下面几条会「零对零」通过，这正是恒真绿的形状。
	assert.ok(usedCodes.size >= 30, `只切出 ${usedCodes.size} 个错误码，判据自己坏了`);
});

for (const [locale, defined] of dicts) {
	test(`${locale} 的每个错误码都有文案，缺了用户会看到原始码`, () => {
		const missing = [...usedCodes].filter((code) => !defined.has(code)).sort();
		assert.deepEqual(missing, [], `${locale} 缺这些码的文案：${missing.join("、")}`);
	});
}

test("没有僵尸文案：任一份字典里的码源码都在用", () => {
	const zombie = [...new Set(dicts.flatMap(([, set]) => [...set]))].filter((code) => !usedCodes.has(code)).sort();
	assert.deepEqual(zombie, [], `这些文案源码没用：${zombie.join("、")}`);
});
