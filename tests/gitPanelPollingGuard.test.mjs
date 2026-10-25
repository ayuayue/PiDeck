/**
 * Git 面板非 git 仓库轮询暂停契约测试。
 *
 * 背景：git 侧栏每 5 秒静默轮询 status + 每 5 分钟 fetch 远程。当项目目录不是
 * git 仓库（或未安装 git）时，轮询每次都会 spawn git 报错，控制台刷屏且浪费
 * 进程开销。修复：非仓库标记置位后暂停两个定时器；仓库状态恢复（git init /
 * 安装 git）后由 refresh 成功路径清标记自动恢复轮询。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync("src/renderer/src/components/app/GitPanel.tsx", "utf8");

test("非 git 仓库 / 未安装 git 时暂停 5 秒状态轮询", () => {
	// 静默轮询 interval 回调以 notAGitRepo || gitNotInstalled 短路退出
	const intervalBlock = source.slice(source.indexOf("每 5 秒拉取一次最新工作区状态"), source.indexOf("窗口重新获得焦点时补一次静默刷新"));
	assert.match(intervalBlock, /if \(notAGitRepo \|\| gitNotInstalled\) return;/);
	// interval 依赖包含刷新回调、本地角标读取与两个标记：项目/仓库作用域变化时重建，错误恢复后自动重启
	assert.match(intervalBlock, /\[layout, refresh, readAheadBehind, notAGitRepo, gitNotInstalled\]/);
});

/**
 * 5 秒轮询同时重读 push/pull 角标（只读本地 refs）。
 *
 * 背景：角标原本只在 fetch 成功后才计数（手动刷新 / 5 分钟定时器），而 `git push`
 * 已把本地远程跟踪引用更新到位——AI 在终端里推完却要等到下一轮 fetch 才消失。
 * 修复：每轮静默轮询重读一次本地差距（一次 rev-list，不发网络），5 秒内归零。
 */
test("5 秒轮询重读本地角标，且该路径不 fetch 远程", () => {
	const intervalBlock = source.slice(source.indexOf("每 5 秒拉取一次最新工作区状态"), source.indexOf("窗口重新获得焦点时补一次静默刷新"));
	assert.match(intervalBlock, /void refresh\(true\);/);
	assert.match(intervalBlock, /void readAheadBehind\(\);/);
	// 网络请求必须留在手动刷新与 5 分钟定时器上，轮询不得触发 fetch
	assert.doesNotMatch(intervalBlock, /refreshAheadBehind\(/);
	// mutation（push/pull 进行中）跳过，避免读到中间态把角标写回旧值
	assert.match(intervalBlock, /if \(mutationRunningRef\.current\) return;/);
});

test("readAheadBehind 只读本地 refs，失败静默保持上次值", () => {
	const readBlock = source.slice(source.indexOf("const readAheadBehind = useCallback"), source.indexOf("const refreshAheadBehind = useCallback"));
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
	const readBlock = source.slice(source.indexOf("const readAheadBehind = useCallback"), source.indexOf("const refreshAheadBehind = useCallback"));
	assert.match(readBlock, /const inFlight = aheadBehindInFlightRef\.current;/);
	// 等到前一个读落地再读：既防堆叠，也保证 fetch 之后的调用拿到新 refs
	assert.match(readBlock, /if \(inFlight\) await inFlight;/);
	// 只清自己登记的那一次，否则等待中的后来者会被错误解锁
	assert.match(readBlock, /if \(aheadBehindInFlightRef\.current === task\) aheadBehindInFlightRef\.current = null;/);
});

test("窗口不可见时跳过 5 秒轮询（可见性而非聚焦：切到终端仍要跟平角标）", () => {
	const intervalBlock = source.slice(source.indexOf("每 5 秒拉取一次最新工作区状态"), source.indexOf("窗口重新获得焦点时补一次静默刷新"));
	assert.match(intervalBlock, /if \(document\.hidden\) return;/);
	// 必须在发起 status 之前短路，否则省不下最贵的那一步
	assert.ok(intervalBlock.indexOf("document.hidden") < intervalBlock.indexOf("void refresh(true);"), "可见性判断应先于 refresh");
});

test("refreshAheadBehind 先本地计数再 fetch，fetch 失败不丢本地结果", () => {
	const refreshBlock = source.slice(source.indexOf("const refreshAheadBehind = useCallback"), source.indexOf("const refresh = useCallback"));
	// 本地先读一次（立即反馈）；fetchRemote=false 时到此为止，不做任何网络请求
	assert.match(refreshBlock, /await readAheadBehind\(\);\s*if \(!fetchRemote\) return;/);
	assert.match(refreshBlock, /await fetch\(props\.projectId\);/);
	// fetch 之后再读一次：只有这一步用来校正 behind（别人推到远端的新提交）
	assert.equal((refreshBlock.match(/await readAheadBehind\(\);/g) ?? []).length, 2, "应先本地读一次、fetch 后再读一次");
});

test("窗口重新聚焦时补一轮静默刷新与本地角标重读", () => {
	const focusBlock = source.slice(source.indexOf("窗口重新获得焦点时补一次静默刷新"), source.indexOf("定时 fetch 远程"));
	assert.ok(focusBlock.length > 0, "应存在 focus 补刷逻辑");
	assert.match(focusBlock, /window\.addEventListener\("focus", onFocus\)/);
	// 副作用必须配对清理，否则项目/仓库切换会累积监听器
	assert.match(focusBlock, /return \(\) => window\.removeEventListener\("focus", onFocus\);/);
	assert.match(focusBlock, /void refresh\(true\);/);
	assert.match(focusBlock, /void readAheadBehind\(\);/);
	assert.match(focusBlock, /\[layout, refresh, readAheadBehind, notAGitRepo, gitNotInstalled\]/);
});

test("push/pull 成功后不再额外等一轮 fetch 计数", () => {
	// push/pull 后本地 refs 已是最终结果：refresh 的非 silent 路径「先本地后 fetch」即可给出准确角标，
	// 旧的 `await refresh(); await refreshAheadBehind();` 会在每次 push 后再多跑一次 fetch。
	assert.doesNotMatch(source, /await refresh\(\);\s*await refreshAheadBehind\(\);/);
	for (const marker of ["const doPush = async () => {", "const doPull = async () => {"]) {
		const block = source.slice(source.indexOf(marker), source.indexOf("\n\t};", source.indexOf(marker)));
		assert.match(block, /await refresh\(\);/);
		assert.doesNotMatch(block, /refreshAheadBehind\(/);
	}
});

test("非 git 仓库 / 未安装 git 时暂停 5 分钟 fetch 远程轮询", () => {
	const fetchBlock = source.slice(source.indexOf("每 5 分钟刷新一次 ahead/behind 角标"), source.indexOf("toggleResource"));
	assert.match(fetchBlock, /if \(notAGitRepo \|\| gitNotInstalled\) return;/);
	assert.match(fetchBlock, /\[layout, refreshAheadBehind, notAGitRepo, gitNotInstalled\]/);
	// 首次挂载不得立刻 fetch：必须等 refresh 成功确认仓库，否则非 git 项目一打开就 git fetch 报 128
	assert.doesNotMatch(fetchBlock, /void refreshAheadBehind\(\);\s*const timer/);
});

test("外层 render 重新包装 Git API 时不触发额外 status 刷新", () => {
	const refreshBlock = source.slice(source.indexOf("const refresh = useCallback"), source.indexOf("// 打开 Git drawer 时首次加载"));
	// getStatus 通过 ref 读取，refresh 的身份只随项目/仓库作用域变化。
	assert.match(refreshBlock, /getStatusRef\.current\(projectId\)/);
	assert.match(refreshBlock, /\[props\.projectId, repoScopeKey, refreshAheadBehind\]/);
	assert.doesNotMatch(refreshBlock, /props\.getStatus\(projectId\)/);
});

test("远程角标计时器不依赖每次 render 新建的 fetch 包装器", () => {
	const fetchBlock = source.slice(source.indexOf("每 5 分钟刷新一次 ahead/behind 角标"), source.indexOf("toggleResource"));
	assert.match(fetchBlock, /fetchRef\.current/);
	assert.match(fetchBlock, /\[layout, refreshAheadBehind, notAGitRepo, gitNotInstalled\]/);
	assert.doesNotMatch(fetchBlock, /props\.fetch, props\.aheadBehind/);
});

test("仅非 silent 的 refresh 成功路径才会 fetch 远程", () => {
	// 成功分支改用函数式 setGroups（未变则保留原引用），锚点随之更新。
	const successBlock = source.slice(source.indexOf("setGroups((current) =>"));
	const afterGroups = successBlock.slice(0, successBlock.indexOf("} catch (caught)"));
	assert.match(afterGroups, /if \(!silent\) void refreshAheadBehind\(\);/);
});

test("refresh 成功路径清除仓库/工具标记（git init 或安装 git 后自动恢复轮询）", () => {
	// 成功分支 setGroups 之后紧接着清除两个标记
	// 成功分支改用函数式 setGroups（未变则保留原引用），锚点随之更新。
	const successBlock = source.slice(source.indexOf("setGroups((current) =>"));
	const afterGroups = successBlock.slice(0, successBlock.indexOf("} catch (caught)"));
	assert.match(afterGroups, /setNotAGitRepo\(false\);/);
	assert.match(afterGroups, /setGitNotInstalled\(false\);/);
});

test("静默失败同样置位非仓库/未安装标记（置位逻辑不在 !silent 分支内）", () => {
	// catch 块中置位先于 !silent UI 清理分支执行
	// 终止锚点必须从起始位置往后找：早期写法用的是全文件第一个 `} finally {`，
	// 只要前面（如 readAheadBehind 的在途请求收尾）新增一个 try/finally，
	// slice 起点就会大于终点拿到空串，断言假失败。
	const catchStart = source.indexOf("} catch (caught) {");
	const catchBlock = source.slice(catchStart, source.indexOf("} finally {", catchStart));
	const silentGuard = catchBlock.indexOf("if (!silent) {");
	assert.ok(silentGuard >= 0, "应存在 !silent 分支");
	// 置位语句必须出现在 !silent 之前——silent 轮询失败也要能停住轮询
	const beforeSilent = catchBlock.slice(0, silentGuard);
	assert.match(beforeSilent, /setNotAGitRepo\(true\);/);
	assert.match(beforeSilent, /setGitNotInstalled\(true\);/);
});

test("手动刷新按钮保留（用户 git init 后可立即手动恢复）", () => {
	// 手动刷新入口仍在（非 silent 刷新）
	assert.match(source, /void refresh\(\);/);
});

test("git init 后经 ref 读取最新作用域的 refresh（旧闭包会被作用域守卫丢弃）", () => {
	// refresh 每轮渲染写入 ref：props.gitInit 内部 refreshRepos 会让宿主重渲染，
	// repoScopeKey 可能从 projectRoot 切到 main 侧 resolve 出的 repo.path；
	// 若 init 按钮闭包直接调 refresh，其 repoScopeKey === repoScopeKeyRef.current
	// 守卫会判失败，结果被丢弃且 loading 卡死。
	assert.match(source, /const refreshRef = useRef\(refresh\);\s*refreshRef\.current = refresh;/);
	assert.ok((source.match(/void refreshRef\.current\(\);/g) ?? []).length >= 1, "init 完成路径应经 refreshRef 拉最新状态");
});

test("两个 git init 入口统一走 doInitRepo，不再从旧闭包直接调 refresh", () => {
	// 分支栏 / 空状态两个 init 按钮共用同一实现，避免两处修复不同步
	const initClicks = source.match(/onClick=\{\(\) => void doInitRepo\(\)\}/g) ?? [];
	assert.equal(initClicks.length, 2, "分支栏 + 空状态两个 init 按钮都应走 doInitRepo");
	// init 的 IPC 调用收敛到 doInitRepo 一处
	assert.equal((source.match(/await props\.gitInit\(props\.projectId\);/g) ?? []).length, 1, "gitInit IPC 调用应只在 doInitRepo 内出现一次");
	// 旧写法（init 完成后直接调闭包 refresh）已不存在
	assert.doesNotMatch(source, /await props\.gitInit\(props\.projectId\);\s*setNotAGitRepo\(false\);\s*void refresh\(\);/);
});
