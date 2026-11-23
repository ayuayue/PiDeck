/**
 * GitGraph 能力门控：可选回调缺席时不得把 undefined 当成一次成功的写，也不得强行调用 count。
 * 这是 F7 的回归：右键菜单历史上用 props.x?.() 调用可选回调，run() 返回 undefined 后仍显示成功。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/git/GitGraph.tsx", "utf8");

test("runGitAction 对缺席回调直接返回，不进入成功提示", () => {
	const block = source.slice(source.indexOf("const runGitAction"), source.indexOf("useEffect(() => {\n\t\tloadRef.current"));
	assert.match(block, /if \(run === undefined\) \{/);
	assert.match(block, /closeContextMenu\(\);/);
	assert.ok(block.indexOf("if (run === undefined)") < block.indexOf("showNotice"), "guard must precede the success notice");
});

test("菜单动作把缺席回调显式变成 undefined，不再用可选调用冒充执行", () => {
	const menu = source.slice(source.indexOf("提交右键菜单"), source.indexOf("{/* 确认弹框 */}"));
	assert.doesNotMatch(menu, /props\.(?:cherryPick|revert|reset|dropCommit)\?\.\(/);
	assert.match(menu, /props\.reset === undefined \? undefined : \(\) => props\.reset!\(/);
	assert.match(menu, /props\.dropCommit === undefined \? undefined : \(\) => props\.dropCommit!\(/);
});

test("commitCount 缺席时不发请求，徽章退回已加载页长度", () => {
	// 契约演进：总数是辅助数据，请求失败/缺席都不能把已经成功的列表一起藏掉。
	// 顺序也钉住——列表先发布，再等 count 更新徽章。
	assert.match(source, /countLoader\?\.\(projectId, filter\) \?\? null/);
	assert.match(source, /setTotalCount\(next\.length\)/);
	assert.match(source, /setTotalCount\(count \?\? next\.length\)/);
});
