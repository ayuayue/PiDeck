import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// 内置扩展描述契约（用户反馈：扩展列表只有名称和路径，不知道各扩展是干什么的；
// pi-deck-subagents 名字还让人误以为"角色是 subagent"，实际是状态桥接）。
// 锁定三件事：
// 1. BUILT_IN_EXTENSIONS 白名单里的每个内置扩展，在 zh-CN / en-US 都有
//    config.builtInExtDesc.<slug> 描述 key（双语同步，防单边遗漏）；
// 2. ExtensionTableRow 确实为 builtIn 行渲染描述（映射表 + t() 接线不被删）；
// 3. pi-deck-subagents 的描述明确「桥接/展示」语义，防止回退成"就是个 subagent"的误导文案。

const read = (p) => readFileSync(p, "utf8");

const builtInNames = (() => {
	const src = read("src/main/extensions/builtInExtensions.ts");
	const block = src.match(/export const BUILT_IN_EXTENSIONS = \[([\s\S]*?)\] as const/);
	assert.ok(block, "BUILT_IN_EXTENSIONS list not found");
	return [...block[1].matchAll(/"(pi-deck-[^"]+\.ts)"/g)].map((m) => m[1]);
})();

test("every built-in extension has a description key in both locales", () => {
	assert.ok(builtInNames.length >= 12, `unexpected built-in list: ${builtInNames.join(",")}`);
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
	for (const name of builtInNames) {
		const key = `"config.builtInExtDesc.${name.replace(/\.ts$/, "")}"`;
		assert.match(zh, new RegExp(`${key}:`), `${key} missing in zh-CN`);
		assert.match(en, new RegExp(`${key}:`), `${key} missing in en-US`);
	}
});

test("extension table row renders built-in descriptions", () => {
	const src = read("src/renderer/src/config/extensionsTableRows.tsx");
	assert.match(src, /BUILT_IN_EXTENSION_DESC/);
	assert.match(src, /extension\.builtIn && BUILT_IN_EXTENSION_DESC\[extension\.source\]/);
	// 每个白名单文件名都在映射表里
	for (const name of builtInNames) {
		assert.match(src, new RegExp(`"${name}":`), `${name} missing in BUILT_IN_EXTENSION_DESC`);
	}
});

test("subagents description states bridging semantics, not dispatching", () => {
	const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const m = zh.match(/"config\.builtInExtDesc\.pi-deck-subagents": "([^"]+)"/);
	assert.ok(m, "subagents description missing");
	assert.match(m[1], /桥接/);
	assert.match(m[1], /不派发子代理/);
});
