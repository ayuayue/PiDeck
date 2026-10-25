/**
 * Linux 托盘注册验收 —— 纯诊断（不动作）。
 *
 * 背景（详见 docs/linux-tray-icon.md）：GNOME 的 appindicator 扩展 < v66 初始化时逐个
 * `Get` SNI 属性，而 Chromium/Electron 对这类请求一律返回 `Failed`，扩展随即 `destroy()`
 * 该图标且**不再重试** —— 托盘图标永久缺席。v66 改用 `GetAll` 读法后握手正常。
 *
 * 重建 Tray（换 SNI 名字）实测无效：扩展用同样的读法重来，结果不变。
 * 因此本模块只做一件事：Tray 创建后延迟查一次 watcher 的 `RegisteredStatusNotifierItems`，
 * 把「注册成功 / 未注册 / 环境不可判」写进日志，给用户排障与上游诊断留凭据。
 */

import { execFile } from "node:child_process";

/** 查询结果：ok=false 表示环境不可判（无 dbus-send / 无 watcher / 命令失败）。 */
export type TrayItemsQuery = { ok: true; items: readonly string[] } | { ok: false };

/**
 * 从 dbus-send --print-reply 的输出里抽出所有字符串字面量。
 * 输出形如：
 *   method return ... variant  array [
 *         string ":1.66@/org/ayatana/NotificationItem/xxx"
 *         string "org.freedesktop.StatusNotifierItem-13440-1"
 *       ]
 */
export function parseRegisteredTrayItems(stdout: string): string[] {
	const items: string[] = [];
	for (const match of stdout.matchAll(/string "((?:[^"\\]|\\.)*)"/g)) {
		items.push(match[1]);
	}
	return items;
}

/** 本进程的 SNI 名字形如 `org.freedesktop.StatusNotifierItem-<pid>-<n>`（n 随重建递增，不能写死）。
 * 用 includes 而非 startsWith：名字带接口前缀；needle 以 `-` 结尾，天然排除 pid 前缀误匹配（如 1344 不会命中 13440）。 */
export function pidHasTrayItem(items: readonly string[], pid: number): boolean {
	const needle = `StatusNotifierItem-${pid}-`;
	return items.some((item) => item.includes(needle));
}

/** 默认查询实现：dbus-send 会话总线。watcher 不存在/命令缺失都归入 ok=false。 */
export function queryRegisteredTrayItemsViaDbusSend(): Promise<TrayItemsQuery> {
	return new Promise((resolve) => {
		execFile("dbus-send", ["--session", "--dest=org.kde.StatusNotifierWatcher", "--print-reply", "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties.Get", "string:org.kde.StatusNotifierWatcher", "string:RegisteredStatusNotifierItems"], { timeout: 3000 }, (error, stdout) => {
			if (error) {
				resolve({ ok: false });
				return;
			}
			resolve({ ok: true, items: parseRegisteredTrayItems(stdout) });
		});
	});
}

export type TrayRegistrationVerifyOptions = {
	/** 查到「未注册」时回调（诊断出口；本模块不做任何修复动作）。 */
	onUnregistered?: (detail: { pid: number; items: number }) => void;
	/** 结论日志（成功 / 环境不可判）。 */
	onLog?: (message: string, detail: Record<string, unknown>) => void;
	/** 查询实现；生产用 dbus-send，测试注入假实现。 */
	queryItems?: () => Promise<TrayItemsQuery>;
	/** 取当前主进程 pid（测试注入用）。 */
	getPid?: () => number;
	/** 首查延迟：需覆盖扩展的三轮窗口，默认 6000ms。 */
	firstCheckDelayMs?: number;
	/** 定时器注入（测试用）；生产走真实 setTimeout。 */
	setTimer?: (handler: () => void, timeoutMs: number) => unknown;
	clearTimer?: (handle: unknown) => void;
};

export type TrayRegistrationVerify = {
	/** 停止验收（退出清理 / Tray 被外部接管时调用；重复调用安全）。 */
	stop: () => void;
};

/**
 * 启动注册验收。无论结局如何（成功/放弃/stop），都保证定时器最终被清掉。
 */
export function startTrayRegistrationVerify(options: TrayRegistrationVerifyOptions): TrayRegistrationVerify {
	const firstCheckDelayMs = options.firstCheckDelayMs ?? 6000;
	const queryItems = options.queryItems ?? queryRegisteredTrayItemsViaDbusSend;
	const getPid = options.getPid ?? (() => process.pid);
	const setTimer = options.setTimer ?? ((handler: () => void, timeoutMs: number) => setTimeout(handler, timeoutMs));
	const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

	const pid = getPid();
	let handle: unknown = null;
	let stopped = false;

	const finish = (): void => {
		if (handle !== null) clearTimer(handle);
		handle = null;
	};

	handle = setTimer(() => {
		void queryItems()
			.then((result) => {
				if (stopped) return;
				if (!result.ok) {
					// 无 watcher / 无查询手段：本机本来就没有托盘概念，无需诊断。
					options.onLog?.("tray verify: watcher unavailable, skipping diagnosis", { pid });
					finish();
					return;
				}
				if (pidHasTrayItem(result.items, pid)) {
					options.onLog?.("tray verify: registered", { pid, items: result.items.length });
					finish();
					return;
				}
				options.onUnregistered?.({ pid, items: result.items.length });
				finish();
			})
			.catch(() => {
				if (!stopped) {
					options.onLog?.("tray verify: unexpected query error", { pid });
					finish();
				}
			});
	}, firstCheckDelayMs);

	return {
		stop: () => {
			stopped = true;
			finish();
		},
	};
}
