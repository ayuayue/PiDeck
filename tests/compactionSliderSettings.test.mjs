import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const shared = loadTsCommonJs("src/shared/compactionSlider.ts");
const { compactionPercentToTokens, compactionTokensToPercent, COMPACTION_SLIDER_MIN_PERCENT, COMPACTION_SLIDER_MAX_PERCENT, COMPACT_REFERENCE_WINDOW_TOKENS } = shared;

test("百分比 → tokens：四舍五入、非负、无效窗口归零", () => {
	assert.equal(compactionPercentToTokens(8, 200000), 16000);
	assert.equal(compactionPercentToTokens(8.4, 200000), 16800); // 16800 精确
	assert.equal(compactionPercentToTokens(1, 128000), 1280);
	assert.equal(compactionPercentToTokens(50, 1000000), 500000);
	assert.equal(compactionPercentToTokens(-5, 200000), 0);
	assert.equal(compactionPercentToTokens(10, 0), 0);
	assert.equal(compactionPercentToTokens(10, Number.NaN), 0);
});

test("tokens → 百分比：截断到 [1,50]、无效窗口回下限", () => {
	assert.equal(compactionTokensToPercent(16384, 200000), 8); // 四舍五入 8.192 → 8
	assert.equal(compactionTokensToPercent(20000, 200000), 10);
	assert.equal(compactionTokensToPercent(0, 200000), COMPACTION_SLIDER_MIN_PERCENT);
	assert.equal(compactionTokensToPercent(999, 200000), COMPACTION_SLIDER_MIN_PERCENT); // 0.4995% → 抬到 1%
	assert.equal(compactionTokensToPercent(400000, 200000), COMPACTION_SLIDER_MAX_PERCENT); // 200% → 截到 50%
	assert.equal(compactionTokensToPercent(16384, 0), COMPACTION_SLIDER_MIN_PERCENT);
});

test("滑条范围常量：1%–50%；参考窗口 200k（pi 默认值恰为 8%/10%）", () => {
	assert.equal(COMPACTION_SLIDER_MIN_PERCENT, 1);
	assert.equal(COMPACTION_SLIDER_MAX_PERCENT, 50);
	assert.equal(COMPACT_REFERENCE_WINDOW_TOKENS, 200_000);
	// 参考窗口下 pi 默认值落在整数百分比上，滑条刻度与默认值对齐
	assert.equal(compactionTokensToPercent(16384, COMPACT_REFERENCE_WINDOW_TOKENS), 8);
	assert.equal(compactionTokensToPercent(20000, COMPACT_REFERENCE_WINDOW_TOKENS), 10);
});

test("契约：compaction 不再进入「其他设置」兜底列表（去重）", () => {
	const src = readFileSync("src/renderer/src/config/SettingsTab.tsx", "utf8");
	// 空白容忍：filteredEntries 过滤链里显式排除 compaction
	assert.match(src, /key !== "compaction"/);
	// configLabel 不再有 compaction 分支（i18n 键已删，留着分支会显示原始 key）
	assert.doesNotMatch(src, /case "compaction":/);
});

test("契约：百分比滑条始终渲染（无窗口回退分支），基数未知时提示参考窗口", () => {
	const src = readFileSync("src/renderer/src/config/SettingsTab.tsx", "utf8");
	// 空白容忍锚点：Slider 组件 + 双向换算（无条件分支包裹）
	assert.match(src, /^[	 ]*import \{ Slider \} from "\.\.\/components\/ui-shadcn\/slider";/m);
	assert.match(src, /value=\{\[tokensToPercent\(compactionConfig\.reserveTokens\)\]\}/);
	assert.match(src, /value=\{\[tokensToPercent\(compactionConfig\.keepRecentTokens\)\]\}/);
	assert.match(src, /onValueChange=\{\(\[pct\]\) => updateCompaction\(\{ reserveTokens: percentToTokens\(pct \?\? 0\) \}\)\}/);
	// 回退基数：未知窗口按参考窗口换算，滑条不消失
	assert.match(src, /explicitContextWindow \?\? catalogContextWindow \?\? COMPACT_REFERENCE_WINDOW_TOKENS/);
	// 提示按基数来源切换，旧「设置默认模型才可换滑条」提示已废
	assert.match(src, /hasModelWindow \? t\("config\.compaction\.windowBaseHint"/);
	assert.match(src, /: t\("config\.compaction\.windowRefHint"/);
	assert.doesNotMatch(src, /windowUnknownHint/);
});
test("契约：i18n zh/en 同步——新增 2 键存在、废弃的 config.label.compaction 双语已删", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const dict of [zh, en]) {
		assert.ok(dict.includes('"config.compaction.windowBaseHint"'), "windowBaseHint missing");
		assert.ok(dict.includes('"config.compaction.windowRefHint"'), "windowRefHint missing");
		assert.ok(!dict.includes('"config.compaction.windowUnknownHint"'), "stale windowUnknownHint should be removed");
		assert.ok(!dict.includes('"config.label.compaction"'), "stale config.label.compaction should be removed");
		// collapseChangelog 不得因迁移产生重复键
		assert.equal([...dict.matchAll(/"config\.label\.collapseChangelog"/g)].length, 1, "config.label.collapseChangelog must be unique");
	}
});
