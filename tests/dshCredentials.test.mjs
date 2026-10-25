import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { credentialValueFromDocument, isValidCredentialRef } = loadTsCommonJs("src/main/dsh/dshCredentials.ts");

test("credentialValueFromDocument: 解析严格 ref→value 映射", () => {
	const doc = ["# credentials document", "DEEPSEEK_API_KEY: sk-abc123", 'OPENCODE_API_KEY: "quoted-value"', ""].join("\n");
	assert.equal(credentialValueFromDocument(doc, "DEEPSEEK_API_KEY"), "sk-abc123");
	assert.equal(credentialValueFromDocument(doc, "OPENCODE_API_KEY"), "quoted-value");
});

test("credentialValueFromDocument: 支持 dsh-credentials-local v1（version:1 + refs）", () => {
	const doc = ["version: 1", "refs:", '  DEEPSEEK_API_KEY: "sk-v1-value"', '  PIDECK_41795A93_API_KEY: "sk-pideck-value"', ""].join("\n");
	assert.equal(credentialValueFromDocument(doc, "DEEPSEEK_API_KEY"), "sk-v1-value");
	assert.equal(credentialValueFromDocument(doc, "PIDECK_41795A93_API_KEY"), "sk-pideck-value");
	// v1 里不存在的 ref 返回 undefined，不回退到顶层误读
	assert.equal(credentialValueFromDocument(doc, "OTHER_KEY"), undefined);
});

test("credentialValueFromDocument: v1 refs 层优先，扁平顶层兜底", () => {
	// 文档同时有 refs 层与顶层同名键：v1 的 refs 优先
	const doc = ["version: 1", "refs:", '  DEEPSEEK_API_KEY: "sk-from-refs"', 'DEEPSEEK_API_KEY: "sk-flat"', ""].join("\n");
	assert.equal(credentialValueFromDocument(doc, "DEEPSEEK_API_KEY"), "sk-from-refs");
});

test("credentialValueFromDocument: 缺失 ref 返回 undefined", () => {
	const doc = "DEEPSEEK_API_KEY: sk-abc123\n";
	assert.equal(credentialValueFromDocument(doc, "OTHER_KEY"), undefined);
});

test("credentialValueFromDocument: 畸形文档/非映射根/非字符串值 → undefined（不抛错）", () => {
	assert.equal(credentialValueFromDocument("not: [valid: yaml", "DEEPSEEK_API_KEY"), undefined);
	assert.equal(credentialValueFromDocument("- list\n- of\n- items\n", "DEEPSEEK_API_KEY"), undefined);
	assert.equal(credentialValueFromDocument("DEEPSEEK_API_KEY: 12345\n", "DEEPSEEK_API_KEY"), undefined);
	assert.equal(credentialValueFromDocument("", "DEEPSEEK_API_KEY"), undefined);
});

test("credentialValueFromDocument: 空串值视为未配置", () => {
	const doc = 'DEEPSEEK_API_KEY: ""\n';
	assert.equal(credentialValueFromDocument(doc, "DEEPSEEK_API_KEY"), undefined);
});

test("isValidCredentialRef: 只接受 POSIX 标识符（防路径注入）", () => {
	assert.equal(isValidCredentialRef("DEEPSEEK_API_KEY"), true);
	assert.equal(isValidCredentialRef("_KEY"), true);
	assert.equal(isValidCredentialRef("my-key"), false, "连字符不是合法 env 名");
	assert.equal(isValidCredentialRef("../etc/passwd"), false);
	assert.equal(isValidCredentialRef(""), false);
	assert.equal(isValidCredentialRef("1ABC"), false, "数字开头不是合法 env 名");
});
