import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const app = readFileSync("src/renderer/src/App.tsx", "utf8");
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
	assert.match(loadBlock, /commitCountRef\.current\(projectId/);
	assert.doesNotMatch(loadBlock, /props\.commitLog\(projectId/);
	assert.doesNotMatch(loadBlock, /props\.commitLog,/);
	// GitDrawerHost 每次 render 都会换包装函数；load 依赖不能挂 props.commitCount，否则 Graph 会反复重拉。
	assert.doesNotMatch(loadBlock, /props\.commitCount/);
});
