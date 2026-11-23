import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { rendererAppSource } from "./helpers/rendererAppSources.mjs";

const app = rendererAppSource;
const graph = readFileSync("src/renderer/src/components/app/git/GitGraph.tsx", "utf8");

test("Git drawer branch callbacks remain stable across unrelated App renders", () => {
	assert.match(app, /const switchBranch = useCallback\(/);
	assert.match(app, /const createBranch = useCallback\(/);
});

test("open Git graph reads the latest commitLog without reloading on wrapper identity changes", () => {
	const loadBlock = graph.slice(graph.indexOf("const load = useCallback"), graph.indexOf("const graphRows = useMemo"));
	assert.match(graph, /const commitLogRef = useRef\(props\.commitLog\)/);
	assert.match(graph, /const commitCountRef = useRef\(props\.commitCount\)/);
	assert.match(loadBlock, /commitLogRef\.current\(projectId/);
	// 总数读法同样必须走 ref：当前实现先把 ref 取成局部 countLoader 再调用，
	// 断言沿用这一形状（关键点是「读的是 ref，不是本轮 render 捕获的 props」）。
	assert.match(loadBlock, /(commitCountRef\.current\(projectId|const countLoader = commitCountRef\.current[\s\S]{0,120}countLoader\?\.\(projectId)/);
	assert.doesNotMatch(loadBlock, /props\.commitLog\(projectId/);
	assert.doesNotMatch(loadBlock, /props\.commitLog,/);
	// GitDrawerHost 每次 render 都会换包装函数；load 依赖不能挂 props.commitCount，否则 Graph 会反复重拉。
	assert.doesNotMatch(loadBlock, /props\.commitCount/);
});
