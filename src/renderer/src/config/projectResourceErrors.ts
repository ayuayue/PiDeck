/**
 * 项目作用域资源操作的「未信任」错误识别（纯函数）。
 *
 * 主进程两条链路的未信任文案不同，且 Electron IPC 还会加 `Error invoking remote
 * method …` 前缀——直接把 caught.message 显示给用户既难懂又吓人。识别出这类错误后，
 * 调用方应改用 config.projectUntrusted.notice 的引导文案（先信任项目再回来刷新）。
 */

const PROJECT_UNTRUSTED_PATTERN = /Project is not trusted|请先信任项目/;

export function isProjectUntrustedError(error: unknown): boolean {
	// 不用 `error instanceof Error`：vm 单测里跨 realm 的 Error 原型不同会恒为 false；按鸭子类型取 message。
	let message = "";
	if (typeof error === "string") message = error;
	else if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") message = String((error as { message: unknown }).message);
	return PROJECT_UNTRUSTED_PATTERN.test(message);
}
