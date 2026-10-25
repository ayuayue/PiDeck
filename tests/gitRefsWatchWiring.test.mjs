/**
 * refs 变化推送链路的接线契约测试。
 *
 * 这条链路横跨 6 层：shared 通道常量 → main handler → 主进程推送桥 → preload →
 * GitDrawerHost 端口 → GitPanel 订阅。任何一层漏接都只是「角标偶尔还是慢」，
 * 不会报错，所以用源码断言把每层的存在性与关键守卫钉住。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(path, "utf8");
const channels = read("src/shared/ipc.ts");
const gitIpc = read("src/main/ipc/gitIpc.ts");
const entry = read("src/main/index.ts");
const preload = read("src/preload/index.ts");
const previewApi = read("src/renderer/src/previewApi.ts");
const drawerHost = read("src/renderer/src/components/workspace/GitDrawerHost.tsx");
const gitPanel = read("src/renderer/src/components/app/GitPanel.tsx");

test("shared/ipc.ts 定义订阅、退订与推送三条通道", () => {
	assert.match(channels, /gitWatchRefs:\s*"git:watch-refs"/);
	assert.match(channels, /gitUnwatchRefs:\s*"git:unwatch-refs"/);
	assert.match(channels, /gitRefsChanged:\s*"git:refs-changed"/);
});

test("主进程按仓库路径订阅/退订，并把事件推给主窗口", () => {
	// 订阅：路径必须过 requireGitCwd（项目内 + 可选嵌套仓库校验），不能把渲染层的任意路径拿去反复 stat
	assert.match(gitIpc, /ipcMain\.handle\(ipcChannels\.gitWatchRefs[\s\S]{0,300}?requireGitCwd\(projectId, repoPath\)/);
	// 退订：入参校验 + 未知 id 静默忽略（重复退订安全）
	assert.match(gitIpc, /ipcMain\.handle\(ipcChannels\.gitUnwatchRefs[\s\S]{0,300}?typeof watchId !== "string"[\s\S]{0,200}?gitRefsWatcher\.release\(watchId\)/);
	// 推送桥：窗口销毁时不能 send（会抛），payload 是 watchId
	assert.match(gitIpc, /gitRefsWatcher\.on\(\(watchId\)[\s\S]{0,400}?window\.isDestroyed\(\)[\s\S]{0,200}?webContents\.send\(ipcChannels\.gitRefsChanged, watchId\)/);
	// 依赖来自装配层，不在 gitIpc 里 new（保持 IPC 层只做适配）
	assert.doesNotMatch(gitIpc, /new GitRefsWatcher\(/);
	assert.match(entry, /gitRefsWatcher = new GitRefsWatcher\(\{ logger: appLogger \}\)/);
	// 轮询仍是兜底：装配层必须登记退出清理，句柄不能留到进程结束
	assert.match(entry, /quitCleanup\.register\("git-refs-watcher", \(\) => gitRefsWatcher\.disposeAll\(\)\)/);
});

test("preload 暴露 watchRefs / unwatchRefs / onRefsChanged（含退订）", () => {
	assert.match(preload, /watchRefs:\s*\(projectId: string, repoPath\?: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.gitWatchRefs, projectId, repoPath\) as Promise<string>/);
	assert.match(preload, /unwatchRefs:\s*\(watchId: string\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.gitUnwatchRefs, watchId\) as Promise<void>/);
	const subscribeBlock = preload.slice(preload.indexOf("onRefsChanged:"), preload.indexOf("onRefsChanged:") + 400);
	assert.match(subscribeBlock, /ipcRenderer\.on\(ipcChannels\.gitRefsChanged, handler\)/);
	assert.match(subscribeBlock, /ipcRenderer\.removeListener\(ipcChannels\.gitRefsChanged, handler\)/);
});

test("预览环境（无主进程）提供空实现，避免 desktopApi 类型缺方法", () => {
	assert.match(previewApi, /watchRefs:\s*async \(\) => ""/);
	assert.match(previewApi, /unwatchRefs:\s*async \(\) => \{\}/);
	assert.match(previewApi, /onRefsChanged:\s*\(\) => \(\) => \{\}/);
});

test("GitDrawerHost 把 refs 订阅固定在仓库作用域上并透传给 GitPanel", () => {
	assert.match(drawerHost, /watchRefs:\s*\(projectId: string, repoPath\?: string\) => Promise<string>/);
	assert.match(drawerHost, /onRefsChanged:\s*\(listener: \(watchId: string\) => void\) => \(\) => void/);
	assert.match(drawerHost, /watchRefs:\s*\(id: string\)\s*=>\s*gitApi\.watchRefs\(id, repoPath\)/);
	assert.match(drawerHost, /onRefsChanged:\s*gitApi\.onRefsChanged/);
	assert.match(drawerHost, /watchRefs=\{scopedApi\.watchRefs\}[\s\S]{0,200}?unwatchRefs=\{scopedApi\.unwatchRefs\}[\s\S]{0,200}?onRefsChanged=\{scopedApi\.onRefsChanged\}/);
});

test("GitPanel 成对订阅/退订，且推送只触发静默刷新（不 fetch）", () => {
	const effectStart = gitPanel.indexOf("refs 变化推送：");
	assert.ok(effectStart > 0, "GitPanel 必须保留 refs 推送订阅 effect");
	const effect = gitPanel.slice(effectStart, effectStart + 2600);
	// 过滤：只处理本面板的 watchId（多仓时同一条通道 N 个面板共用）
	assert.match(effect, /refsWatchIdRef\.current !== changedId\)\s*return/);
	// 只做 silent 刷新：非 silent 会触发 fetch → 改写 refs → 再推送，形成往返回环
	assert.match(effect, /void refresh\(true\);/);
	assert.doesNotMatch(effect, /void refresh\(\);/);
	assert.match(effect, /void readAheadBehind\(\);/);
	// mutation 进行中/窗口隐藏时不抢刷新
	assert.match(effect, /mutationRunningRef\.current \|\| document\.hidden/);
	// 订阅与退订成对，且卸载后再拿到 id 也要立即退订
	assert.match(effect, /void watchRefs\(projectId\)[\s\S]{0,400}?if \(disposed\) \{[\s\S]{0,200}?void unwatchRefs\(watchId\)/);
	assert.match(effect, /disposed = true;[\s\S]{0,200}?unsubscribe\(\);[\s\S]{0,300}?if \(watchId\) void unwatchRefs\(watchId\)/);
	// historyOnly 只要 Graph/Compare，不订阅 refs
	assert.match(effect, /if \(layout === "historyOnly"\) return;/);
	// 非 git 仓库 / 未装 git 时也不订阅
	assert.match(effect, /if \(notAGitRepo \|\| gitNotInstalled\) return;/);
});
