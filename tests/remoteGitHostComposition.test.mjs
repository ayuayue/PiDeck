/**
 * 远端 Git 面板的宿主组合契约（W4 之后的单面板结构）。
 *
 * 远端与本地共用同一块 `GitPanel`：变更区、提交框、分组树、源代码管理图、比较更改都是同一份实现，
 * 数据面由一个按位置分派的桥（`remoteGitPanelBridge`）提供。远端只保留“前置条件”三块：
 * trust 门、仓库范围选择器（放进分支栏）、恢复区（面板底部插槽）。
 *
 * 这些断言防的是回退：不要再出现“第二套变更区/提交框/历史列表”，也不要让本机专属入口
 * （AI 摘要、回收站删除、cherry-pick/reset、原生 refs watch、提交总数、全分支过滤）在远端复活。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const panel = readFileSync("src/renderer/src/components/workspace/RemoteGitPanel.tsx", "utf8");
const bridge = readFileSync("src/renderer/src/components/workspace/remoteGitPanelBridge.ts", "utf8");
const localPanel = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");
const policy = readFileSync("src/renderer/src/hooks/git/useGitAutoRefresh.ts", "utf8");

test("远端面板挂的就是本机 GitPanel：不再自带变更区/历史/引用/同步条", () => {
	assert.match(panel, /import \{ GitPanel \} from "\.\.\/app\/GitPanel"/);
	assert.match(panel, /<GitPanel\b/);
	assert.doesNotMatch(panel, /RemoteGitChangesSection|RemoteGitCompareSection/);
	assert.doesNotMatch(panel, /data-testid="remote-git-sync"|data-testid="remote-git-history"|data-testid="remote-git-refs"/);
	// diff 仍复用同一个渲染器，但只在中间栏阅读面里渲染：远端面板自己取内容后交给宿主统一的
	// showGitDiff（布局取设置），不再把 FileDiffViewer 塞进抽屉内部。
	assert.doesNotMatch(panel, /FileDiffViewer/);
	assert.doesNotMatch(panel, /displayMode="drawer"/);
	assert.match(panel, /props\.onShowDiff\(\{ projectId: project\.id, target: result\.target/);
	assert.match(panel, /onShowDiff: \(diff: GitDrawerDiff\) => void/);
});

test("数据面只有一个入口：ProjectGitService 桥；面板不碰令牌、不自持快照", () => {
	assert.match(panel, /createRemoteGitPanelBridge\(services, repoTarget\)/);
	assert.doesNotMatch(panel, /useRemoteGitView\(/);
	assert.doesNotMatch(panel, /useState<GitReadSnapshot/);
	for (const token of ["commitToken", "mutationToken", "branchToken", "switchToken", "discardToken", "restoreToken", "dropToken", "fetchToken", "pushToken", "pullToken"]) {
		assert.ok(!panel.includes(token), token + " must not come back: the service contract has no authorization tokens");
	}
});

test("远端补上本机同形入口：摘要 / 回收站删除 / refs 订阅 / 总数 / 全分支；图谱写仍不伪造", () => {
	// 这一批随 helper 1.32.0 发布，渲染层用 `git.stagedDiff` 这一枚标记统一降级。
	for (const prop of ["generateCommitMessage=", "deleteFiles=", "watchRefs=", "unwatchRefs=", "onRefsChanged=", "commitCount="]) {
		assert.ok(panel.includes(prop), prop + " now rides on the shared panel");
	}
	// 旧 helper 上过滤器保持关闭，而不是让“全部分支”静默变成 HEAD。
	assert.match(panel, /historyRefFilter=\{upgraded\}/);
	// 打开文件是宿主共同入口（文件抽屉同一个 openEditorTab），不是远端能力。
	assert.match(panel, /onOpenFile=\{onOpenFile\}/);
	assert.match(localPanel, /refFilter=\{props\.historyRefFilter\}/);
});

test("远端只剩前置条件：trust 门、仓库发现截断说明、恢复区（底部插槽）；仓库改为并排", () => {
	assert.match(panel, /<RemoteGitTrustGate\b/);
	assert.match(panel, /<RemoteGitRecoverySection\b/);
	assert.match(panel, /data-testid="remote-git-repos-truncated"/);
	assert.match(panel, /gitCapabilityReasonKey\(blocked\["git\.read"\] \?\? ""\) === "remoteGit\.trustRequired"/);
	// 单一活动仓库选择器已去掉：多仓与本机一样并排渲染，各自带自己的作用域。
	assert.ok(!panel.includes("branchBarExtra="), "the branch-bar selector is gone with the single active scope");
	assert.match(panel, /layout="changesOnly"/);
});

test("能力位原样交给共用面板：自动 fetch 由能力位与配置双重门禁", () => {
	assert.match(panel, /gitCapabilities=\{git\}/);
	assert.match(panel, /blockedReasons=\{blocked\}/);
	assert.match(localPanel, /useGitAutoRefresh\(\{/);
	assert.match(localPanel, /capabilities: autoRefreshCapabilities/);
	assert.match(localPanel, /gitCapabilities\.autoFetch/);
	// 能力位为 false 时，经 GitPanel 的交集必须关闭 5 分钟 fetch 定时器（远端现在与本机同为 true）。
	assert.match(localPanel, /\(props\.capabilities\?\.autoFetch \?\? LOCAL_GIT_AUTO_REFRESH\.autoFetch\) && gitCapabilities\.autoFetch/);
});

test("没有任何 effect 触发网络写：fetch/push/pull 只作为用户动作的 props 传下去", () => {
	// 面板与桥里出现的这五个动词都必须是“被调用”的 props/桥方法，不能出现在 effect 体内。
	for (const source of [panel, bridge]) {
		assert.doesNotMatch(source, /useEffect\([^)]*fetch\(/);
		assert.doesNotMatch(source, /setInterval/);
	}
	assert.match(panel, /fetch=\{bridge\.fetch\}/);
	assert.match(panel, /push=\{bridge\.push\}/);
	assert.match(panel, /pull=\{bridge\.pull\}/);
});

test("每个仓一份桥：桥的每次调用都带同一个 repo target，多仓并排互不串仓", () => {
	// 令牌按 (project, 动作, 仓库) 各自保留：多仓并排不会互相作废；桥仍必须把作用域绑死在自己的参数上。
	assert.match(bridge, /services\.git\.(status|refresh)\(repo\)/);
	assert.match(bridge, /services\.git\.stage\(targets, repo\)/);
	assert.match(bridge, /services\.git\.commit\(message, repo\)/);
	assert.match(bridge, /services\.git\.discard\(resources, repo\)/);
});
