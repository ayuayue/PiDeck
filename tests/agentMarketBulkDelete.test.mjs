import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 智能体市场批量删除（源码级契约）：
 * 主进程没有批量接口，`deleteAgents` 逐条删；关键是
 * 1) 内置智能体永远不进删除队列（批量框里点不到，逻辑层再兜一层）；
 * 2) 一次刷新快照、失败条数如实回报，不能把「删了 0 条」报成成功；
 * 3) 界面上内置卡片复选框禁用，且批量态用 BulkSelectionBar 替换分类 chips。
 */
const ACTIONS = readFileSync("src/renderer/src/components/agents/market/useAgentMarketActions.ts", "utf8");
const WORKSPACE = readFileSync("src/renderer/src/components/agents/market/AgentMarketWorkspace.tsx", "utf8");
const CARD = readFileSync("src/renderer/src/components/agents/market/AgentMarketCard.tsx", "utf8");
const HEADER = readFileSync("src/renderer/src/components/agents/market/AgentMarketHeader.tsx", "utf8");
const GRID = readFileSync("src/renderer/src/components/agents/market/AgentMarketGrid.tsx", "utf8");

/** 取出某个函数体（从 const X = useCallback( 到匹配的 `\t);`），避免用整份文件做正则匹配。 */
function functionBody(source, name) {
	const start = source.indexOf(`const ${name} = useCallback(`);
	assert.notEqual(start, -1, `找不到 ${name}`);
	const end = source.indexOf("\n\t);", start);
	assert.notEqual(end, -1, `${name} 没有闭合`);
	return source.slice(start, end);
}

test("deleteAgents 先过滤内置智能体，再逐条删除并只刷新一次", () => {
	const body = functionBody(ACTIONS, "deleteAgents");
	const filterIndex = body.indexOf("filter((agent) => !agent.builtin)");
	const removeIndex = body.indexOf("desktopApi.agentProfiles.remove");
	assert.notEqual(filterIndex, -1, "必须过滤掉内置智能体");
	assert.notEqual(removeIndex, -1, "必须逐条调用 remove");
	assert.ok(filterIndex < removeIndex, "过滤要在删除之前");
	assert.equal(body.match(/refreshSnapshot\(\)/g)?.length, 1, "批量删除只重拉一次快照");
	assert.match(body, /bulkDeletePartial/, "部分失败要如实提示");
	assert.match(body, /batchDeleted/, "全部成功才提示批量删除成功");
});

test("deleteAgents 暴露在 actions 契约里（工作区才能调用）", () => {
	assert.match(ACTIONS, /deleteAgents: \(agents: readonly AgentProfile\[\]\) => Promise<number>;/);
	assert.match(ACTIONS, /return \{[^}]*deleteAgents/);
});

test("批量态：可选项只含可见且非内置的智能体", () => {
	assert.match(WORKSPACE, /const deletableVisibleIds = useMemo\(\(\) => visibleAgents\.filter\(\(agent\) => !agent\.builtin\)\.map/);
	assert.match(WORKSPACE, /onToggleAll=\{toggleSelectAllVisible\}/);
	assert.match(WORKSPACE, /setSelectionFor\(current, deletableVisibleIds/);
	// 进入批量态要先收起详情，否则抽屉和选择态两个交互叠加
	assert.match(WORKSPACE, /const enterSelection = useCallback\(\(\) => \{\n\t\tsetSelectedAgentId\(null\);/);
});

test("批量态替换分类 chips 并渲染 BulkSelectionBar", () => {
	assert.match(WORKSPACE, /\{selectionMode \? \(\s*<BulkSelectionBar/);
	assert.match(WORKSPACE, /<AgentMarketCategoryChips/);
	assert.match(WORKSPACE, /agentMarket\.bulkDeleteTitle/);
	assert.match(WORKSPACE, /agentMarket\.bulkDeleteBody/);
	assert.match(WORKSPACE, /await actions\.deleteAgents\(targets\)/);
});

test("卡片：批量态显示复选框，内置不可选", () => {
	assert.match(CARD, /selectionMode && \(/);
	assert.match(CARD, /<Checkbox checked=\{checked\} disabled=\{agent\.builtin\}/);
	assert.match(CARD, /selectionMode \? onToggleSelect\(agent\) : onOpen\(agent\)/);
	assert.match(CARD, /selectionMode && checked && "border-primary\/50 bg-primary\/10/);
});

test("头部批量入口 + 网格透传选择态", () => {
	assert.match(HEADER, /onToggleSelection\?: \(\) => void/);
	assert.match(HEADER, /t\("common\.bulkSelect"\)/);
	assert.match(GRID, /selectionMode=\{selectionMode\}/);
	assert.match(GRID, /checked=\{selectedIds\.has\(agent\.id\)\}/);
	assert.match(GRID, /onToggleSelect=\{onToggleSelect\}/);
});
