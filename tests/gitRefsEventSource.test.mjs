/**
 * Git 分支信息事件源收敛契约测试。
 *
 * 背景：分支信息原本有三条盲轮询链——App 级 4s、每栏 usePaneGitInfo 4s、
 * GitPanel 抽屉 5s。分屏 N 栏 + App 同时打开时，同一仓库每 4 秒被 spawn 多份
 * git 进程轮询。收敛后：App 与栏级 hook 都改订主进程 GitRefsWatcher 的 refs
 * 变化事件（主进程按 (projectId, repoPath) 复用一份 1.5s 签名轮询）；GitPanel
 * 保留 5s status 轮询（抽屉打开时的独占 UI，且已有 gitPanelPollingGuard 锁行为）。
 *
 * 本测试用源码扫描锁住接线形态（空白容忍正则）：
 * - 不允许分支信息盲轮询 setInterval 复活；
 * - 事件订阅必须成对（onRefsChanged 退订 + unwatchRefs），失败静默降级。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const hookSource = readFileSync("src/renderer/src/hooks/usePaneGitInfo.ts", "utf8");
const appSource = readFileSync("src/renderer/src/App.tsx", "utf8");
const controllerSource = readFileSync("src/renderer/src/hooks/files/useProjectFileTreeController.ts", "utf8");

test("usePaneGitInfo 不再盲轮询，分支信息由 refs 事件驱动", () => {
	assert.doesNotMatch(hookSource, /setInterval/, "分支信息不得回到定时器盲轮询");
	assert.match(hookSource, /watchRefs\(projectId\)\.catch\(\(\) => null\)/, "订阅失败必须静默降级（非 git 项目）");
	assert.match(hookSource, /onRefsChanged\(\(changedWatchId\) => \{/, "必须订阅 refs 变化事件");
	// 退订成对：onRefsChanged 返回值必须被保存并在 cleanup 调用
	assert.match(hookSource, /const offRefsChanged = desktopApi\.git\.onRefsChanged\(/);
	assert.match(hookSource, /offRefsChanged\(\);/);
	// watch 未决时卸载的竞态：cleanup 必须经由同一个 promise 退订，而不是丢弃
	assert.match(hookSource, /watchPromise\.then\(\(id\) => \{\s*if \(id\) void desktopApi\.git\.unwatchRefs\(id\);\s*\}\);/);
});

test("文件树随 refs 事件静默重载：订阅成对、只认自己的 watch、走 ref 取最新刷新函数", () => {
	// 第三条 refs 订阅：commit / checkout / reset / fetch 后让文件树与文件树着色保持同一节奏，
	// 否则会出现「颜色已更新、列表还列着旧分支文件」的错位（着色由文件树内容变化驱动）。
	assert.match(controllerSource, /const offRefsChanged = api\.git\.onRefsChanged\(/, "必须订阅 refs 变化事件");
	assert.match(controllerSource, /if \(stopped \|\| changedWatchId !== watchId\) return;/, "只响应当前订阅的那份 watch");
	assert.match(controllerSource, /refreshVisibleFilesRef\.current\(projectId, true\)/, "必须静默重载文件树（true = 不弹刷新 toast）");
	assert.match(controllerSource, /const refreshVisibleFilesRef = useRef\(refreshVisibleFiles\)/, "必须经 ref 取最新刷新函数（闭包旧版会用过期的展开目录集重扫，把新展开目录打回未加载态）");
	assert.match(controllerSource, /const watchPromise = api\.git\.watchRefs\(projectId\)\.catch\(\(\) => null\)/, "订阅失败静默降级（非 git 项目）");
	assert.match(controllerSource, /offRefsChanged\(\);/, "退订必须调用");
	assert.match(controllerSource, /watchPromise\.then\(\(id\) => \{\s*if \(id\) void api\.git\.unwatchRefs\(id\);\s*\}\);/, "卸载时 watch 未决的竞态要经由同一个 promise 退订");
	assert.doesNotMatch(controllerSource, /setInterval/, "文件树不得为跟随 refs 引入定时器盲轮询");
});

test("App 级分支信息同源收敛：4s 盲轮询移除，事件订阅成对", () => {
	assert.doesNotMatch(appSource, /setInterval\(refreshGitInfo,\s*4000\)/, "App 不得复活 4s 分支盲轮询");
	assert.match(appSource, /const watchPromise = api\.git\.watchRefs\(activeProjectId\)\.catch\(\(\) => null\);/);
	assert.match(appSource, /const offRefsChanged = api\.git\.onRefsChanged\(/);
	assert.match(appSource, /offRefsChanged\(\);/);
	assert.match(appSource, /watchPromise\.then\(\(id\) => \{\s*if \(id\) void api\.git\.unwatchRefs\(id\);\s*\}\);/);
	// 事件只驱动重读，不改变“只写聚焦项目徽标”的既有语义
	const effectBlock = appSource.slice(appSource.indexOf("const offRefsChanged = api.git.onRefsChanged"), appSource.indexOf("}, [activeProjectId]);", appSource.indexOf("const offRefsChanged = api.git.onRefsChanged")));
	assert.match(effectBlock, /if \(changedWatchId !== watchId \|\| stopped\) return;/, "只响应当前订阅的那份 watch");
});
