import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const source = readFileSync("src/shared/ipc.ts", "utf8");

test("已删除无任何 handler/preload 引用的死通道常量", () => {
	assert.doesNotMatch(source, /skillStoreGet: "skill-store:get"/);
	assert.doesNotMatch(source, /feishuQrCode: "feishu:qr-code"/);
	assert.doesNotMatch(source, /feishuAutoGroup: "feishu:auto-group"/);
});

// ── 通用死通道守卫（2026-03 手工清点 641 通道全有主后固化）────────────────────
// 黑名单只防三个已删常量复活；本检查防「新增通道漏三处同步」——AGENTS.md 硬规则：
// 通道常量、main handler、preload 白名单三处同步，漏一处运行时 undefined。
// 「有主」判定宽进：属性访问（ipcChannels.xxx / .xxx）或字面量值任一出现在
// src/ 或 tests/ 即算消费。EventEmitter 域事件复用（AgentManager this.emit
// (ipcChannels.agentsMessage)）、双 preload（hostPlugin.ts）、域内注册（pet/）
// 全都经属性访问命中，无需豁免清单。
function collectSourceChunks() {
	const chunks = [];
	const walk = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walk(p);
			else if (/\.(ts|tsx|mjs)$/.test(entry.name) && p.replaceAll("\\", "/") !== "src/shared/ipc.ts") chunks.push(readFileSync(p, "utf8"));
		}
	};
	walk("src");
	const walkTests = (dir) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const p = join(dir, entry.name);
			if (entry.isDirectory()) walkTests(p);
			else if (entry.name.endsWith(".mjs")) chunks.push(readFileSync(p, "utf8"));
		}
	};
	walkTests("tests");
	return chunks.join("\n");
}

test("shared/ipc 通道常量全部有消费方（防新增死通道）", () => {
	const entries = [...source.matchAll(/^\s*([a-zA-Z0-9_]+): "([a-zA-Z:._-]+)"/gm)].map((m) => [m[1], m[2]]);
	assert.ok(entries.length > 600, `通道常量数异常偏小：${entries.length}（正则或文件结构变了？）`);
	const haystack = collectSourceChunks();
	const dead = entries.filter(([name, value]) => !haystack.includes(`.${name}`) && !haystack.includes(value));
	assert.deepEqual(
		dead.map(([name]) => name),
		[],
		"以下通道常量在 src/ 与 tests/ 全无引用（漏三处同步，或已废弃应删除）",
	);
});
