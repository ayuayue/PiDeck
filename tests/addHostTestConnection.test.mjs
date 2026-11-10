import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

/**
 * 「添加连接」的失败可读性 + 内联环境检测（用户反馈两轮）。
 *
 * 第一轮现场：本地 `ssh -i key ubuntu@host` 能连，PiDeck 添加却只报 SSH_HOST_AUTHENTICATION_FAILED。
 * 第二轮现场：添加之后另开一个进度弹窗走「建立 SSH 连接 / 探测远端环境 / 准备 helper / 准备远端 pi」，
 * 而最后一步其实从未真正探测过（状态 ready 就直接标完成）。
 *
 * 契约：
 * 1. 失败码翻译成人话（私钥被拒 / 读不到 / 带口令 / 网络不通 / pi 缺失各给下一步）；
 * 2. 整条流程（测试 → 保存 → 建会话 → 探测 pi）内联在同一张表单里，不再有独立进度弹窗；
 * 3. pi 探测失败时给安装命令（可复制）与手填绝对路径两条出路；
 * 4. 新建记录只有点「完成」才保留，关闭对话框即移除。
 */
const dialog = readFileSync("src/renderer/src/components/app/settings/AddHostDialog.tsx", "utf8");
const tab = readFileSync("src/renderer/src/components/app/settings/ConnectionsTab.tsx", "utf8");
const piIpc = readFileSync("src/main/ipc/remoteHostPiIpc.ts", "utf8");
const preload = readFileSync("src/preload/index.ts", "utf8");
const shared = readFileSync("src/shared/ipc.ts", "utf8");
const main = readFileSync("src/main/ipc/remoteHostIpc.ts", "utf8");
const failureCopy = readFileSync("src/renderer/src/utils/remoteHostFailureCopy.ts", "utf8");
const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");

test("失败码被翻译成可行动的说明，而不是只显示稳定码", () => {
	for (const code of ["SSH_AUTH_KEY_REJECTED", "SSH_AUTH_KEY_UNREADABLE", "SSH_AUTH_PASSPHRASE_REQUIRED", "SSH_HOST_UNREACHABLE", "SSH_HOST_COMMAND_TIMEOUT", "SSH_HOST_AUTHENTICATION_FAILED", "REMOTE_HOST_IDENTITY_FILE_INVALID", "INVALID_SSH_LOCAL_PATH"]) {
		assert.ok(failureCopy.includes(`case "${code}"`), `code ${code} must map to copy`);
	}
	// 防回退：错误行不能是 `{code}` 占位。
	assert.doesNotMatch(dialog, /t\("settings\.connections\.add\.failed", \{ code/);
	// 握手、建会话两条链路都把稳定码交给同一份翻译。
	assert.match(dialog, /remoteHostFailureReason\(tested\.code\)/);
	assert.match(dialog, /remoteHostFailureReason\(connected\.code\)/);
	for (const key of ["keyRejected", "keyUnreadable", "passphraseRequired", "unreachable", "timeout", "authFailed", "keyPathInvalid", "passwordRequired"]) {
		assert.ok(zh.includes(`"settings.connections.add.reason.${key}":`), `zh-CN 缺 reason.${key}`);
		assert.ok(en.includes(`"settings.connections.add.reason.${key}":`), `en-US 缺 reason.${key}`);
	}
});

test("测试连接：三处通道齐备，且不写 host store", () => {
	assert.match(shared, /remoteHostTest:\s*"remote:test"/);
	assert.match(preload, /test:\s*\(input: import\("\.\.\/shared\/types\/remoteHost"\)\.RemoteHostAddInput\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.remoteHostTest, input\)/);
	assert.match(main, /ipcMain\.handle\(ipcChannels\.remoteHostTest/);
	// 只调 probe（握手），绝不 createDraft/offerPin。
	const handler = main.slice(main.indexOf("ipcChannels.remoteHostTest"), main.indexOf("ipcChannels.remoteHostAdd, async"));
	assert.match(handler, /pinStore\.probe\(/);
	assert.doesNotMatch(handler, /createDraft|offerPin|confirmPin/);
});

test("测试连接按钮：密码方式禁用并说明，结果行区分成功与失败", () => {
	assert.match(dialog, /onClick=\{\(\) => void testConnection\(\)\}/);
	assert.match(dialog, /settings\.connections\.add\.test/);
	assert.match(dialog, /settings\.connections\.add\.testing/);
	assert.match(dialog, /form\.auth === "password"/, "password auth must not be testable through the probe");
	assert.match(dialog, /t\("settings\.connections\.add\.testPasswordUnsupported"\)/);
	assert.match(dialog, /settings\.connections\.add\.testOk/);
	assert.match(dialog, /settings\.connections\.add\.testFailed/);
	// 结果在参数变化后必须清空：否则旧的成功结论会跟着新配置一起显示。
	assert.match(dialog, /setTestResult\(null\);\n\t\}, \[form\.hostName, form\.port, form\.user, form\.identityFile, form\.auth, form\.passphrase\]\)/);
});

test("测试成功的结论用绿色 + 勾选图标，不是一行灰字", () => {
	// 用户反馈：成功时只是把灰色提示换成另一句灰字，看不出「过了」。
	assert.match(dialog, /testResult\.ok \? "text-\[var\(--color-success\)\]" : "text-destructive"/);
	assert.match(dialog, /testResult\.ok \? <CircleCheck/);
	assert.match(dialog, /<TriangleAlert/);
	assert.match(dialog, /role="status"/);
});

test("内联环境检测：探测通道三处齐备，表单直接调用", () => {
	// 通道：shared 常量 → main handler → preload 转发。
	assert.match(shared, /remoteHostPiProbe:\s*"remote:pi-probe"/);
	assert.match(shared, /remoteHostPiPath:\s*"remote:pi-path"/);
	assert.match(preload, /probePi: \(hostId: string\) => ipcRenderer\.invoke\(ipcChannels\.remoteHostPiProbe/);
	assert.match(preload, /setPiPath: \(hostId: string, path: string \| null\) => ipcRenderer\.invoke\(ipcChannels\.remoteHostPiPath/);
	assert.match(piIpc, /ipcMain\.handle\(ipcChannels\.remoteHostPiProbe/);
	assert.match(piIpc, /ipcMain\.handle\(ipcChannels\.remoteHostPiPath/);
	// 探测走既有服务事实，不新开 SSH 通道。
	assert.match(piIpc, /service\.remotePiRuntimeFacts\(hostId\)/);
	assert.match(piIpc, /service\.setRemotePiCommand\(hostId, command\)/);
	// 子域由 remoteHostIpc 注册（与编辑域/扫描域同一装配）。
	assert.match(main, /registerRemoteHostPiIpc\(\{ enabled: input\.enabled, resolveService \}\)/);
});

test("保存并检测：测试 → 保存 → 建会话 → 探测 pi，四步都内联在表单里", () => {
	// 顺序由同一个函数串起来，且每一步的失败都停在表单。
	const start = dialog.indexOf("const runSetup = useCallback(");
	const body = dialog.slice(start, dialog.indexOf("const savePiPath = useCallback("));
	const order = ["remoteHosts.test(input)", "remoteHosts.add(input)", "remoteHosts.connect(hostId", "probePi(hostId)"].map((needle) => body.indexOf(needle));
	assert.ok(
		order.every((index) => index >= 0),
		`runSetup must drive every step: ${JSON.stringify(order)}`,
	);
	assert.deepEqual(
		[...order].sort((a, b) => a - b),
		order,
		"steps must run in the order test → add → connect → probe",
	);
	// 四步状态与步骤文案都在同一个面板里。
	for (const key of ["test", "save", "connect", "pi"]) assert.ok(dialog.includes(`settings.connections.add.step.${key}`), `missing step copy ${key}`);
	assert.match(dialog, /SETUP_STEPS\.map\(\(key\) =>/);
	// 保存成功后字段锁定：改字段就不是同一条记录了。
	assert.match(dialog, /const formLocked = setupRunning \|\| steps\.save === "done";/);
	assert.match(dialog, /<fieldset disabled=\{formLocked\}/);
});

test("pi 探测失败：安装命令可复制，也可以手填绝对路径", () => {
	assert.match(dialog, /const PI_INSTALL_COMMAND = "npm i -g @earendil-works\/pi-coding-agent";/);
	assert.match(dialog, /navigator\.clipboard\.writeText\(PI_INSTALL_COMMAND\)/);
	assert.match(dialog, /piOutcome\.code === "REMOTE_PI_NOT_FOUND"/);
	for (const key of ["piInstallHint", "piCopy", "piCopied", "piPathLabel", "piPathPlaceholder", "piPathHint", "piPathSave", "piPathSaving", "piFound", "piWarning"]) {
		assert.ok(zh.includes(`"settings.connections.add.${key}":`), `zh-CN 缺 ${key}`);
		assert.ok(en.includes(`"settings.connections.add.${key}":`), `en-US 缺 ${key}`);
	}
	// 手填路径的形状校验与主进程同源：绝对路径 + 限定字符集，不合法不发请求。
	assert.match(dialog, /!\/\^\\\/\[A-Za-z0-9\._\/-\]\+\$\/\.test\(value\)/);
	assert.match(dialog, /remoteHosts\.setPiPath\(hostId, value\.length === 0 \? null : value\)/);
	// 探测结果只认得稳定码，不猜原因。
	for (const code of ["REMOTE_PI_NOT_FOUND", "REMOTE_PI_TOO_OLD", "REMOTE_PI_VERSION_UNREADABLE", "REMOTE_PI_SHELL_PATH_UNREADABLE"]) {
		assert.ok(failureCopy.includes(`case "${code}"`), `pi code ${code} must map to copy`);
	}
});

test("关闭对话框不删除记录：失败留下的未验证连接能直接编辑", () => {
	// 2026-11 用户反馈：失败就丢，下次还得重填。记录的去留交给列表里的删除按钮，
	// 关闭对话框（X / Esc / 取消）只关闭，不再调用 remove。
	assert.doesNotMatch(dialog, /desktopApi\.remoteHosts\s*\.remove\(created\)/);
	assert.doesNotMatch(dialog, /committedRef/);
	assert.doesNotMatch(dialog, /createdHostRef/);
	assert.doesNotMatch(dialog, /settings\.connections\.add\.cancelDiscard/);
	// 关闭路径（X / Esc / 取消）都走同一个 close()。
	assert.match(dialog, /if \(!open\) close\(\);/);
	assert.match(dialog, /onClick=\{close\}/);
	// 对话框卸载后仍可能在飞的请求不得回写状态（但保留已写入的记录）。
	assert.match(dialog, /aliveRef\.current = false;/);
});

test("握手失败保留下来的草稿：对话框内联说明，不再由宿主代管", () => {
	const types = readFileSync("src/shared/types/remoteHost.ts", "utf8");
	assert.match(types, /saved\?: boolean; hostId\?: string/);
	assert.match(main, /saved: true, hostId: profile\.id/);
	// 草稿由对话框记住，重试时不重复 add（改成原地 update）：saved 分支必须同时写 hostIdRef，
	// 否则重试会再 add 一次，每失败一次就多一条同名记录。
	assert.match(dialog, /if \(added\.saved === true && added\.hostId !== undefined\) hostIdRef\.current = added\.hostId;/);
	// 预检（测试连接）失败也要落库：否则用户关掉对话框就只剩重填一条路。
	assert.match(dialog, /const persisted = await withSetupTimeout\(desktopApi\.remoteHosts\.add\(input\), SETUP_STEP_TIMEOUT_MS\.save\);/);
	assert.match(dialog, /if \(!persisted\.ok && persisted\.saved === true && persisted\.hostId !== undefined\) \{/);
	assert.match(dialog, /settings\.connections\.add\.savedUnverified/);
	assert.match(dialog, /const existingHostId = hostIdRef\.current;\s+if \(existingHostId !== null\) \{/);
	// 宿主不再接收「已保存但未验证」的回调，也不再自己发起连接。
	assert.doesNotMatch(tab, /onSavedUnverified/);
	assert.doesNotMatch(tab, /onSubmitted/);
});

test("独立连接进度弹窗已删除，连接状态改由列表行内呈现", () => {
	assert.equal(existsSync("src/renderer/src/components/app/settings/RemoteConnectionProgressDialog.tsx"), false);
	assert.equal(existsSync("src/renderer/src/components/app/settings/remoteConnectionProgressState.ts"), false);
	assert.doesNotMatch(dialog, /RemoteConnectionProgressDialog/);
	assert.doesNotMatch(tab, /RemoteConnectionProgressDialog/);
	// 行内仍保留：状态点 / 失败码 / 重试 / 诊断。
	assert.match(tab, /settings\.connections\.lastFailure/);
	assert.match(tab, /settings\.connections\.diagnostics/);
	assert.match(tab, /resolveRemoteHostConnectionTone/);
});

test("类型标记：SSH 行带 SSH 徽标，添加项目的远端主机项标明 SSH", () => {
	assert.match(tab, /settings\.connections\.ssh\.badge/);
	assert.match(tab, /settings\.connections\.wsl\.badge/);
	const enroll = readFileSync("src/renderer/src/components/sidebar/RemoteProjectEnrollDialog.tsx", "utf8");
	assert.match(enroll, /settings\.connections\.ssh\.badge/);
	assert.ok(zh.includes('"settings.connections.ssh.badge": "SSH"'));
});

test("编辑未验证连接会重新握手，改完才可能变成可连接", () => {
	const edit = readFileSync("src/main/ipc/remoteHostEditIpc.ts", "utf8");
	assert.match(edit, /updated\.endpointChanged \|\| updated\.profile\.verifiedEndpoint === undefined/);
	assert.match(edit, /await store\.offerPin\(hostId, senderId/);
	assert.match(edit, /remotePiCommand: profile\.remotePiCommand/);
});

test("四步流程不会因为一次没回来的 IPC 永久卡在「进行中」", () => {
	// 实机反馈（2026-11）：点「保存并检测」后第一步一直显示进行中，整张表单被锁住。
	// 判据：每个远端调用都有上限，异常一律收尾成「失败」，且失败后旧链路不得再回写状态。
	const body = dialog.slice(dialog.indexOf("const runSetup = useCallback("), dialog.indexOf("const savePiPath = useCallback("));
	for (const call of ["remoteHosts.test(input)", "remoteHosts.add(input)", "remoteHosts.connect(hostId", "probePi(hostId)"]) {
		assert.ok(body.includes(call), `runSetup 必须真的调用 ${call}`);
	}
	// 每一步都经 withSetupTimeout 包一层（4 步 = 至少 5 次：add 在失败分支还会再调一次）。
	assert.ok((body.match(/withSetupTimeout\(/g) ?? []).length >= 5, "每个 IPC 都要有单步上限");
	assert.match(dialog, /const SETUP_STEP_TIMEOUT_MS: Record<SetupStepKey, number> = \{ test: 90_000, save: 90_000, connect: 300_000, pi: 150_000 \}/);
	// 异常必须收尾：把当前 active 的那一步翻成 failed，并给出稳定说法。
	assert.match(body, /catch \(error\) \{/);
	assert.match(body, /\[step\]: "failed"/);
	assert.match(dialog, /settings\.connections\.add\.stepStalled/);
	assert.match(dialog, /settings\.connections\.add\.stepFailed/);
	for (const key of ["stepStalled", "stepFailed"]) {
		assert.ok(zh.includes(`"settings.connections.add.${key}":`), `zh-CN 缺 ${key}`);
		assert.ok(en.includes(`"settings.connections.add.${key}":`), `en-US 缺 ${key}`);
	}
	// 令牌：超时后旧链路（可能还挂着）不得再改 steps/testResult。
	assert.match(dialog, /const setupRunRef = useRef\(0\)/);
	assert.match(body, /const live = \(\): boolean => aliveRef\.current && setupRunRef\.current === token/);
	assert.ok(!/await[^\n]*\n\s*if \(!aliveRef\.current\) return;/.test(body), "await 之后必须用 live() 而不是裸 aliveRef 判断");
});

test("StrictMode 双挂载后 aliveRef 必须重新为真，否则四步流程会静默停摆", () => {
	// 实机根因（2026-11）：React StrictMode（dev）mount → unmount → mount。cleanup 里置 false、
	// 挂载时不置回 true，第二次挂载后 aliveRef 永远是 false ⇒ 每个 await 回来都在
	// `if (!aliveRef.current) return;` 静静返回，步骤永远停在「进行中」，而主进程日志显示
	// `Host test finished ok`。同文件的 mountedRef/aliveRef 兄弟组件都在 effect 里置 true。
	const body = dialog.slice(dialog.indexOf("const aliveRef = useRef(true);"), dialog.indexOf("const setupRunning ="));
	assert.match(body, /aliveRef\.current = true;/, "effect 里必须把 aliveRef 置回 true");
	assert.match(body, /return \(\) => \{\s*aliveRef\.current = false;\s*\};/);
	// 顺序也重要：true 必须在 cleanup 之前（同一个 effect 内）。
	assert.ok(body.indexOf("aliveRef.current = true;") < body.indexOf("aliveRef.current = false;"));
});
