import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 判据：锚点比较必须看 anchoredRunId。
 *
 * `sameSessionScrollAnchor` 是「内容未变化就跳过写入」的判据。加了 anchoredRunId 字段
 * 却不加进比较，会出现：只有锚点 run 变（其余四字段相同）时判「未变化」→ 直接 return →
 * **新锚点不落盘**，切回该会话才恢复成旧起点。不报错、不写盘、看不出。
 *
 * 反例（能红）：把 `a.anchoredRunId === b.anchoredRunId` 从比较里删掉。
 */

const atoms = () => loadTsCommonJs("src/renderer/src/atoms/session-timeline-atoms.ts");

const base = { messageId: "m1", entryId: "e1", offsetTop: 12, windowTurns: 3, savedAt: 1 };

test("只有 anchoredRunId 不同：必须判为变化", () => {
	const { sameSessionScrollAnchor } = atoms();
	const a = { ...base, anchoredRunId: "run-100" };
	const b = { ...base, anchoredRunId: "run-101" };
	assert.equal(sameSessionScrollAnchor(a, b), false, "锚点 run 变了却判未变化 -> 新锚点不落盘（切回才发现恢复到旧起点）");
});

test("anchoredRunId 从有到无也算变化（回底清锚点）", () => {
	const { sameSessionScrollAnchor } = atoms();
	assert.equal(sameSessionScrollAnchor({ ...base, anchoredRunId: "run-100" }, { ...base }), false);
	assert.equal(sameSessionScrollAnchor({ ...base }, { ...base, anchoredRunId: "run-100" }), false);
});

test("四字段全同且锚点同：仍判未变化（跳过写入的优化不能失效）", () => {
	const { sameSessionScrollAnchor } = atoms();
	assert.equal(sameSessionScrollAnchor({ ...base, anchoredRunId: "r" }, { ...base, anchoredRunId: "r" }), true);
	assert.equal(sameSessionScrollAnchor(undefined, undefined), true);
	assert.equal(sameSessionScrollAnchor(undefined, { ...base }), false);
});

test("其余字段任一不同仍判变化（回归守卫）", () => {
	const { sameSessionScrollAnchor } = atoms();
	for (const patch of [{ messageId: "m2" }, { entryId: "e2" }, { offsetTop: 13 }, { windowTurns: 4 }]) {
		assert.equal(sameSessionScrollAnchor({ ...base, anchoredRunId: "r" }, { ...base, anchoredRunId: "r", ...patch }), false, JSON.stringify(patch) + " 不同必须判变化");
	}
});
