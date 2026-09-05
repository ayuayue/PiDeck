import { test } from "node:test";
import assert from "node:assert/strict";
// sessionProxyPolicy 是纯函数模块（无 electron/无 IO），可直接在 node 下测试。
import {
	resolveConfigProxyTarget,
	applyConfigProxyTarget,
} from "../src/main/sessions/sessionProxyPolicy.ts";

// 测试代理目标解析：配置页「测试连接/拉取模型」的代理模式 → 主进程代理策略。

const baseSettings = {
	piProxyUrl: "http://127.0.0.1:7890",
	piProxyBypass: "localhost,127.0.0.1,::1",
	desktopProxyUrl: "http://127.0.0.1:7891",
	desktopProxyBypass: "localhost",
};

test("resolveConfigProxyTarget: follow/undefined 保持跟随全局", () => {
	assert.deepEqual(resolveConfigProxyTarget(baseSettings, undefined), { mode: "follow" });
	assert.deepEqual(resolveConfigProxyTarget(baseSettings, "follow"), { mode: "follow" });
});

test("resolveConfigProxyTarget: pi 模式取 piProxyUrl 与 bypass", () => {
	assert.deepEqual(resolveConfigProxyTarget(baseSettings, "pi"), {
		mode: "on",
		url: "http://127.0.0.1:7890",
		bypass: "localhost,127.0.0.1,::1",
	});
});

test("resolveConfigProxyTarget: desktop 模式取 desktopProxyUrl 与 bypass", () => {
	assert.deepEqual(resolveConfigProxyTarget(baseSettings, "desktop"), {
		mode: "on",
		url: "http://127.0.0.1:7891",
		bypass: "localhost",
	});
});

test("resolveConfigProxyTarget: 所选代理 URL 为空时降级 off（地址都没配就无从代理）", () => {
	assert.deepEqual(
		resolveConfigProxyTarget({ ...baseSettings, piProxyUrl: "  " }, "pi"),
		{ mode: "off" },
	);
	assert.deepEqual(
		resolveConfigProxyTarget({ ...baseSettings, desktopProxyUrl: "" }, "desktop"),
		{ mode: "off" },
	);
});

test("resolveConfigProxyTarget: off 模式恒为 off", () => {
	assert.deepEqual(resolveConfigProxyTarget(baseSettings, "off"), { mode: "off" });
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
	const result = applyConfigProxyTarget(
		{ ...probeSettings, piProxyEnabled: true },
		{ mode: "off" },
	);
	assert.equal(result.piProxyEnabled, false);
});
