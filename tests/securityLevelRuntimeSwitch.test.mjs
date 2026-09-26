import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 安全级别运行中切换（issue #146 延伸）。
 *
 * 与思考强度不同，安全级别不是 pi 的生成参数：
 * - 切换 = 写 security-policy.json 策略快照（SecurityStore.writeSnapshot）；
 * - pi-deck-security-gate 扩展在每次工具调用时按 mtime 重读快照（2s throttle，见
 *   resources/extensions/pi-deck-security-gate.ts loadSnapshot），即「即时生效」；
 * - 因此没有「下一轮才生效」的延迟语义，UI 只需放开运行中禁用，无需 pending 指示。
 */
test("契约: 底栏安全控制位经 SecurityControl 统一入口（pi 安全等级 / DSH 权限预设）", () => {
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	// C20：后端分支收敛到 SecurityControl，ComposerArea 不再直接 if/else 两个菜单；
	// SecurityControl 内部按 backend 路由（SecurityLevelMenu 保持「仅启动中禁用」语义）。
	assert.match(area, /<SecurityControl sessionId=\{props\.sessionId\} backend=\{composer\.backend\} disabled=\{composer\.isStarting\} \/>/);
	assert.doesNotMatch(area, /<SecurityLevelMenu/);
	assert.doesNotMatch(area, /<DshPermissionMenu/);
	// 分支切换会动工作区文件，仍走全局 busy 禁用（独立 branchDisabled 通道）；
	// 思考与模型已单独放开运行中
	assert.match(area, /branchDisabled=\{composer\.isBusy \|\| composer\.isStarting\}/);
	assert.match(area, /modelDisabled=\{composer\.isStarting\}/);
});

test("契约: SecurityLevelMenu 自身仍以 props.disabled 为准（不做运行态特判）", () => {
	const menu = readFileSync("src/renderer/src/components/session/SecurityLevelMenu.tsx", "utf8");
	// 按钮禁用 = 外部传入 disabled 或保存中；菜单项在 enabled=false 时禁用
	assert.match(menu, /disabled=\{props\.disabled \|\| saving\}/);
	assert.match(menu, /disabled={!enabled || props.disabled || saving}/);
});

test("契约: 主进程写快照链路无 busy 校验（切换即时生效）", () => {
	const ipc = readFileSync("src/main/ipc/securityIpc.ts", "utf8");
	// handler 只做输入校验，不检查会话运行状态
	assert.doesNotMatch(ipc, /isBusy|isStreaming|runtime/);
	const store = readFileSync("src/main/security/SecurityStore.ts", "utf8");
	assert.match(store, /writeSnapshot/);
	assert.match(store, /security-policy\.json/);
});
