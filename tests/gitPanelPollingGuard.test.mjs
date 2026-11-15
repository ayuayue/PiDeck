/**
 * Git 面板自动刷新策略契约测试（v5 W5-2 已拆到 useGitAutoRefresh）。
 *
 * 背景：git 侧栏每 5 秒静默轮询 status + 每 5 分钟 fetch 远程。当项目目录不是
 * git 仓库（或未安装 git）时，轮询每次都会 spawn git 报错，控制台刷屏且浪费
 * 进程开销。策略 hook 在非仓库标记置位后不注册/不执行自动动作；仓库状态恢复
 * （git init / 安装 git）后由 refresh 成功路径清标记自动恢复。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { gitPanelSource } from "./helpers/gitPanelSources.mjs";

const panel = gitPanelSource;
const policy = readFileSync("src/renderer/src/hooks/git/useGitAutoRefresh.ts", "utf8");
// 策略 hook 在前、面板在后：旧测试的「readAheadBehind / refresh」切片仍落在面板段。
const source = policy + panel;

function block(startMarker, endMarker) {
	const start = source.indexOf(startMarker);
	const end = source.indexOf(endMarker, start + startMarker.length);
	assert.ok(start >= 0 && end > start, `${startMarker} 到 ${endMarker} 必须可定位`);
	return source.slice(start, end);
}

test("非 git 仓库 / 未安装 git 时暂停 5 秒状态轮询", () => {
	const interval = block("// 5 秒轮询", "// 窗口重新聚焦补一轮");
	assert.match(interval, /if \(suspended \|\| isMutating\(\) \|\| document\.hidden\) return;/);
	assert.match(interval, /\[enabled, capabilities\.statusPoll, suspended, refreshStatus, readAheadBehind, isMutating\]/);
	// 能力缺席时连 effect 都不注册。
	assert.match(interval, /if \(!enabled \|\| !capabilities\.statusPoll\) return;/);
});

/**
 * 5 秒轮询同时重读 push/pull 角标（只读本地 refs）。
 *
 * 背景：角标原本只在 fetch 成功后才计数（手动刷新 / 5 分钟定时器），而 `git push`
 * 已把本地远程跟踪引用更新到位——AI 在终端里推完却要等到下一轮 fetch 才消失。
 * 修复：每轮静默轮询重读一次本地差距（一次 rev-list，不发网络），5 秒内归零。
 */
test("5 秒轮询重读本地角标，且该路径不 fetch 远程", () => {
	const interval = block("// 5 秒轮询", "// 窗口重新聚焦补一轮");
	assert.match(interval, /void refreshStatus\(true\);/);
	assert.match(interval, /void readAheadBehind\(\);/);
	// 网络请求必须留在手动刷新与 5 分钟定时器上，轮询不得触发 fetch
	assert.doesNotMatch(interval, /refreshAheadBehind\(/);
});

test("readAheadBehind 只读本地 refs，失败静默保持上次值", () => {
	const readBlock = panel.slice(panel.indexOf("const readAheadBehind = useCallback"), panel.indexOf("const refreshAheadBehind = useCallback"));
	assert.match(readBlock, /aheadBehindRef\.current/);
	// 关键：不引用 fetchRef —— 离线或 fetch 超时也必须能更新角标
	assert.doesNotMatch(readBlock, /fetchRef/);
	assert.match(readBlock, /writeAheadBehindCache\(projectId, currentRepoScopeKey, result\)/);
});

/**
 * 角标读取不得重叠，也不得在窗口不可见时白跑。
 *
 * 背景：角标改为每 5 秒重读后，调用频次提高了 60 倍。慢仓库（大历史 / 网络盘）
 * 单次 rev-list 可能超过一轮心跳，不做串行化就会一轮叠一个 git 子进程；窗口最小化 /
 * 被遮挡时这一轮结果没有用户在看，却要白扫一遍 worktree（status 是这套轮询里最贵的一步）。
 */
test("本地角标读取串行化：同一时刻只有一个 rev-list 在飞", () => {
	const readBlock = panel.slice(panel.indexOf("const readAheadBehind = useCallback"), panel.indexOf("const refreshAheadBehind = useCallback"));
	assert.match(readBlock, /const inFlight = aheadBehindInFlightRef\.current;/);
	// 等到前一个读落地再读：既防堆叠，也保证 fetch 之后的调用拿到新 refs
	assert.match(readBlock, /if \(inFlight\) await inFlight;/);
	// 只清自己登记的那一次，否则等待中的后来者会被错误解锁
	assert.match(readBlock, /if \(aheadBehindInFlightRef\.current === task\) aheadBehindInFlightRef\.current = null;/);
});

test("窗口不可见时跳过 5 秒轮询（可见性而非聚焦：切到终端仍要跟平角标）", () => {
	const interval = block("// 5 秒轮询", "// 窗口重新聚焦补一轮");
	assert.match(interval, /document\.hidden/);
	// 必须在发起 status 之前短路，否则省不下最贵的那一步
	assert.ok(interval.indexOf("document.hidden") < interval.indexOf("void refreshStatus(true);"), "可见性判断应先于 refresh");
});

test("refreshAheadBehind 先本地计数再 fetch，fetch 失败不丢本地结果", () => {
	const refreshBlock = panel.slice(panel.indexOf("const refreshAheadBehind = useCallback"), panel.indexOf("const refresh = useCallback"));
	// 本地先读一次（立即反馈）；fetchRemote=false 时到此为止，不做任何网络请求
	assert.match(refreshBlock, /await readAheadBehind\(\);\s*if \(!fetchRemote\) return;/);
	assert.match(refreshBlock, /await fetch\(props\.projectId\);/);
	// fetch 之后再读一次：只有这一步用来校正 behind（别人推到远端的新提交）
	assert.equal((refreshBlock.match(/await readAheadBehind\(\);/g) ?? []).length, 2, "应先本地读一次、fetch 后再读一次");
});

test("窗口重新聚焦时补一轮静默刷新与本地角标重读", () => {
	const focus = block("// 窗口重新聚焦补一轮", "本面板的 refs 监听 id");
	assert.match(focus, /window\.addEventListener\("focus", onFocus\)/);
	// 副作用必须配对清理，否则项目/仓库切换会累积监听器
	assert.match(focus, /return \(\) => window\.removeEventListener\("focus", onFocus\);/);
	assert.match(focus, /void refreshStatus\(true\);/);
	assert.match(focus, /void readAheadBehind\(\);/);
	assert.match(focus, /\[enabled, capabilities\.statusPoll, suspended, refreshStatus, readAheadBehind, isMutating\]/);
});

test("push/pull 成功后不再额外等一轮 fetch 计数", () => {
	// push/pull 后本地 refs 已是最终结果：refresh 的非 silent 路径「先本地后 fetch」即可给出准确角标，
	// 旧的 `await refresh(); await refreshAheadBehind();` 会在每次 push 后再多跑一次 fetch。
	assert.doesNotMatch(panel, /await refresh\(\);\s*await refreshAheadBehind\(\);/);
	for (const marker of ["const doPush = async () => {", "const doPull = async () => {"]) {
		const pushBlock = panel.slice(panel.indexOf(marker), panel.indexOf("\n\t};", panel.indexOf(marker)));
		assert.match(pushBlock, /await refresh\(\);/);
		assert.doesNotMatch(pushBlock, /refreshAheadBehind\(/);
	}
});

test("非 git 仓库 / 未安装 git 时暂停 5 分钟 fetch 远程轮询", () => {
	const fetchBlock = policy.slice(policy.indexOf("// 5 分钟 fetch 远程"));
	assert.match(fetchBlock, /if \(!enabled \|\| !capabilities\.autoFetch \|\| suspended \|\| !hasFetch \|\| !hasAheadBehind\) return;/);
	assert.match(fetchBlock, /\[enabled, capabilities\.autoFetch, suspended, hasFetch, hasAheadBehind, refreshAheadBehind, isMutating\]/);
	// 首次挂载不得立刻 fetch：必须等 refresh 成功确认仓库，否则非 git 项目一打开就 git fetch 报 128
	assert.doesNotMatch(fetchBlock, /void refreshAheadBehind\(\);\s*const timer/);
});

test("外层 render 重新包装 Git API 时不触发额外 status 刷新", () => {
	const refreshBlock = panel.slice(panel.indexOf("const refresh = useCallback"), panel.indexOf("// 打开 Git drawer 时首次加载"));
	// getStatus 通过 ref 读取，refresh 的身份只随项目/仓库作用域变化。
	assert.match(refreshBlock, /getStatusRef\.current\(projectId\)/);
	assert.match(refreshBlock, /\[props\.projectId, repoScopeKey, refreshAheadBehind\]/);
	assert.doesNotMatch(refreshBlock, /props\.getStatus\(projectId\)/);
});

test("远程角标计时器不依赖每次 render 新建的 fetch 包装器", () => {
	const fetchBlock = policy.slice(policy.indexOf("// 5 分钟 fetch 远程"));
	assert.match(fetchBlock, /hasFetch/);
	assert.doesNotMatch(fetchBlock, /props\.fetch, props\.aheadBehind/);
});

test("仅非 silent 的 refresh 成功路径才会 fetch 远程", () => {
	// 成功分支改用函数式 setGroups（未变则保留原引用），锚点随之更新。
	const successBlock = panel.slice(panel.indexOf("setGroups((current) =>"));
	const afterGroups = successBlock.slice(0, successBlock.indexOf("} catch (caught)"));
	assert.match(afterGroups, /if \(!silent\) void refreshAheadBehind\(\);/);
});

test("refresh 成功路径清除仓库/工具标记（git init 或安装 git 后自动恢复轮询）", () => {
	// 成功分支 setGroups 之后紧接着清除两个标记
	const successBlock = panel.slice(panel.indexOf("setGroups((current) =>"));
	const afterGroups = successBlock.slice(0, successBlock.indexOf("} catch (caught)"));
	assert.match(afterGroups, /setNotAGitRepo\(false\);/);
	assert.match(afterGroups, /setGitNotInstalled\(false\);/);
});

test("能力位关闭时四个 effect 都不注册自动动作", () => {
	assert.match(policy, /if \(!enabled \|\| !capabilities\.statusPoll\) return;/);
	assert.match(policy, /if \(!enabled \|\| !capabilities\.refsWatch \|\| suspended\) return;/);
	assert.match(policy, /if \(!enabled \|\| !capabilities\.autoFetch \|\| suspended \|\| !hasFetch \|\| !hasAheadBehind\) return;/);
	assert.match(policy, /export const LOCAL_GIT_AUTO_REFRESH: GitAutoRefreshCapabilities = \{ statusPoll: true, refsWatch: true, autoFetch: true \};/);
	// 面板只传能力位，不在这里写 backend 分支。
	assert.match(panel, /capabilities: autoRefreshCapabilities/);
	assert.doesNotMatch(panel, /backend === "ssh"/);
});
