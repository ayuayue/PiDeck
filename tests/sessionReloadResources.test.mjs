import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path) => readFileSync(path, "utf8");

/**
 * `/reload` 的宿主链路契约：
 * - 扩展只提供 reload 命令，宿主直接发 RPC prompt，避免 sendPrompt 的乐观用户消息；
 * - 发送前确认命令来自 pi-deck-runtime，避免把 `/reload` 当普通问题交给模型；
 * - IPC 三处（通道常量、main handler、preload）同步，否则运行时 undefined。
 */
test("AgentManager.reloadResources validates the extension command and uses raw RPC prompt", () => {
	const source = read("src/main/pi/AgentManager.ts");
	assert.match(source, /async\s+reloadResources\s*\(\s*agentId\s*:\s*string\s*\)/);
	assert.match(source, /pi-deck-runtime\.ts/);
	assert.match(source, /type:\s*"get_state"/);
	assert.match(source, /hasPendingUIRequests\s*\(\s*agentId\s*\)/);
	assert.match(source, /type:\s*"prompt"\s*,\s*message:\s*`\/\$\{reloadCommand\.name\}`/);
	assert.match(source, /readPromptDisposition\s*\(\s*response\.data\s*\)/);
	// 不能复用 sendPrompt：它会在 RPC 前 addMessage 写一条用户气泡。
	const body = source.slice(source.indexOf("async reloadResources"), source.indexOf("async reloadResources") + 3000);
	assert.doesNotMatch(body, /this\.sendPrompt\s*\(/);
});

test("reloadResources IPC is wired through shared channel, main handler, and preload", () => {
	const channel = read("src/shared/ipc.ts");
	const main = read("src/main/ipc/sessionIpc.ts");
	const preload = read("src/preload/index.ts");
	const coordinator = read("src/main/sessions/SessionRuntimeCoordinator.ts");
	assert.match(channel, /sessionsRuntimeReloadResources:\s*"sessions:runtime-reload-resources"/);
	assert.match(main, /ipcChannels\.sessionsRuntimeReloadResources[\s\S]*?sessionRuntimeCoordinator\.reloadResources\s*\(\s*target\s*\)/);
	assert.match(preload, /reloadResources:\s*\(target:\s*SessionRuntimeTarget\)\s*=>\s*ipcRenderer\.invoke\(ipcChannels\.sessionsRuntimeReloadResources/);
	assert.match(coordinator, /reloadResources\s*\(\s*target:\s*SessionRuntimeTarget\s*\)/);
});

test("composer send path is gated while a hot reload is in flight", () => {
	const send = read("src/renderer/src/hooks/useSessionSend.ts");
	const atoms = read("src/renderer/src/atoms/session-commands-atoms.ts");
	assert.match(atoms, /sessionReloadingByIdAtom\s*=\s*atom<Record<string,\s*boolean>>/);
	assert.match(send, /store\.get\(sessionReloadingByIdAtom\)\[sourceSessionId\]/);
	assert.match(send, /sessionCommand\.reloadResourcesBusy/);
});

test("run controls and reload quick button are pi-only", () => {
	const commands = read("src/renderer/src/utils/sessionCommands.ts");
	const control = read("src/renderer/src/components/session/SessionActionsControl.tsx");
	assert.match(commands, /resolveSessionReloadMode/);
	// DSH/ACP 没有会话级 reload：解析结果只有 resources / none，不再有 dshHost 分支。
	assert.doesNotMatch(commands, /dshHost/);
	assert.doesNotMatch(commands, /reloadDshHost/);
	assert.match(control, /runControl\?\.reloadMode\s*\?\?\s*"none"\)\s*===\s*"resources"/);
	// 「⋯」对所有后端保留（否则 DSH/ACP 丢掉会话操作入口），运行/重载快捷钮只给 pi。
	assert.match(control, /SessionMenuItems/);
});

test("run control opts out of the legacy header button box", () => {
	const control = read("src/renderer/src/components/session/SessionActionsControl.tsx");
	const foundation = read("src/renderer/src/styles/foundation.css");
	// legacy `.chat-header-actions button` 会把每个头部按钮撑成 60px 宽的面板色块 + 边框，
	// 迷你控件必须显式顶掉这三项（utilities 层高于 legacy 层才能压住）。
	assert.match(foundation, /\.chat-header-actions button,?\s*\n?[^{]*\{[\s\S]{0,120}min-width:\s*60px/);
	assert.match(control, /min-w-0/);
	assert.match(control, /border-0/);
	assert.match(control, /bg-transparent/);
});

test("runtime adapter is always injected and listed in the extension manifest", () => {
	const builtIns = read("src/main/extensions/builtInExtensions.ts");
	const manifest = JSON.parse(read("resources/extensions/extensions-manifest.json"));
	assert.match(builtIns, /INTERNAL_BUILT_IN_EXTENSIONS\s*=\s*\[[^\]]*"pi-deck-runtime\.ts"/);
	const entry = manifest.files.find((file) => file.name === "pi-deck-runtime.ts");
	assert.ok(entry, "extensions-manifest.json 必须包含 pi-deck-runtime.ts");
	assert.equal(entry.bytes > 0, true);
});

test("hot reload animates only the reload button, not the start/restart button", () => {
	const control = read("src/renderer/src/components/session/SessionActionsControl.tsx");
	// 用户可见症状：点「重载」后旁边的启动/重启钮也变成了旋转 loader，看起来像点错了按钮。
	// 热重载会把 capabilities.pending 置真（busy），必须显式排除它，只让重载钮自己转。
	assert.match(control, /const\s+primaryPending\s*=\s*Boolean\(\s*runControl\?\.isRestarting\s*\|\|\s*\(\s*capabilities\?\.pending\s*&&\s*!runControl\?\.isReloading\s*\)\s*\)/);
	assert.doesNotMatch(control, /Boolean\(\s*runControl\?\.isRestarting\s*\|\|\s*runControl\?\.isReloading/);
	assert.match(control, /runControl\?\.isReloading\s*\?\s*<LoaderCircle[^>]*animate-pideck-spin/);
});

test("hot reload paints a reloading overlay on the session surface", () => {
	const view = read("src/renderer/src/components/session/SessionView.tsx");
	const stage = read("src/renderer/src/components/session/SessionSurfaceStage.tsx");
	const copyZh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const copyEn = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
	// 只转小按钮时会话侧没有任何变化，用户无法确认重载是否生效：时间线同样要有「正在重载…」遮罩。
	assert.match(view, /isReloading=\{Boolean\(runControl\?\.isReloading\)\}/);
	assert.match(stage, /isReloading\?\s*:\s*boolean/);
	assert.match(stage, /overlayVisible\s*=\s*isRestarting\s*\|\|\s*isReloading\s*\|\|/);
	assert.match(stage, /t\("message\.historyOverlay\.reloadingResources"\)/);
	assert.match(copyZh, /"message\.historyOverlay\.reloadingResources":/);
	assert.match(copyEn, /"message\.historyOverlay\.reloadingResources":/);
	// 成功提示只报结果本身，不再复述「扩展与技能」这类实现细节。
	assert.match(copyZh, /"app\.sessionResourcesReloaded":\s*"重载成功"/);
});

test("pi settings tab tells users that running sessions need a reload", () => {
	const tab = read("src/renderer/src/config/SettingsTab.tsx");
	const copyZh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	// 用户可见症状：在 Pi 配置页改了「默认工具」再回到会话，pi 的行为没变（settingsManager
	// 只在会话启动与 /reload 时重读 settings.json），没有任何提示会让人以为保存失败。
	assert.match(tab, /t\("config\.settings\.applyNote"\)/);
	assert.match(copyZh, /"config\.settings\.applyNote":\s*"[^"]*重载/);
});
