import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * DSH 子包（dsh-app-boot / dsh-llm 等）用
 *   createRequire(import.meta.url)("../package.json")
 * 读自己的版本号。主进程若把它们打进 out/main，import.meta.url
 * 会变成产物路径，运行时就报
 *   Cannot find module '../package.json'
 *   Require stack: .../out/main/index-*.js
 *
 * 契约：主进程必须把 @deepseek-ai/* 全部 externalize，运行时从
 * node_modules 加载，保留真实包路径。
 */

test("electron-vite main externalizes the whole @deepseek-ai scope", () => {
	const src = readFileSync("electron.vite.config.ts", "utf8");
	assert.match(src, /externalizeDepsPlugin/);
	assert.match(src, /external:\s*\[[\s\S]*\/\^@deepseek-ai\\\//, "main.build.rollupOptions.external 必须包含 /^@deepseek-ai\\//，否则 dsh 子包会被打进 out/main");
});

test("built main chunks do not embed dsh package.json lookups", () => {
	const mainDir = join("out", "main");
	if (!existsSync(mainDir)) {
		// 未构建时跳过产物断言；配置契约测试已覆盖根因。
		return;
	}
	const files = readdirSync(mainDir).filter((name) => name.endsWith(".js"));
	assert.ok(files.length > 0, "out/main 应有主进程产物");
	for (const name of files) {
		const src = readFileSync(join(mainDir, name), "utf8");
		assert.doesNotMatch(src, /createRequire\([\s\S]{0,160}\)\("\.\.\/package\.json"\)/, `${name} 把 DSH 的 createRequire(import.meta.url)("../package.json") 打进了产物；发送 DSH 消息会找不到 ../package.json`);
	}
});
