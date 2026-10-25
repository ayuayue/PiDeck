import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { testPiProxy } = loadTsCommonJs("src/main/pi/PiProxyTester.ts");

// 回归测试：代理配置与全局开关解耦（#issue 需求）——未启用全局代理时，
// 只要已配置地址，即可测试地址可用性（单会话「会话代理」on 模式会复用同一地址）。
// 只覆盖不触网分支（本地断言），真实网络路径由用户手动点击测试。
// translate 用 identity，直接断言返回的 i18n key。

const DEFAULT_TEST_URL = "https://api.openai.com/v1/models";
const translate = (key) => key;

test("未启用代理且地址为空 → addressRequired（门禁已移除，走到地址校验）", async () => {
	const result = await testPiProxy({ piProxyEnabled: false, piProxyUrl: "  ", piProxyBypass: "" }, DEFAULT_TEST_URL, translate);
	assert.equal(result.success, false);
	assert.equal(result.error, "mainProxy.addressRequired");
});

test("未启用代理但地址有效且目标命中 bypass → bypassed，不触网", async () => {
	const result = await testPiProxy({ piProxyEnabled: false, piProxyUrl: "http://127.0.0.1:7890", piProxyBypass: "api.openai.com" }, DEFAULT_TEST_URL, translate);
	assert.equal(result.success, false);
	assert.equal(result.error, "mainProxy.bypassed");
	assert.equal(result.bypassed, true);
});

test("启用代理 + bypass 命中目标 → 同样 bypassed（未回归）", async () => {
	const result = await testPiProxy({ piProxyEnabled: true, piProxyUrl: "http://127.0.0.1:7890", piProxyBypass: "*.openai.com" }, DEFAULT_TEST_URL, translate);
	assert.equal(result.success, false);
	assert.equal(result.error, "mainProxy.bypassed");
	assert.equal(result.bypassed, true);
});
