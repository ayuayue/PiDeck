import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 回归（2026-10 体积审计踩坑）：analyze-asar-waste 的 roots 曾缺以下包，脚本把它们
// 误报为「可安全排除」——照抄进 build.files 会让自动更新（electron-updater）、
// MCP/CUA（zod + @modelcontextprotocol/sdk）、DSH/扩展解析（tar/smol-toml/minimatch/ignore）
// 在运行时 MODULE_NOT_FOUND。undici 必须保留：@deepseek-ai/dsh-http-proxy 与
// dsh-web-fetch-http 运行时 `await import("undici")`（动态 import，静态 grep 抓不到，
// 曾险些被误排除——判定 asar 包可排除必须同时查 asar node_modules 树内的动态 import）。
// 新增 out/main 静态 require 的运行时依赖时同步补 roots（2026-10 已逐一 grep out/main 验证）。
const script = readFileSync("scripts/analyze-asar-waste.js", "utf8");

test("waste-analysis roots keep every package the runtime actually requires", () => {
	const requiredRoots = ["zod", "@modelcontextprotocol/sdk", "tar", "electron-updater", "minimatch", "smol-toml", "ignore", "undici"];
	for (const name of requiredRoots) {
		assert.ok(script.includes(`"${name}"`), `roots must include ${name}（漏了会被误报为可排除，照抄进 build.files 炸运行时）`);
	}
});
