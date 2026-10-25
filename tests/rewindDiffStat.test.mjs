// rewindDiffStat：解析 git diff-tree --stat 汇总行（纯函数，无外部依赖）
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDiffStatSummary } from "../src/renderer/src/utils/rewindDiffStat.ts";

test("解析完整汇总行：文件数 + 增删", () => {
	const stat = parseDiffStatSummary(" a.txt | 2 +-\n b.txt | 2 +-\n 2 files changed, 2 insertions(+), 2 deletions(-)");
	assert.deepEqual(stat, { files: 2, insertions: 2, deletions: 2 });
});

test("解析单数 file / 只有删除", () => {
	const stat = parseDiffStatSummary(" 1 file changed, 1 deletion(-)");
	assert.deepEqual(stat, { files: 1, deletions: 1 });
});

test("解析插入+删除只有其一（纯新增文件）", () => {
	const stat = parseDiffStatSummary(" 1 file changed, 5 insertions(+)");
	assert.deepEqual(stat, { files: 1, insertions: 5 });
});

test("纯模式变更：无增删计数", () => {
	const stat = parseDiffStatSummary(" 1 file changed");
	assert.deepEqual(stat, { files: 1 });
});

test("无差异（两树相同）：空输出返回 null", () => {
	assert.equal(parseDiffStatSummary(""), null);
});

test("非 stat 文本（异常内容）返回 null", () => {
	assert.equal(parseDiffStatSummary("fatal: not a tree object"), null);
});

test("忽略逐文件行，只取末尾汇总行", () => {
	const stat = parseDiffStatSummary(" src/a.ts | 10 ++++++++--\n src/b.ts | 3 ---\n 2 files changed, 10 insertions(+), 3 deletions(-)");
	assert.deepEqual(stat, { files: 2, insertions: 10, deletions: 3 });
});
