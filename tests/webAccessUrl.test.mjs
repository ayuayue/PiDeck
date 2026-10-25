import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { bracketIpv6Host, buildWebAccessUrl, previewHostFromBinding } = loadTsCommonJs("src/renderer/src/components/app/settings/webAccessUrl.ts");

test("bracketIpv6Host: IPv6 地址加方括号，IPv4 不变", () => {
	assert.equal(bracketIpv6Host("::1"), "[::1]");
	assert.equal(bracketIpv6Host("[::1]"), "[::1]");
	assert.equal(bracketIpv6Host("192.168.1.5"), "192.168.1.5");
	assert.equal(bracketIpv6Host("2001:db8::1"), "[2001:db8::1]");
	assert.equal(bracketIpv6Host("[2001:db8::1]"), "[2001:db8::1]");
});

test("buildWebAccessUrl: IPv4 + token 生成可访问 URL", () => {
	assert.equal(buildWebAccessUrl("192.168.1.5", 8765, "t k", true), "http://192.168.1.5:8765?token=t%20k");
});

test("buildWebAccessUrl: requiresAuth=false 不拼 token", () => {
	assert.equal(buildWebAccessUrl("::1", 8765, "x", false), "http://[::1]:8765");
});

test("buildWebAccessUrl: 空 token 不拼参数", () => {
	assert.equal(buildWebAccessUrl("::1", 8765, "", true), "http://[::1]:8765");
});

test("buildWebAccessUrl: IPv6 已带方括号不重复包裹", () => {
	assert.equal(buildWebAccessUrl("[::1]", 8765, "abc", true), "http://[::1]:8765?token=abc");
});

test("previewHostFromBinding: 通配绑定回退 127.0.0.1", () => {
	assert.equal(previewHostFromBinding("0.0.0.0"), "127.0.0.1");
	assert.equal(previewHostFromBinding("::"), "127.0.0.1");
});

test("previewHostFromBinding: 具体地址原样返回", () => {
	assert.equal(previewHostFromBinding("192.168.1.5"), "192.168.1.5");
	assert.equal(previewHostFromBinding("::1"), "::1");
});
