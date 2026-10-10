import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const layout = loadTsCommonJs("src/renderer/src/components/workspace/rightSidebarLayout.ts");
const model = loadTsCommonJs("src/renderer/src/components/session/statusPanel/sessionStatusPanelModel.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));

test("偏好解析：缺失/坏 JSON/非对象一律回退默认", () => {
	const fallback = { collapsed: false, bottomPct: layout.DEFAULT_BOTTOM_PCT };
	for (const raw of [null, undefined, "", "{", "[]", "42", '"x"', "null"]) {
		assert.deepEqual(plain(layout.parseRightSidebarStackPrefs(raw)), fallback, String(raw));
	}
});

test("偏好解析：collapsed 只认 true，bottomPct 越界/非数字被收敛", () => {
	assert.deepEqual(plain(layout.parseRightSidebarStackPrefs('{"collapsed":true,"bottomPct":30}')), { collapsed: true, bottomPct: 30 });
	assert.equal(layout.parseRightSidebarStackPrefs('{"collapsed":"yes"}').collapsed, false);
	assert.equal(layout.parseRightSidebarStackPrefs('{"bottomPct":2}').bottomPct, layout.BOTTOM_PCT_MIN);
	assert.equal(layout.parseRightSidebarStackPrefs('{"bottomPct":99}').bottomPct, layout.BOTTOM_PCT_MAX);
	assert.equal(layout.parseRightSidebarStackPrefs('{"bottomPct":"40"}').bottomPct, layout.DEFAULT_BOTTOM_PCT);
	assert.equal(layout.clampBottomPct(Number.NaN), layout.DEFAULT_BOTTOM_PCT);
	assert.equal(layout.clampBottomPct(Number.POSITIVE_INFINITY), layout.DEFAULT_BOTTOM_PCT);
});

test("偏好序列化往返保持一致，且写出前同样收敛", () => {
	const raw = layout.serializeRightSidebarStackPrefs({ collapsed: true, bottomPct: 37.26 });
	assert.deepEqual(plain(layout.parseRightSidebarStackPrefs(raw)), { collapsed: true, bottomPct: 37.3 });
	assert.equal(JSON.parse(layout.serializeRightSidebarStackPrefs({ collapsed: false, bottomPct: 500 })).bottomPct, layout.BOTTOM_PCT_MAX);
});

test("高度不足自动收起：阈值 = 上半区最小 + 下半区最小 + 分隔条；未测量（0/非有限）不判定", () => {
	const threshold = layout.SIDEBAR_TOP_MIN_PX + layout.SIDEBAR_BOTTOM_MIN_PX + layout.SIDEBAR_SEPARATOR_PX;
	assert.equal(threshold, 281);
	assert.equal(layout.shouldAutoCollapseBottom(threshold - 1), true);
	assert.equal(layout.shouldAutoCollapseBottom(threshold), false);
	assert.equal(layout.shouldAutoCollapseBottom(900), false);
	assert.equal(layout.shouldAutoCollapseBottom(0), false);
	assert.equal(layout.shouldAutoCollapseBottom(Number.NaN), false);
});

test("有效收起态 = 用户偏好 或 自动收起；自动收起解除后回到用户偏好", () => {
	assert.equal(layout.resolveBottomCollapsed({ collapsed: false, bottomPct: 45 }, true), true);
	assert.equal(layout.resolveBottomCollapsed({ collapsed: false, bottomPct: 45 }, false), false);
	assert.equal(layout.resolveBottomCollapsed({ collapsed: true, bottomPct: 45 }, false), true);
});

test("tab 解析：未知值回退待办", () => {
	assert.equal(model.parseSessionStatusTab("files"), "files");
	assert.equal(model.parseSessionStatusTab("subagents"), "subagents");
	for (const raw of [null, undefined, "", "todos", 1, {}]) assert.equal(model.parseSessionStatusTab(raw), "todo");
});

test("文件变更类型：无旧内容=整文件写入，有旧内容=局部编辑", () => {
	assert.equal(model.fileChangeKind({ originalContent: "" }), "write");
	assert.equal(model.fileChangeKind({ originalContent: "old" }), "edit");
});

test("待办角标：已完成/总数，空列表不显示", () => {
	assert.equal(model.todoProgressBadge([]), null);
	assert.equal(model.todoProgressBadge([{ status: "completed" }, { status: "in-progress" }, { status: "pending" }]), "1/3");
});
