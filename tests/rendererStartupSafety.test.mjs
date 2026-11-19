import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const extensionsTabSource = readFileSync("src/renderer/src/config/ExtensionsTab.tsx", "utf8");
const browserApiSource = readFileSync("src/renderer/src/browserApi.ts", "utf8");

test("extensions settings tab does not read preload API at module load", () => {
	// 防模块加载时直接读 preload API：仅约束顶层 `const api` 声明后紧跟的 window.piDesktop 读取
	// （`^` + m flag 锚定行首，函数内延迟读取与 onClick 回调内的运行时访问不受此约束）
	assert.doesNotMatch(extensionsTabSource, /^const\s+api[\s\S]*?window\.piDesktop!?\.[a-zA-Z]/m);
	// 组件已改为经 props / useConfigEditor 拿操作面，不再自己读 window.piDesktop。
	assert.doesNotMatch(extensionsTabSource, /window\.piDesktop/);
});

test("built-in extension failures use the in-app notice instead of native alerts", () => {
	assert.doesNotMatch(extensionsTabSource, /\balert\(/);
	assert.match(extensionsTabSource, /config\.extensionOperationFailed/);
	assert.match(extensionsTabSource, /formatExtensionError/);
});

test("browser API validates web state before replacing renderer lists", () => {
	assert.match(browserApiSource, /function isWebState\(/);
	assert.match(browserApiSource, /Array\.isArray\(.*\.projects\)/);
	assert.match(browserApiSource, /Array\.isArray\(.*\.runtimes\)/);
	assert.doesNotMatch(browserApiSource, /state\.agents|agents:\s*AgentTab/);
	assert.match(browserApiSource, /Invalid web service state payload/);
});
