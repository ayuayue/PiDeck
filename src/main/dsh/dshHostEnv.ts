import { homedir } from "node:os";
import { join } from "node:path";

/**
 * DSH_HOME 目录解析（纯函数，可单测）：
 * 1. 设置里 dshHomeDir 非空 → 以用户覆盖为准（任意自定义目录）；
 * 2. 否则一律用 ~/.dsh（与 dsh CLI 共用同一目录；不存在时由调用方 mkdirSync 自动创建）。
 */
export function resolveDshHomeDir(override: string | undefined, _realUserDataDir: string): string {
	if (override?.trim()) return override.trim();
	return join(homedir(), ".dsh");
}

/** 进程是否存活（B6 锁检测用）：kill(pid, 0) 成功 = 存活；EPERM = 存在但无权限，也算存活。 */
export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** DSH host fork 环境（E5）：继承主进程环境，剔除 Electron/Node 宿主注入类变量。 */
export function buildDshHostForkEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined) continue;
		// ELECTRON_*（如 ELECTRON_RUN_AS_NODE/ELECTRON_NO_ASAR）与 NODE_OPTIONS
		// （可能带 --require preload 注入）不该进 DSH 子进程树。
		if (key.startsWith("ELECTRON_") || key === "NODE_OPTIONS") continue;
		env[key] = value;
	}
	return env;
}
