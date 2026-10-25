import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 用量统计跨层契约护栏：
 *  - IPC 通道三处同步（shared/ipc.ts ↔ main handler ↔ preload ↔ previewApi stub）
 *  - 渲染层 i18n 中英文 key 同步
 *  - 通道命名遵循 domain:action
 */

const ipc = readFileSync("src/shared/ipc.ts", "utf8");
const handler = readFileSync("src/main/ipc/usageStatsIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const previewApi = readFileSync("src/renderer/src/previewApi.ts", "utf8");
// 新架构 i18n 按语言拆分为 rendererCopy.{zh-CN,en-US}.ts（旧单文件 i18n.ts 只含类型/工具）
const i18nZh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const i18nEn = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

const CHANNELS = ["usageStatsDetect", "usageStatsRefresh", "usageStatsGet"];

test("usage-stats channels are declared in shared/ipc.ts with domain:action names", () => {
	for (const key of CHANNELS) {
		assert.match(ipc, new RegExp(`${key}:\\s*"usage-stats:[a-z-]+"`), key);
	}
	assert.match(ipc, /usageStatsDetect:\s*"usage-stats:detect"/);
	assert.match(ipc, /usageStatsRefresh:\s*"usage-stats:refresh"/);
	assert.match(ipc, /usageStatsGet:\s*"usage-stats:get"/);
});

test("main handler registers every usage-stats channel", () => {
	for (const key of CHANNELS) {
		assert.match(handler, new RegExp(`ipc\\.handle\\(ipcChannels\\.${key}`), key);
	}
});

test("preload exposes the usageStats group with all three methods", () => {
	assert.match(preload, /usageStats:\s*\{/);
	assert.match(preload, /detect:\s*\(\)/);
	assert.match(preload, /refresh:\s*\(\)/);
	assert.match(preload, /get:\s*\(\)/);
	for (const key of CHANNELS) {
		assert.match(preload, new RegExp(`ipcChannels\\.${key}`), key);
	}
});

test("previewApi stub keeps the PiDesktopApi shape (usageStats group present)", () => {
	assert.match(previewApi, /usageStats:\s*\{/);
	assert.match(previewApi, /installed: false/);
	assert.match(previewApi, /get: async \(\) => null/);
});

test("i18n zh-CN and en-US dictionaries carry the same usageStats keys", () => {
	const zhSection = i18nZh;
	const enSection = i18nEn;
	const zhKeys = [...zhSection.matchAll(/"(usageStats\.[a-zA-Z0-9.]+)"/g)].map((m) => m[1]);
	const enKeys = [...enSection.matchAll(/"(usageStats\.[a-zA-Z0-9.]+)"/g)].map((m) => m[1]);
	assert.ok(zhKeys.length >= 25, `expected a full key set, got ${zhKeys.length}`);
	assert.deepEqual([...zhKeys].sort(), [...enKeys].sort(), "zh-CN and en-US usageStats key sets must match");
	// 必含的 tab key
	assert.ok(zhKeys.includes("usageStats.cards.totalTokens"));
	assert.ok(zhKeys.includes("usageStats.heatmap.title"));
});
