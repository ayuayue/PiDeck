/**
 * E2E 实例是否注册全局 deep link 协议关联（pideck:// / pideck-dev://）。
 *
 * 背景（#513）：Windows 注册表里协议关联按 scheme 为全局唯一键。Playwright 驱动的
 * E2E 用例跑的是**打包**实例，`app.isPackaged` 为真，于是每次跑用例都会把系统里
 * 真实安装版的 pideck:// 关联改写成临时 userData 的 E2E 实例——用户点通知/深链时
 * 被唤起的是测试进程（甚至指向已删除的目录）。E2E 默认不得产生这种全局副作用。
 *
 * 需要验证深链的用例通过 `PIDECK_E2E_REGISTER_PROTOCOL=1` 显式 opt-in，
 * 与 `PIDECK_E2E_WINDOW_MODE=visible` 的回退风格一致（见 e2eWindowMode.ts）。
 */

/** 是否注册协议关联：仅打包态注册；E2E 实例默认跳过，显式 opt-in 才注册。 */
export function shouldRegisterDeepLinkProtocol(input: { isPackaged: boolean; isE2E: boolean; optIn: boolean }): boolean {
	return input.isPackaged && (!input.isE2E || input.optIn);
}
