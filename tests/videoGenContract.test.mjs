import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 生视频契约（对标 tests/imageGenContract.test.mjs）：
 * IPC 三处同步、pideck-video 协议装配、CSP 白名单、渲染层接线、i18n 三语对齐。
 * 正则一律空白容忍（\s*），改格式不许弄红这组断言。
 */

const read = (path) => readFileSync(path, "utf8");
const ipc = read("src/shared/ipc.ts");
const preload = read("src/preload/index.ts");
const mainIndex = read("src/main/index.ts");
const videogenIpc = read("src/main/ipc/videogenIpc.ts");
const composerComponents = read("src/renderer/src/components/session/ComposerComponents.tsx");
const controller = read("src/renderer/src/hooks/useSessionComposerController.ts");
const finalAnswer = read("src/renderer/src/components/session/turn/FinalAnswer.tsx");
const timeline = read("src/renderer/src/hooks/useSessionTimelineController.ts");
const html = read("src/renderer/index.html");
const zh = read("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
const en = read("src/renderer/src/i18n/rendererCopy.en-US.ts");
const tw = read("src/renderer/src/i18n/rendererCopy.zh-TW.ts");
const hiddenModules = read("src/shared/hiddenModules.ts");
const tabLayout = read("src/renderer/src/components/app/settings/settingsTabLayout.ts");

test("IPC 通道三处同步：submit / cancel / get-config / save-config / list-jobs / on-event", () => {
	for (const [channelConst, channelName] of [
		["videogenSubmit", "videogen:submit"],
		["videogenCancel", "videogen:cancel"],
		["videogenGetConfig", "videogen:get-config"],
		["videogenSaveConfig", "videogen:save-config"],
		["videogenListJobs", "videogen:list-jobs"],
		["videogenEvent", "videogen:event"],
	]) {
		assert.match(ipc, new RegExp(`${channelConst}:\\s*"${channelName}"`), `${channelConst} 常量缺失`);
		// event 是推送通道：主进程在装配处 webContents.send，不在 handler 文件里
		if (channelConst === "videogenEvent") {
			assert.match(mainIndex, new RegExp(`ipcChannels\\.${channelConst}`), `主进程未推送 ${channelConst}`);
		} else {
			assert.match(videogenIpc, new RegExp(`ipcChannels\\.${channelConst}`), `videogenIpc 未注册 ${channelConst}`);
		}
		assert.match(preload, new RegExp(`ipcChannels\\.${channelConst}`), `preload 未暴露 ${channelConst}`);
	}
	// 渲染层调用面（preload 形状）
	assert.match(preload, /submit:\s*\(request:\s*VideoGenRequest\)/);
	assert.match(preload, /videogen:\s*\{/);
});

test("装配：主进程注册协议 + 装配链完整（jobs/protocol/ipc 都在 index.ts 挂载）", () => {
	const protocolFile = read("src/main/videogen/VideoGenProtocol.ts");
	assert.match(mainIndex, /registerVideoGenProtocol\(/);
	assert.match(protocolFile, /protocol\.handle\(VIDEO_BLOB_PROTOCOL/);
	assert.match(protocolFile, /from ["'].*shared\/videoContentSrc["']/);
	assert.match(mainIndex, /registerVideoGenIpc\(/);
	assert.match(mainIndex, /new VideoJobRunner\(/);
	assert.match(mainIndex, /new VideoBlobStore\(/);
});

test("CSP：media-src 与 connect-src 都放行 pideck-video:", () => {
	assert.match(html, /media-src[^;]*pideck-video:/);
	assert.match(html, /connect-src[^;]*pideck-video:/);
});

test("渲染层接线：模式标签 / 发送门禁 / 确认闸 / 视频卡片 / 空会话判定", () => {
	assert.match(composerComponents, /videogen:\s*"app\.composerModeVideogen"/);
	assert.match(controller, /submitVideo,/);
	assert.match(controller, /videoConfirmPending,/);
	assert.match(controller, /confirmVideoGen,/);
	assert.match(finalAnswer, /videoContentSrc\(/);
	assert.match(finalAnswer, /message\.videos/);
	// 独立后端会话不算空会话（防重启后被判成引导页）
	assert.match(timeline, /backend\s*===\s*"videogen"/);
});

test("模块可见性：hiddenModules 白名单 + 设置页 tab 布局 + 隐藏 atom", () => {
	assert.match(String(hiddenModules), /"videogen"/);
	assert.match(tabLayout, /id:\s*"videogen"/);
	const atoms = read("src/renderer/src/atoms/app-ui-atoms.ts");
	assert.match(atoms, /videoGenModuleHiddenAtom/);
});

test("i18n 三语对齐：核心键在三个 locale 都存在", () => {
	for (const [source, locale] of [
		[zh, "zh-CN"],
		[en, "en-US"],
		[tw, "zh-TW"],
	]) {
		for (const key of [
			"app.composerModeVideogen",
			"sessionBackend.videogen",
			"settings.tabs.videogen",
			"settings.modules.videogenDesc",
			"videogen.confirm.title",
			"videogen.confirm.body",
			"videogen.status.generating",
			"videogen.error.notConfigured",
			"config.videogen.section",
			"config.videogen.protocol",
			"config.videogen.costConfirm",
			"config.videogen.saveFailed",
		]) {
			assert.match(source, new RegExp(`"${key.replace(/\./g, "\\.")}":`), `${locale} 缺 ${key}`);
		}
	}
});

test("设置页渲染面：VideoGenSettingsTab 挂载在 SettingsModal", () => {
	const settingsModal = read("src/renderer/src/components/app/SettingsModal.tsx");
	assert.match(settingsModal, /VideoGenSettingsTab/);
	assert.match(settingsModal, /videogen/);
});
