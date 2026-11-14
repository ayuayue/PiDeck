import assert from "node:assert/strict";
import test from "node:test";
import { appUtilsSource } from "./helpers/appUtilsSources.mjs";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

test("App.tsx 与 AppUtils 不再使用 any 透传工具参数/运行态字段", () => {
	const app = rendererAppSource;
	const utils = appUtilsSource;
	assert.doesNotMatch(app, /const args: any = msg\.meta\?\.args/);
	assert.doesNotMatch(app, /\(rt\?\.state as any\)\?\.isStreaming/);
	assert.doesNotMatch(app, /\(rt\?\.state as any\)\?\.isExecutingTool/);
	assert.doesNotMatch(utils, /export function getToolFilePath\(args: any\)/);
});
