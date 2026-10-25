/**
 * DesktopProxy.buildDesktopProxyConfig 单测。
 *
 * 背景（真实故障）：用户报告两个第三方中转站（anyrouter.top / agentrouter.org）
 * 在 PiDeck 里既拉不到模型、手填模型也用不了，但在 cc-switch 里正常。
 * 定位到的一条链路是：PiDeck 关闭「桌面代理」开关时会显式下发 `mode: "direct"`。
 * Chromium 的 `direct` 是「强制绕过一切代理」，会连用户系统/企业代理一并屏蔽；
 * 实测本机直连这两个站分别命中 TLS 被干扰（ERR_SSL_VERSION_OR_CIPHER_MISMATCH）
 * 与连接超时，而经代理可正常建连。
 *
 * 期望行为：关闭开关 = `system`（沿用系统代理设置，Electron 默认值），
 * 即「PiDeck 不表态」，永不替用户切断出口。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

// DesktopProxy 依赖 electron（session.defaultSession.setProxy / app.setProxy）与日志模块；
// 本用例只测纯配置组装函数，用桩替换掉这两条依赖即可，无需真实 Electron 环境。
const load = createTsSandbox({
	stubs: {
		electron: {
			session: { defaultSession: { setProxy: async () => undefined } },
			app: { setProxy: async () => undefined },
		},
		"../logging/sharedLogger": {
			getAppLogger: () => ({ info: () => undefined, error: () => undefined }),
		},
	},
});
const { buildDesktopProxyConfig } = load("src/main/settings/DesktopProxy.ts");

const base = {
	desktopProxyEnabled: false,
	desktopProxyUrl: "http://127.0.0.1:7890",
	desktopProxyBypass: "localhost,127.0.0.1",
};

test("关闭桌面代理 → mode 为 system，而非 direct（不得屏蔽系统代理）", () => {
	const config = buildDesktopProxyConfig(base);
	assert.equal(config.mode, "system");
	// 关键回归点：曾经的实现返回 "direct"，那等于强制绕过系统代理 → 用户网络本来能通也通不了。
	assert.notEqual(config.mode, "direct");
});

test("开启桌面代理 + 合法地址 → fixed_servers 带规范化 proxyRules", () => {
	const config = buildDesktopProxyConfig({
		...base,
		desktopProxyEnabled: true,
		desktopProxyUrl: "127.0.0.1:7890",
	});
	assert.equal(config.mode, "fixed_servers");
	// 无协议前缀时应补 http://，否则 Chromium 无法解析该规则
	assert.equal(config.proxyRules, "http://127.0.0.1:7890");
	// bypass 规则统一用分号连接（Chromium 语法），逗号输入需要转换
	assert.equal(config.proxyBypassRules, "localhost;127.0.0.1");
});

test("开启桌面代理但地址非法 → 退回 system（不得降级为 direct）", () => {
	for (const invalid of ["", "   ", "http://"]) {
		const config = buildDesktopProxyConfig({
			...base,
			desktopProxyEnabled: true,
			desktopProxyUrl: invalid,
		});
		assert.equal(config.mode, "system", `地址 ${JSON.stringify(invalid)} 应退回 system`);
	}
});

test("开启桌面代理时空 bypass 不产生多余分隔符", () => {
	const config = buildDesktopProxyConfig({
		...base,
		desktopProxyEnabled: true,
		desktopProxyBypass: " , \n ; ",
	});
	assert.equal(config.mode, "fixed_servers");
	assert.equal(config.proxyBypassRules, "");
});
