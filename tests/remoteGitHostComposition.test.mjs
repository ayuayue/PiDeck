/**
 * W5-2 宿主组合契约：远端 Git 面板是“共用展示区块 + 远端专属区块”，
 * 不是把本机 GitPanel/GitGraph 的状态机整块搬过来。
 *
 * - 变更树与 diff 复用 `GitResourceTree.FileTree` / `FileDiffViewer`；
 * - 事实/读取/写入由 `useRemoteGitView` 独占，面板不维护第二份同类状态；
 * - 历史、比较、trust、recovery、init、sync 是远端专属区块，保留自己的授权/确认；
 * - 自动刷新策略只在 `GitPanel` 通过 `useGitAutoRefresh` 注册；远端没有后台网络写。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync("src/renderer/src/components/workspace/RemoteGitPanel.tsx", "utf8");
const localPanel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const policy = readFileSync("src/renderer/src/hooks/git/useGitAutoRefresh.ts", "utf8");

test("远端面板复用共用变更树与 diff 渲染器，不挂本机 GitPanel/GitGraph", () => {
	assert.match(panel, /import \{ FileTree \} from "\.\.\/app\/git\/GitResourceTree"/);
	assert.match(panel, /const FileDiffViewer = lazy\(\(\) => import\("\.\.\/app\/FileDiffViewer"\)/);
	assert.match(panel, /<FileTree/);
	assert.match(panel, /<FileDiffViewer/);
	assert.doesNotMatch(panel, /from "\.\.\/app\/GitPanel"/);
	assert.doesNotMatch(panel, /from "\.\.\/app\/git\/GitGraph"/);
});

test("远端事实与飞行状态只有一个 owner：useRemoteGitView", () => {
	// 面板只从 controller 取状态与动作；不允许再出现一套 snapshot/mutation token 的本地状态。
	assert.match(panel, /const \{\s*state,/);
	assert.match(panel, /useRemoteGitView\(project, repoPath\)/);
	assert.doesNotMatch(panel, /useState<GitReadSnapshot/);
	assert.doesNotMatch(panel, /useState<.*mutationToken/);
});

test("远端专属区块保留：history/compare/trust/init/sync 不被共用面板吞掉", () => {
	assert.match(panel, /RemoteGitCompareSection/);
	assert.match(panel, /RemoteGitTrustGate/);
	assert.match(panel, /remote-git-init-confirm/);
	assert.match(panel, /data-testid="remote-git-sync"/);
	assert.match(panel, /data-testid="remote-git-history"/);
});

test("自动刷新只在本机宿主注册；远端只有显式动作/有界 refs 轮询", () => {
	assert.match(localPanel, /useGitAutoRefresh\(\{/);
	assert.match(localPanel, /capabilities: autoRefreshCapabilities/);
	assert.match(policy, /export const LOCAL_GIT_AUTO_REFRESH/);
	// 远端面板不得复活 setInterval/自动 fetch；refs 轮询由显式展开 + hostReady 门控的 hook 负责。
	assert.doesNotMatch(panel, /setInterval/);
	assert.doesNotMatch(panel, /refreshAheadBehind/);
	// G4b：轮询的 active 串上 refsWatch 能力；展开、页面可见、hostReady、首次 refs 加载这四个条件仍由 hook 保留。
	assert.match(panel, /useRemoteGitRefsPolling\(\{\s*active: refsOpen && capabilities\.refsWatch,\s*refsLoaded: state\.refs !== undefined,\s*hostReady,\s*poll: pollRefs,\s*stop: stopRefsPolling,?\s*\}\)/);
});
