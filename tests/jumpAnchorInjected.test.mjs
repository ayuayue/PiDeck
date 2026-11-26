import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

const SHARED_ID = "../../../../../shared/sessionJumpAnchor";
const SHARED_FILE = "src/shared/sessionJumpAnchor.ts";
const TARGET_FILE = "src/renderer/src/components/session/timeline/jumpTarget.ts";

/** 依赖按 specifier 注入（变异体走 deps），其余相对 import 由沙箱按源文件目录解析。 */
const compile = (filePath, deps = {}) => createTsSandbox({ stubs: deps })(filePath);

const shared = compile(SHARED_FILE);
const jump = compile(TARGET_FILE, { [SHARED_ID]: shared });
// 变异体：判定恒 false（等价于「主进程没打标记」）。它必须让下面第二条用例变红。
// 变异体只换掉「标记判定」，其余身份函数照用真实实现（否则测的就不是标记这一条了）。
const mutated = compile(TARGET_FILE, { [SHARED_ID]: { ...shared, isJumpInjectedAnchorMeta: () => false } });

const injected = (id, entryId) => ({ id: id, meta: { entryId, jumpInjectedAnchor: true } });
const history = (id, entryId) => ({ id: "_viewer-history-" + id, meta: { entryId } });

test("目标在页里：锚点就是目标（精确落位）", () => {
	const page = [history("a", "a1"), history("b", "b1"), history("c", "c1")];
	assert.equal(jump.pickJumpAnchorEntryId(page, "b1"), "b1");
});

test("目标只以补读注入形式存在：锚点改原页首，不得返回目标", () => {
	// 反例（2026-11-25 实测 12754 条会话）：命中 id 3fe6e91e（stopReason=error）在 5 轮页里
	// 出现 0 次、单读成功。注入条在页首；锚它 → findAgentRunIndexByItemId 返回 -1 →
	// 窗口退回尾部 → 用户点中间条目、画面滚到会话底部。
	const page = [injected("_viewer-history-x", "x1"), history("a", "a1"), history("b", "b1")];
	assert.equal(jump.pickJumpAnchorEntryId(page, "x1"), "a1", "应锚到原页首（时间上紧随目标）");
	assert.notEqual(jump.pickJumpAnchorEntryId(page, "x1"), "x1", "绝不能锚到注入条");
});

test("整页只有注入条：返回 undefined（调用方报可诊断失败，不硬跳）", () => {
	assert.equal(jump.pickJumpAnchorEntryId([injected("_viewer-history-x", "x1")], "x1"), undefined);
});

test("变异体（判定恒 false）必须红：证明上面那条真的依赖注入标记", () => {
	const page = [injected("_viewer-history-x", "x1"), history("a", "a1")];
	assert.equal(mutated.pickJumpAnchorEntryId(page, "x1"), "x1", "没标记时它会锚到注入条");
});
