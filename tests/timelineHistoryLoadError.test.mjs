import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const timeline = readFileSync("src/renderer/src/components/session/SessionMessageTimeline.tsx", "utf8");

test("history load failure displays the actual error without requiring a tooltip", () => {
	// 终态守卫会继续细分（sessionFileMissing 即后续新增）：只锚定「error + 非 DSH」头部，
	// 其余守卫不枚举，避免每加一个终态分支就重红。
	const errorState = timeline.match(/\{messageLoadState\?\.status\s*===\s*"error"[\s\S]{0,200}?!dshHostStopped[\s\S]*?\n[\t ]*\)\}/)?.[0];
	assert.ok(errorState, "the non-DSH history error state must remain available");
	assert.match(errorState, /\{messageLoadState\.error\s*&&\s*<p\b[^>]*>\s*\{messageLoadState\.error\}\s*<\/p>\}/);
	assert.doesNotMatch(errorState, /title=\{messageLoadState\.error/);
});

test("history load failure copy does not assume a missing file when parsing can also fail", () => {
	for (const [locale, exportName] of [
		["zh-CN", "zhCN"],
		["en-US", "enUS"],
		["zh-TW", "zhTW"],
	]) {
		const copy = loadTsCommonJs(`src/renderer/src/i18n/rendererCopy.${locale}.ts`)[exportName];
		assert.doesNotMatch(copy["timeline.loadFailedHint"], /已被删除|已被刪除|deleted|路径失效|路徑失效|stale/i);
	}
});
