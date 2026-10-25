import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 回归（issue #342）：设置页「启用 Pi agent 代理」主开关在白名单非空时完全失效，
 * 但 UI 上仍是一个可自由拨动的开关 —— 用户反复开关毫无效果，只能靠读源码/试 env 才发现。
 *
 * 语义本身（名单内强制走代理、名单外强制直连）是刻意设计，不改；要守的是
 * 「开关失效时界面必须自曝」：置灰 + 提示，且置灰判据必须与主进程策略同源
 * （共用 shared/piProxyList.ts 的 hasPiProxyListFilter），否则策略一改提示就静默失真。
 *
 * 正则按仓库约定做空白容忍（biome 不折行，但格式化仍可能调整空格）。
 */

const PROXY_TAB = "src/renderer/src/components/app/settings/ProxyTab.tsx";
const source = readFileSync(PROXY_TAB, "utf8");

test("ProxyTab: 置灰判据复用 shared/piProxyList 的 hasPiProxyListFilter（与主进程策略同源）", () => {
	assert.match(source, /import\s*\{[^}]*\bhasPiProxyListFilter\b[^}]*\}\s*from\s*"[^"]*shared\/piProxyList"/, "必须从 shared/piProxyList 导入判据，不得在渲染层另写一份");
	assert.match(source, /const\s+proxyListActive\s*=\s*hasPiProxyListFilter\(\s*draft\.piProxyProviders\s*,\s*draft\.piProxyModels\s*\)/, "proxyListActive 必须由两级名单（含旧版供应商名单）共同决定");
});

test("ProxyTab: 名单启用时主开关置灰并给出「由名单接管」提示", () => {
	// 取出主开关行本体（到自闭合 `/>` 为止），断言两项都落在这一行内：
	// 只绑定 disabled 不给原因 = 用户看到开关变灰却不知为何；只给文案不置灰 = 用户仍能拨动一个毫无效果的开关。
	const switchRow = source.match(/<SettingSwitchRow[\s\S]*?anchor="proxy-enable-pi"[\s\S]*?\n[\t ]*\/>/)?.[0] ?? "";
	assert.ok(switchRow, "找不到「启用 Pi agent 代理」开关行");
	assert.match(switchRow, /disabled=\{proxyListActive\}/, "主开关必须随名单状态置灰");
	assert.match(switchRow, /settings\.piProxySwitchOverridden/, "置灰时必须渲染说明文案（否则置灰原因不可见）");
});
