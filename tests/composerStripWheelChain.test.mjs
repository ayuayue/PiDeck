import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * composer 卡片列「只有一条滚轮」的契约断言。
 *
 * 背景：输入框上方那叠卡片（待办/改文件/子代理/协作…）的滚轮 owner 只有一个 ——
 * ComposerArea 的 widgets 容器：窗口不够高时它被挤压，由它滚动整叠卡片。
 *
 * 条内限高列表（子代理 240 / 改文件 200 / 待办 180 / 协作 260）因为 `overflow-y: auto`
 * 本身就是滚动容器，**即使内容不足自己的 max-height 也一样**；再带 `overscroll-contain`
 * 就会把滚轮吞在自身、外层卡片列一像素不动 —— 观感是「展开后只能看到前几条，且怎么滚都不动」
 * （2026-10 子代理条事故；Chromium 探针：ul overscroll=contain → ul/widgets 都 0；
 * 换成 auto → widgets 正常滚 168px）。
 *
 * 约定：`overscroll-contain` 只放卡片列容器；条内限高列表一律不带
 * （列表滚到底后由外层接管，不再有滚轮死区）。详情弹窗是 portal 内独立滚动语境，保持原值。
 *
 * 这里用源码正则把约束钉住 —— 任何人给条内列表补回 overscroll-contain，测试即红。
 */
const sessionComponent = (file) => readFileSync(`src/renderer/src/components/session/${file}`, "utf8");

/** 条内限高列表的锚点类（断言用它定位列表，而不是全文计数）。 */
const CLAMPED_LISTS = [
	["SessionSubagentsStrip.tsx", "max-h-\\[240px\\]"],
	["SessionFilesStrip.tsx", "max-h-\\[200px\\]"],
	["SessionTodoStrip.tsx", "max-h-\\[180px\\]"],
	["SessionTeamStrip.tsx", "max-h-\\[260px\\]"],
];

test("卡片列容器保留 overscroll-contain（滚轮总责任只在它身上）", () => {
	const composer = sessionComponent("ComposerArea.tsx");
	assert.match(composer, /className="flex\s+min-h-0\s+min-w-0\s+flex-col\s+gap-2\s+overflow-y-auto\s+overscroll-contain\s+pb-px/, "widgets 容器必须保留 overflow-y-auto + overscroll-contain");
});

for (const [file, cap] of CLAMPED_LISTS) {
	test(`${file} 的限高列表（${cap.replace(/\\|\[|\]/g, "")}）不带 overscroll-contain`, () => {
		const source = sessionComponent(file);
		const list = source.match(new RegExp(`<[a-z]+\\s+className="[^"]*${cap}[^"]*"`));
		assert.ok(list, `${file} 应有一个带 ${cap} 的限高列表`);
		assert.doesNotMatch(list[0], /overscroll-contain/, "限高列表带 overscroll-contain 会把滚轮吞在自身：内容不足其 max-height 时外层卡片列完全滚不动");
	});
}

test("子代理条的结果预览（max-h-32）同样不带 overscroll-contain", () => {
	const source = sessionComponent("SessionSubagentsStrip.tsx");
	const preview = source.match(/<div\s+className="max-h-32[^"]*"/);
	assert.ok(preview, "结果预览应有 max-h-32 限高");
	assert.doesNotMatch(preview[0], /overscroll-contain/, "预览短于 max-h-32 时同样会把滚轮吞在自身");
});

test("子代理条详情弹窗保留 overscroll-contain（portal 内独立语境，是唯一的例外）", () => {
	const source = sessionComponent("SessionSubagentsStrip.tsx");
	assert.match(source, /max-h-\[60vh\][^"]*overscroll-contain/, "详情弹窗需保留自己的滚动语境");
	const occurrences = source.split("overscroll-contain").length - 1;
	assert.equal(occurrences, 1, "除详情弹窗外，子代理条内不得再出现 overscroll-contain");
});

for (const [file] of CLAMPED_LISTS.filter(([name]) => name !== "SessionSubagentsStrip.tsx")) {
	test(`${file} 内没有任何 overscroll-contain`, () => {
		assert.equal(sessionComponent(file).split("overscroll-contain").length - 1, 0);
	});
}
