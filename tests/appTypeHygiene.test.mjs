import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("App.tsx 与 AppUtils 不再使用 any 透传工具参数/运行态字段", () => {
	const app = readFileSync("src/renderer/src/App.tsx", "utf8");
	const utils = readFileSync("src/renderer/src/components/app/AppUtils.ts", "utf8");
	assert.doesNotMatch(app, /const args: any = msg\.meta\?\.args/);
	assert.doesNotMatch(app, /\(rt\?\.state as any\)\?\.isStreaming/);
	assert.doesNotMatch(app, /\(rt\?\.state as any\)\?\.isExecutingTool/);
	assert.doesNotMatch(utils, /export function getToolFilePath\(args: any\)/);
});
