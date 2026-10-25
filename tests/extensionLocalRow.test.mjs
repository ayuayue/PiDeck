import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const rows = readFileSync("src/renderer/src/config/extensionsTableRows.tsx", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("本地目录包行显示本地徽标", () => {
	assert.match(rows, /extension\.local\s*&&\s*<span[\s\S]{0,120}?config\.source\.local/, "本地包行必须渲染 config.source.local 徽标");
});

test("本地目录包的版本列只显示本地版本，不展示最新版本", () => {
	assert.match(rows, /extension\.local[\s\S]{0,200}?config\.extensionLocalVersion/, "本地包必须走 config.extensionLocalVersion 分支");
});

test("本地版本相关 i18n key 在 zh-CN / en-US 都存在", () => {
	for (const key of ["config.source.local", "config.extensionLocalVersion"]) {
		assert.ok(zhCN.includes(`"${key}"`), `zh-CN 缺少 ${key}`);
		assert.ok(enUS.includes(`"${key}"`), `en-US 缺少 ${key}`);
	}
});
