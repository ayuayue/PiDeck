/**
 * 「DSH 运行时未安装」错误契约（#375）。
 *
 * 背景：@deepseek-ai/* 外置为 runtime 资源后，未安装 runtime 时 host 引导的
 * require.resolve 必然失败。修复前原始 MODULE_NOT_FOUND 一路抛到渲染层，
 * 会话历史分页整页失败且原因不可读；修复后要能被识别成「可解释的不可用」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { DSH_RUNTIME_MISSING_ERROR, isDshRuntimeMissingMessage } = loadTsCommonJs("src/shared/dshRuntimeMissing.ts");
const { dshRuntimeMissingError, dshRuntimeMissingPageFor, isDshRuntimeMissingError } = loadTsCommonJs("src/main/dsh/dshRuntimeMissing.ts");

test("sentinel is stable and readable", () => {
	assert.equal(DSH_RUNTIME_MISSING_ERROR, "DSH_RUNTIME_MISSING");
	assert.equal(isDshRuntimeMissingMessage(`${DSH_RUNTIME_MISSING_ERROR}: detail`), true);
	assert.equal(isDshRuntimeMissingMessage("Cannot find module '@deepseek-ai/dsh-base'"), false);
});

test("dshRuntimeMissingError carries root cause and recovery hint", () => {
	const cause = new Error("Cannot find module '@deepseek-ai/dsh-base/package.json'");
	const error = dshRuntimeMissingError("C:/app/resources/app.asar", cause);
	assert.ok(error.message.startsWith(DSH_RUNTIME_MISSING_ERROR));
	// 解析基准要出现在消息里，否则用户没法判断是 runtime 路径配错还是没装
	assert.ok(error.message.includes("C:/app/resources/app.asar"));
	// 原始 MODULE_NOT_FOUND 不能被吞掉，它是定位依据
	assert.ok(error.message.includes("Cannot find module '"));
	assert.equal(isDshRuntimeMissingError(error), true);
});

test("dshRuntimeMissingError tolerates non-Error causes", () => {
	const error = dshRuntimeMissingError("/tmp/runtime", "plain string failure");
	assert.ok(error.message.includes("plain string failure"));
	assert.equal(isDshRuntimeMissingError(error), true);
});

test("dshRuntimeMissingPageFor maps to the unavailable contract", () => {
	const page = dshRuntimeMissingPageFor(dshRuntimeMissingError("/tmp/runtime", new Error("boom")));
	assert.ok(page);
	assert.equal(page.unavailable, "dsh-runtime-missing");
	assert.equal(page.messages.length, 0);
	assert.equal(page.total, 0);
	assert.equal(page.nextBefore, null);
});

test("dshRuntimeMissingPageFor ignores unrelated errors", () => {
	assert.equal(dshRuntimeMissingPageFor(new Error("host crashed")), null);
	assert.equal(dshRuntimeMissingPageFor("not an error"), null);
	assert.equal(dshRuntimeMissingPageFor(undefined), null);
});
