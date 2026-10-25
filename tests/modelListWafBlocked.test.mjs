// WAF / 人机验证拦截的失败分类测试。
// 背景（真实故障）：网关返回 HTTP 200 但正文是 JS 挑战页 HTML，pi 侧 JSON 解析失败
// 抛 `Unexpected token '<'`——看起来像"配置损坏"，实际是"被拦了"。两者可操作动作
// 完全不同（改配置 vs 换代理/配 UA），所以 must 单独成类。
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isWafBlockedSignal } = loadTsCommonJs("src/main/pi/modelListCache.ts");

test("识别 HTML 挑战页导致的 JSON 解析失败（最具误导性的一类）", () => {
	assert.equal(isWafBlockedSignal("Unexpected token '<', \"<!DOCTYPE ht\"... is not valid JSON"), true);
	assert.equal(isWafBlockedSignal("Unexpected token < in JSON at position 0"), true);
	assert.equal(isWafBlockedSignal("Response body is not valid JSON"), true);
});

test("识别网关自报身份 / 拦截动作", () => {
	assert.equal(isWafBlockedSignal("Request blocked by WAF"), true);
	assert.equal(isWafBlockedSignal("Access Denied"), true);
	assert.equal(isWafBlockedSignal("Sorry, you have been blocked"), true);
	assert.equal(isWafBlockedSignal("Just a moment..."), true);
	assert.equal(isWafBlockedSignal("Attention Required! | Cloudflare"), true);
	assert.equal(isWafBlockedSignal("cf-browser-verification required"), true);
	assert.equal(isWafBlockedSignal("Please complete the captcha challenge"), true);
});

test("识别链路通但被拒绝：403 / 429", () => {
	assert.equal(isWafBlockedSignal("HTTP 403 Forbidden"), true);
	assert.equal(isWafBlockedSignal("request failed with status 403"), true);
	assert.equal(isWafBlockedSignal("HTTP 429 Too Many Requests"), true);
});

// 反面：以下是真正该归到 config-invalid / cli-failed / version-too-old 的错误，
// 不能被 WAF 规则误吞——误吞会把用户从"改配置"误导到"换代理"。
test("不误吞真正的配置 / CLI / 版本错误", () => {
	assert.equal(isWafBlockedSignal("models.json parse failed at line 3: missing }"), false);
	assert.equal(isWafBlockedSignal("unknown option --list-models"), false);
	assert.equal(isWafBlockedSignal("pi not found"), false);
	assert.equal(isWafBlockedSignal("spawn ENOENT"), false);
	assert.equal(isWafBlockedSignal("network timeout"), false);
});

test("空串 / 空输入不抛（分类函数在每条失败路径上都会被调用）", () => {
	assert.equal(isWafBlockedSignal(""), false);
});

test("大小写不敏感", () => {
	assert.equal(isWafBlockedSignal("just a moment"), true);
	assert.equal(isWafBlockedSignal("blocked by waf"), true);
});
