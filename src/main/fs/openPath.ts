import { clearTimeout, setTimeout } from "node:timers";
import { getAppLogger } from "../logging/sharedLogger";

/**
 * 系统默认方式打开文件/目录的统一入口（替代各处直接调 shell.openPath）。
 *
 * ── 为什么必须有这一层 ────────────────────────────────────────────────
 * Electron 自 37.5 起 Linux 的 shell.openPath 走 XDGOpen(dirname, path,
 * wait_for_exit = false, callback)，而 XDGUtil() 只在 wait_for_exit 为 true
 * 的分支里执行 callback.Run() —— 回调被丢弃，Promise 永不 settle（是
 * electron#47668「openPath is blocking on Linux」的副作用；v37.0.0 仍为 true，
 * 36.9.x 起回移）。于是所有 await shell.openPath(...) 的 IPC handler 永久挂住，
 * reply channel 被回收时 Electron 补发 "reply was never sent"，渲染层据此弹
 * 「打开失败」——而目录其实已经打开了（issue #396，Ubuntu 24.04 X11/GNOME
 * 100% 复现）。
 *
 * ── 契约 ──────────────────────────────────────────────────────────────
 * 沿用 Electron 原语义：**空串 = 已交给系统，非空 = 系统报错**；且永不 reject
 * （内部把异常转成错误串，调用方保持原来的 if (error) throw 写法）。
 * 超时按「已交给系统」处理并只记 warn——Linux 上拿不到真实结果，
 * 弹错误比静默成功更糟（目录确实被打开了）。挂住的 Promise 不绑定
 * timer/句柄，不会阻止进程退出。
 *
 * electron 懒加载（同 ../fs/trash.ts）：本模块会被纯 Node 测试真实编译执行，
 * 顶层 import "electron" 会 MODULE_NOT_FOUND。
 */

/** openPath 未 settle 的兜底等待上限：正常平台（win/mac）毫秒级返回，3s 足够宽松。 */
export const OPEN_PATH_SETTLE_TIMEOUT_MS = 3000;

let shellRef: typeof import("electron").shell | undefined;

async function getShell(): Promise<typeof import("electron").shell> {
	if (!shellRef) {
		shellRef = (await import("electron")).shell;
	}
	return shellRef;
}

export type OpenSystemPathOptions = {
	/** 仅供测试覆盖默认等待上限；生产调用点不要传。 */
	timeoutMs?: number;
};

/**
 * 用系统默认方式打开路径（Windows ShellExecute / macOS open / Linux xdg-open）。
 * 正常返回空串，失败返回系统给出的错误字符串；Linux 上因 Electron 丢弃回调
 * 而拿不到结果时同样返回空串（已交给系统）。
 */
export async function openSystemPath(targetPath: string, options: OpenSystemPathOptions = {}): Promise<string> {
	const shell = await getShell();
	const timeoutMs = options.timeoutMs ?? OPEN_PATH_SETTLE_TIMEOUT_MS;
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** resolve(null) = 超时，未拿到系统结果 */
	const timedOut = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	// 结果侧先吞掉 rejection：超时后才 reject 会变成 unhandled rejection。
	const opened = shell.openPath(targetPath).then(
		(error) => error,
		(error: unknown) => (error instanceof Error ? error.message : String(error)),
	);
	try {
		const error = await Promise.race([opened, timedOut]);
		if (error === null) {
			void getAppLogger()?.warn("fs:open", "shell.openPath 超时未返回，按已交给系统处理", { path: targetPath, timeoutMs });
			return "";
		}
		return error;
	} finally {
		if (timer) clearTimeout(timer);
	}
}
