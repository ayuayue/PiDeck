import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/** vm 沙箱与宿主不同 realm，strict deepEqual 会比原型；统一转成宿主纯值再比。 */
function eqDeep(actual, expected) {
	assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
}

// sessionProxyPolicy 是纯函数模块（无 electron/无 IO），可直接在 node 下测试。
// 走 loadTsCommonJs 而不是原生 ESM import：模块内的本地 import 不带扩展名（打包器负责解析），
// Node 的 ESM 解析器要求显式扩展名，直接 import 会让整条模块图 ERR_MODULE_NOT_FOUND。
const { resolveConfigProxyTarget, applyConfigProxyTarget } = loadTsCommonJs("src/main/sessions/sessionProxyPolicy.ts");

// 测试代理目标解析：配置页「测试连接/拉取模型」的代理模式 → 主进程代理策略。

const baseSettings = {
	piProxyUrl: "http://127.0.0.1:7890",
	piProxyBypass: "localhost,127.0.0.1,::1",
	desktopProxyUrl: "http://127.0.0.1:7891",
	desktopProxyBypass: "localhost",
};

test("resolveConfigProxyTarget: follow/undefined 保持跟随全局", () => {
	eqDeep(resolveConfigProxyTarget(baseSettings, undefined), { mode: "follow" });
	eqDeep(resolveConfigProxyTarget(baseSettings, "follow"), { mode: "follow" });
});

test("resolveConfigProxyTarget: pi 模式取 piProxyUrl 与 bypass", () => {
	eqDeep(resolveConfigProxyTarget(baseSettings, "pi"), {
		mode: "on",
		url: "http://127.0.0.1:7890",
		bypass: "localhost,127.0.0.1,::1",
	});
});

test("resolveConfigProxyTarget: desktop 模式取 desktopProxyUrl 与 bypass", () => {
	eqDeep(resolveConfigProxyTarget(baseSettings, "desktop"), {
		mode: "on",
		url: "http://127.0.0.1:7891",
		bypass: "localhost",
	});
});

test("resolveConfigProxyTarget: 所选代理 URL 为空时降级 off（地址都没配就无从代理）", () => {
	eqDeep(resolveConfigProxyTarget({ ...baseSettings, piProxyUrl: "  " }, "pi"), { mode: "off" });
	eqDeep(resolveConfigProxyTarget({ ...baseSettings, desktopProxyUrl: "" }, "desktop"), { mode: "off" });
});

test("resolveConfigProxyTarget: off 模式恒为 off", () => {
	eqDeep(resolveConfigProxyTarget(baseSettings, "off"), { mode: "off" });
});

// 测试代理目标应用到探针进程设置：pi 侧只认 piProxy* 配置。

const probeSettings = {
	piProxyEnabled: false,
	piProxyUrl: "http://127.0.0.1:7890",
	piProxyBypass: "localhost,127.0.0.1,::1",
};

test("applyConfigProxyTarget: undefined/follow 原样返回（不产生新对象）", () => {
	assert.equal(applyConfigProxyTarget(probeSettings, undefined), probeSettings);
	assert.equal(applyConfigProxyTarget(probeSettings, { mode: "follow" }), probeSettings);
});

test("applyConfigProxyTarget: on 强制开启并覆盖 URL（即使全局 piProxyEnabled 为关）", () => {
	const result = applyConfigProxyTarget(probeSettings, {
		mode: "on",
		url: "http://127.0.0.1:7897",
		bypass: "internal.local",
	});
	assert.equal(result.piProxyEnabled, true);
	assert.equal(result.piProxyUrl, "http://127.0.0.1:7897");
	assert.equal(result.piProxyBypass, "internal.local");
});

test("applyConfigProxyTarget: off 强制关闭（即使全局开）", () => {
	const result = applyConfigProxyTarget({ ...probeSettings, piProxyEnabled: true }, { mode: "off" });
	assert.equal(result.piProxyEnabled, false);
});
