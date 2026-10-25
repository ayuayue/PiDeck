import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { deriveBranchFamily } from "../src/renderer/src/components/session/branchFamily.ts";

/**
 * 会话分支导航（借鉴 AI Elements MessageBranch 的 ◀ i/N ▶ 分页器）。
 * pi 的 fork 以「会话」为单位（parentSession 文件头链 → SessionCatalog 解析为
 * parentSessionId），分支族 = 来源会话 + 同源兄弟分支 + 下游子分支。
 */

let seq = 0;
function record(overrides = {}) {
	seq += 1;
	return {
		id: overrides.id ?? `s-${seq}`,
		projectId: overrides.projectId ?? "p1",
		title: overrides.title ?? `会话 ${seq}`,
		source: "pi",
		environment: "native",
		filePath: overrides.filePath ?? `/sessions/${overrides.id ?? `s-${seq}`}.jsonl`,
		parentSessionId: overrides.parentSessionId,
		parentSessionPath: overrides.parentSessionPath,
		preview: "",
		messageCount: 1,
		status: "active",
		createdAt: overrides.createdAt ?? seq * 1000,
		updatedAt: overrides.updatedAt ?? seq * 1000,
		...(overrides.noSession ? { noSession: true } : {}),
	};
}

test("父 + 兄弟 + 子分支完整分支族", () => {
	const parent = record({ id: "parent", title: "父会话", createdAt: 1 });
	const older = record({ id: "b1", parentSessionId: "parent", createdAt: 10 });
	const current = record({ id: "b2", parentSessionId: "parent", createdAt: 20 });
	const child = record({ id: "c1", parentSessionId: "b2", createdAt: 30 });
	const records = Object.fromEntries([parent, older, current, child].map((r) => [r.id, r]));
	const family = deriveBranchFamily(records, "b2");
	assert.ok(family);
	assert.equal(family.parent?.id, "parent");
	// 兄弟分支含自身，按 createdAt 升序，分页器 index 指向自身
	assert.deepEqual(
		family.siblings.map((r) => r.id),
		["b1", "b2"],
	);
	assert.equal(family.currentIndex, 1);
	assert.deepEqual(
		family.children.map((r) => r.id),
		["c1"],
	);
});

test("无分支关系的会话返回 undefined（导航条隐藏）", () => {
	const solo = record({ id: "solo" });
	const other = record({ id: "other" });
	const family = deriveBranchFamily({ solo, other }, "solo");
	assert.equal(family, undefined);
});

test("父会话记录缺失（已删除）时兄弟分页仍可用、父链接缺省", () => {
	const b1 = record({ id: "b1", parentSessionId: "gone", createdAt: 10 });
	const b2 = record({ id: "b2", parentSessionId: "gone", createdAt: 20 });
	const family = deriveBranchFamily({ b1, b2 }, "b1");
	assert.ok(family);
	assert.equal(family.parent, undefined);
	assert.deepEqual(
		family.siblings.map((r) => r.id),
		["b1", "b2"],
	);
	assert.equal(family.currentIndex, 0);
});

test("parentSessionId 未解析时按 parentSessionPath 兜底匹配来源", () => {
	const parent = record({ id: "parent", filePath: "/sessions/parent.jsonl", createdAt: 1 });
	const current = record({
		id: "b1",
		parentSessionPath: "/sessions/parent.jsonl",
		createdAt: 10,
	});
	const family = deriveBranchFamily({ parent, b1: current }, "b1");
	assert.ok(family);
	assert.equal(family.parent?.id, "parent");
});

test("匿名运行时会话（noSession）不参与分支关系", () => {
	const parent = record({ id: "parent", createdAt: 1 });
	const anon = record({ id: "anon", parentSessionId: "parent", noSession: true, createdAt: 10 });
	const current = record({ id: "parent2", createdAt: 20 });
	const family = deriveBranchFamily({ parent, anon, parent2: current }, "parent");
	// parent 只有一个匿名子分支（被排除）→ 无分支关系
	assert.equal(family, undefined);
});

test("跨项目的同 parentSessionId 记录不混入兄弟分支", () => {
	const parent = record({ id: "parent", createdAt: 1 });
	const b1 = record({ id: "b1", parentSessionId: "parent", createdAt: 10 });
	const alien = record({ id: "alien", projectId: "p2", parentSessionId: "parent", createdAt: 20 });
	const family = deriveBranchFamily({ parent, b1, alien }, "b1");
	assert.ok(family);
	assert.deepEqual(
		family.siblings.map((r) => r.id),
		["b1"],
	);
});

/* ── 集成断言：分支条装配在会话头部下方，数据走 sessionRecordsAtom ── */

const barSource = readFileSync("src/renderer/src/components/session/SessionBranchBar.tsx", "utf8");
const viewSource = readFileSync("src/renderer/src/components/session/SessionView.tsx", "utf8");
const zhCN = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const enUS = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("SessionBranchBar 读 sessionRecordsAtom 派生分支族，分页器边界禁用", () => {
	assert.match(barSource, /sessionRecordsAtom/);
	assert.match(barSource, /deriveBranchFamily\(records, props\.sessionId\)/);
	// ◀ ▶ 边界禁用不循环（与 AI Elements MessageBranch 语义一致）
	assert.match(barSource, /disabled=\{currentIndex <= 0\}/);
	assert.match(barSource, /disabled=\{currentIndex >= siblings\.length - 1\}/);
	// 父链接 / 分页器 / 子分支 Popover 三段都在
	assert.match(barSource, /branch\.parent/);
	assert.match(barSource, /branch\.pager/);
	assert.match(barSource, /Popover/);
});

test("分支条渲染在 SessionHeader 之下、时间线之上", () => {
	const headerIndex = viewSource.indexOf("<SessionHeader");
	const barIndex = viewSource.indexOf("<SessionBranchBar");
	const timelineIndex = viewSource.indexOf("<ResizablePanelGroup");
	assert.ok(headerIndex > 0 && barIndex > headerIndex && barIndex < timelineIndex);
});

test("分支导航 i18n 键中英同步", () => {
	for (const key of ["branch.parent", "branch.pager", "branch.prev", "branch.next", "branch.children", "branch.childrenTitle"]) {
		assert.ok(zhCN.includes(`"${key}"`), `zh-CN missing ${key}`);
		assert.ok(enUS.includes(`"${key}"`), `en-US missing ${key}`);
	}
});
