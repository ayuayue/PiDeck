import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { isDshSettingsConflict } = loadTsCommonJs("src/main/dsh/DshHost.ts");

test("isDshSettingsConflict: 结构化 code=settings-conflict 命中", () => {
	assert.equal(
		isDshSettingsConflict({
			code: "settings-conflict",
			message: 'settings namespace "llm-pi-ai" changed since it was read (expected revision 0, now 1)',
			details: { ns: "llm-pi-ai", expected: 0, actual: 1 },
		}),
		true,
	);
});

test("isDshSettingsConflict: 下划线/大写 code 变体命中（容错 host 文案演进）", () => {
	assert.equal(isDshSettingsConflict({ code: "SETTINGS_CONFLICT" }), true);
	assert.equal(isDshSettingsConflict({ code: "Settings_Conflict" }), true);
});

test("isDshSettingsConflict: 无 code 但消息含 changed since it was read 命中", () => {
	assert.equal(
		isDshSettingsConflict({ message: 'settings namespace "ns" changed since it was read (expected 0, now 1)' }),
		true,
	);
});

test("isDshSettingsConflict: 非冲突错误不命中", () => {
	assert.equal(isDshSettingsConflict({ code: "schema-rejected", message: "invalid value at /providers" }), false);
	assert.equal(isDshSettingsConflict({ code: "not-writable", message: "settings document is read-only" }), false);
	assert.equal(isDshSettingsConflict(new Error("dsh host is not started")), false);
});

test("isDshSettingsConflict: 非 object 输入（字符串/null/undefined）不命中且不抛", () => {
	assert.equal(isDshSettingsConflict("settings-conflict"), false);
	assert.equal(isDshSettingsConflict(null), false);
	assert.equal(isDshSettingsConflict(undefined), false);
	assert.equal(isDshSettingsConflict(42), false);
});
