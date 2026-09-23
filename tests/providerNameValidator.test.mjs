import assert from "node:assert/strict";
import test from "node:test";
import { isValidProviderName, PROVIDER_NAME_MAX_LENGTH } from "../src/shared/providerName.ts";
import { credentialRefFor } from "../src/shared/dshCredentialRef.ts";

// 配置键不应被 DSH 环境变量引用的 ASCII 规则约束。
test("provider names accept Unicode, digits, spaces and punctuation", () => {
	for (const name of ["openai", "my-provider", "my_provider", "中文供应商", "供应商 2", "2provider", "123", "a.b", "a;b", "a$b", "a&b", "a|b", "a`b", "-leading-dash"]) {
		assert.equal(isValidProviderName(name), true, name);
	}
	assert.equal(isValidProviderName("A".repeat(PROVIDER_NAME_MAX_LENGTH)), true);
});

test("provider names still reject empty, unsafe paths, controls and excessive length", () => {
	for (const name of ["", "   ", "__proto__", "../etc", "a/b", "a\\b", "a..b", "a\u0000b", "a\nb", "a\tb", "a\u007fb", "a".repeat(PROVIDER_NAME_MAX_LENGTH + 1)]) {
		assert.equal(isValidProviderName(name), false, JSON.stringify(name));
	}
});

test("provider names trim surrounding spaces without rejecting internal spaces", () => {
	assert.equal(isValidProviderName("  openai  "), true);
	assert.equal(isValidProviderName("  中文 名称  "), true);
});

test("DSH generates safe references independently of display/config names", () => {
	for (const name of ["中文供应商", "供应商 2", "2provider", "a.b", "-leading-dash"]) {
		const ref = credentialRefFor(undefined, name);
		assert.match(ref, /^[A-Za-z_][A-Za-z0-9_]*$/);
		assert.equal(ref, credentialRefFor(undefined, name));
	}
	assert.notEqual(credentialRefFor(undefined, "中文供应商"), credentialRefFor(undefined, "另一家供应商"));
	assert.equal(credentialRefFor(undefined, "openai"), "OPENAI_API_KEY");
});
