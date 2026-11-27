import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

/**
 * 用 TypeScript API 把 .ts 转 CJS 再跑。
 *
 * 为什么走转译而不用 import：仓库标准写法（tests/turnRenderWindow.test.mjs 那套，97 个测试在用）。
 *
 * 注意：这条不是「Node 不认 .ts」——Node 26 有 strip-only 模式，纯类型注解的 .ts 能直接跑。
 * 真正卡住的是 parameter property（constructor(private x: T)），strip-only 不支持：
 *   ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX: TypeScript parameter property is not supported in strip-only mode
 * jumpReplay 那条就是因为 import 了带 parameter property 的 SessionHistoryReader 才加载失败。
 */
// jumpTarget.ts 现在依赖 shared/sessionJumpAnchor（注入标记判定）：
// vm 的 require 必须把这份真实模块交进去，否则 isJumpInjectedAnchorMeta 是 undefined。
function compile(filePath, deps = {}) {
	const output = ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: (id) => deps[id] ?? {} });
	return module.exports;
}

const shared = compile("src/shared/sessionJumpAnchor.ts");
const target = compile("src/renderer/src/components/session/timeline/jumpTarget.ts", { "../../../../../shared/sessionJumpAnchor": shared });

const msg = (entryId, kind = "history") => ({ id: "_v-" + kind + "-" + entryId, meta: { entryId } });

test("exact：目标就在页里，锚点就是它自己", () => {
	const page = [msg("a"), msg("b"), msg("c")];
	assert.equal(target.pickJumpAnchorEntryId(page, "b"), "b");
});

test("positioned：目标不在，退到页里最后一条 history 消息", () => {
	const page = [msg("a"), msg("b")];
	assert.equal(target.pickJumpAnchorEntryId(page, "zzz"), "b");
});

test("页尾是卡片时跳过它们，只取 history", () => {
	const page = [msg("a"), msg("b"), msg("card1", "custom"), msg("meta1", "meta")];
	assert.equal(target.pickJumpAnchorEntryId(page, "zzz"), "b");
});

test("整页全是卡片：返回 undefined，调用方不得硬跳", () => {
	const page = [msg("card1", "custom"), msg("card2", "custom")];
	assert.equal(target.pickJumpAnchorEntryId(page, "zzz"), undefined);
});

test("空页：返回 undefined", () => {
	assert.equal(target.pickJumpAnchorEntryId([], "a"), undefined);
});

test("目标 entryId 为空：返回 undefined", () => {
	assert.equal(target.pickJumpAnchorEntryId([msg("a")], ""), undefined);
});
