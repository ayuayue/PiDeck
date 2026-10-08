/**
 * ACP 工具登记表消毒/校验纯函数单测。
 * 覆盖:非法条目丢弃(不阻断整表)、字段归一(去空白/限长/控制字符)、
 * 重复 id/name 去重、args 只收非空字符串、上限截断、validateAcpTool 表单语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sanitizeAcpTools, validateAcpTool, createAcpToolId } = loadTsCommonJs("src/main/acp/acpToolConfig.ts");

const validTool = { id: "t1", name: "Gemini CLI", command: "gemini", args: ["--acp"], enabled: true };

test("sanitizeAcpTools keeps valid entries and fills defaults", () => {
	const tools = sanitizeAcpTools([validTool, { name: "no-id tool", command: "kimi" }]);
	assert.equal(tools.length, 2);
	// VM 沙箱 realm 与主 realm 原型不同，deepStrictEqual 会失配：序列化后比对。
	assert.equal(JSON.stringify(tools[0]), JSON.stringify(validTool));
	// 无 id 条目自动生成 id,enabled 缺省 true
	assert.match(tools[1].id, /^acp-tool-/);
	assert.equal(tools[1].enabled, true);
	assert.equal(JSON.stringify(tools[1].args), "[]");
});

test("sanitizeAcpTools drops non-array / non-object / empty-field entries instead of rejecting the table", () => {
	assert.equal(sanitizeAcpTools(undefined).length, 0);
	assert.equal(sanitizeAcpTools("nope").length, 0);
	const tools = sanitizeAcpTools(["junk", null, { id: "ok", name: "ok", command: "ok" }, { id: "no-name", command: "x" }, { id: "no-command", name: "x" }, { id: "blank", name: "   ", command: "x" }]);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].id, "ok");
});

test("sanitizeAcpTools trims fields and rejects control characters", () => {
	const tools = sanitizeAcpTools([{ id: "t", name: "  Gemini  ", command: " gemini " }]);
	assert.equal(tools[0].name, "Gemini");
	assert.equal(tools[0].command, "gemini");
	const evil = sanitizeAcpTools([{ id: "e", name: "bad\u0007name", command: "x" }]);
	assert.equal(evil.length, 0);
	const evilArgs = sanitizeAcpTools([{ id: "e", name: "n", command: "c", args: ["ok", "", 42, "  "] }]);
	assert.equal(JSON.stringify(evilArgs[0].args), JSON.stringify(["ok"]));
});

test("sanitizeAcpTools dedupes by id and by display name", () => {
	const tools = sanitizeAcpTools([
		{ id: "a", name: "Same", command: "one" },
		{ id: "a", name: "Same-id", command: "two" },
		{ id: "b", name: "Same", command: "three" },
	]);
	assert.equal(tools.length, 1);
	assert.equal(tools[0].command, "one");
});

test("sanitizeAcpTools caps list and args lengths", () => {
	const many = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `T${i}`, command: "c" }));
	assert.equal(sanitizeAcpTools(many).length, 32);
	const longArgs = Array.from({ length: 50 }, (_, i) => `arg${i}`);
	assert.equal(sanitizeAcpTools([{ id: "t", name: "n", command: "c", args: longArgs }])[0].args.length, 32);
});

test("validateAcpTool requires name and command with duplicate-name check", () => {
	assert.equal(validateAcpTool({ name: "", command: "c" }).ok, false);
	assert.equal(validateAcpTool({ name: "n", command: " " }).ok, false);
	const existing = [validTool];
	assert.equal(validateAcpTool({ name: "Gemini CLI", command: "other" }, existing).reasonKey, "acp.toolDuplicateName");
	// 编辑自身(id 相同)不判重
	const editing = validateAcpTool({ id: "t1", name: "Gemini CLI", command: "other" }, existing);
	assert.equal(editing.ok, true);
	assert.equal(editing.tool.id, "t1");
	// 新建合法条目分配新 id
	const fresh = validateAcpTool({ name: "New", command: "new-cli", args: ["acp"] }, existing);
	assert.equal(fresh.ok, true);
	assert.match(fresh.tool.id, /^acp-tool-/);
});

test("createAcpToolId is unique-ish across calls", () => {
	const ids = new Set(Array.from({ length: 50 }, () => createAcpToolId()));
	assert.equal(ids.size, 50);
});

test("sanitizeAcpTools keeps only well-formed env entries (valid key names, bounded values)", () => {
	const tools = sanitizeAcpTools([
		{
			id: "t",
			name: "n",
			command: "c",
			env: {
				ZAI_CODING_KEY: "sk-abc123",
				"bad-key": "dropped",
				"9START": "dropped",
				EMPTY: "",
				CTRL: "va\u0007lue",
				NOT_STRING: 42,
			},
		},
	]);
	assert.equal(tools.length, 1);
	// 合法键名 + 合法值才保留;空值/控制字符/非字符串/非法键名一律丢弃
	assert.equal(JSON.stringify(tools[0].env), JSON.stringify({ ZAI_CODING_KEY: "sk-abc123" }));
	// 无 env 字段或消毒后为空 → 不产出空对象
	assert.equal(sanitizeAcpTools([{ id: "t2", name: "n2", command: "c", env: { "1bad": "x" } }])[0].env, undefined);
});

test("validateAcpTool carries env into the normalized tool", () => {
	const result = validateAcpTool({ name: "Codex", command: "codex-acp", args: [], env: { ZAI_CODING_KEY: "sk-xyz" } });
	assert.equal(result.ok, true);
	assert.equal(JSON.stringify(result.tool.env), JSON.stringify({ ZAI_CODING_KEY: "sk-xyz" }));
});
