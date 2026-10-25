import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

// 守卫：src/main/index.ts 的运行日志必须走 appLogger（AGENTS.md「日志走主进程 logging 模块」）。
// 例外白名单：
// - 进程级兜底（uncaughtException/unhandledRejection，此时 logging 模块未必可用）
// - 开发者工具彩蛋（console.log("%c...") 美化输出，仅渲染层可见）
// - 启动失败 catch 的 console.error 允许保留终端直出，但必须同 hunk 追加 appLogger 双写
const ALLOWED_PREFIXES = [
	'console.error("Uncaught exception:',
	'console.error("Unhandled rejection:',
	'console.error("Failed to migrate legacy built-in extensions:',
	'console.error("Failed to ensure pi settings defaults:',
	'console.error("Failed to start web service:',
	'console.error("Failed to start memory profile:',
	'console.error("Failed to start developer diagnostics:',
	'console.error("Application startup failed:',
];

const source = readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
const lines = source.split(/\r?\n/);

const offenders = [];
for (let i = 0; i < lines.length; i++) {
	const line = lines[i];
	const match = /\bconsole\.(log|debug|info|warn|error)\s*\(/.exec(line);
	if (!match) continue;
	// 彩蛋：渲染层样式输出（"%c" 开头的模板串）
	if (line.includes('console.log("%c')) continue;
	if (ALLOWED_PREFIXES.some((prefix) => line.includes(prefix))) {
		// 双写守卫：白名单 console.error 前后 3 行内必须有配对的 appLogger 调用（进程兑底两处写在 console 之前）
		const nearby = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
		if (/void\s+appLogger\?\.(error|warn|info)\s*\(/.test(nearby)) continue;
		offenders.push(`line ${i + 1}: allowed prefix without paired appLogger write — ${line.trim()}`);
		continue;
	}
	// 彩蛋：渲染层样式输出（console.log 调用含 "%c" 样式或空串分隔行，跨行参数拼接后判定）
	if (/\bconsole\.log\s*\(/.test(line)) {
		const joined = `${line}${lines[i + 1] ?? ""}`;
		if (joined.includes('"%c') || joined.trimEnd().endsWith('console.log("")') || line.includes('console.log("")')) continue;
	}
	offenders.push(`line ${i + 1}: ${line.trim()}`);
}

test("main index.ts runtime logging goes through appLogger, no stray console calls", () => {
	assert.deepEqual(offenders, []);
});
