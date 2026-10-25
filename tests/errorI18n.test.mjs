/**
 * shared/errorI18n：thrown Error → I18nDescriptor 提取通道。
 * 锁定透传契约：挂载 i18nKey 的错误透传本地化键 + 参数 + debugDetails；
 * 未挂载的错误返回 undefined（调用方回落通用「发送失败」描述符）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { descriptorFromThrownError } = loadTsCommonJs("src/shared/errorI18n.ts");

test("挂载 i18nKey 的错误透传完整描述符（键 + 参数 + 显式 debugDetails 优先）", () => {
	const error = Object.assign(new Error("RPC -32000 Authentication required"), {
		i18nKey: "acp.authRequired",
		i18nParams: { tool: "Kimi CLI" },
		debugDetails: "Authentication required",
	});
	const descriptor = descriptorFromThrownError(error);
	// 字段断言而非 deepStrictEqual：loadTsCommonJs 经 vm.runInNewContext 造车，
	// 返回对象原型链跨 realm，整件深等恒失败。
	assert.equal(descriptor.i18nKey, "acp.authRequired");
	assert.deepEqual(descriptor.i18nParams, { tool: "Kimi CLI" });
	assert.equal(descriptor.debugDetails, "Authentication required");
});

test("缺省 debugDetails 回落 error.message（根因必须随 toast 带出）", () => {
	const error = Object.assign(new Error("raw cli failure"), { i18nKey: "acp.turnBusy" });
	const descriptor = descriptorFromThrownError(error);
	assert.equal(descriptor.i18nKey, "acp.turnBusy");
	assert.equal(descriptor.debugDetails, "raw cli failure");
	assert.equal(descriptor.i18nParams, undefined);
});

test("未挂载 i18nKey 的错误返回 undefined（普通错误不配本地化通道）", () => {
	assert.equal(descriptorFromThrownError(new Error("plain failure")), undefined);
	assert.equal(descriptorFromThrownError("not an error"), undefined);
	assert.equal(descriptorFromThrownError(null), undefined);
	assert.equal(descriptorFromThrownError(undefined), undefined);
});

test("空白 i18nKey 视为未挂载（Toast 键查不到时不能产生空文案）", () => {
	assert.equal(descriptorFromThrownError(Object.assign(new Error("x"), { i18nKey: "  " })), undefined);
});
