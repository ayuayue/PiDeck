import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 全局 deep link 协议注册（e2eProtocolRegistration.ts / #513）：
 * 注册表按 scheme 为键且全局唯一，打包态 E2E 实例若照旧注册 pideck://，
 * 每次跑用例都会把系统里真实安装版的关联改写到临时 userData 的测试实例。
 * 纯决策逻辑 + index.ts 接线契约一起锁。
 */

const { shouldRegisterDeepLinkProtocol } = loadTsCommonJs("src/main/e2eProtocolRegistration.ts");

test("正常打包实例注册协议关联（通知点击依赖它唤起应用）", () => {
	assert.equal(shouldRegisterDeepLinkProtocol({ isPackaged: true, isE2E: false, optIn: false }), true);
});

test("未打包的 dev 实例不注册（否则劫持 electron.exe 的关联）", () => {
	assert.equal(shouldRegisterDeepLinkProtocol({ isPackaged: false, isE2E: false, optIn: false }), false);
	assert.equal(shouldRegisterDeepLinkProtocol({ isPackaged: false, isE2E: true, optIn: true }), false);
});

test("打包态 E2E 实例默认不注册，显式 opt-in 才注册", () => {
	assert.equal(shouldRegisterDeepLinkProtocol({ isPackaged: true, isE2E: true, optIn: false }), false, "E2E 默认不得改写系统协议关联（#513）");
	assert.equal(shouldRegisterDeepLinkProtocol({ isPackaged: true, isE2E: true, optIn: true }), true, "需要验证深链的用例可显式 opt-in");
});

test("index.ts 接线：协议注册经决策函数并支持 PIDECK_E2E_REGISTER_PROTOCOL", () => {
	const source = readFileSync("src/main/index.ts", "utf8");
	assert.match(source, /if \(shouldRegisterDeepLinkProtocol\(\{ isPackaged: app\.isPackaged, isE2E, optIn: process\.env\.PIDECK_E2E_REGISTER_PROTOCOL === "1" \}\)\)/);
	// 不得回退成只看 isPackaged 的裸注册
	assert.doesNotMatch(source, /if \(app\.isPackaged\) \{\s*app\.setAsDefaultProtocolClient/);
});
