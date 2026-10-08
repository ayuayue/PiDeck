/**
 * fs 原子写共享工具：rename 瞬态锁重试。
 *
 * Windows 上文件被其他进程（杀软实时监控/勒索防护、云同步、索引服务）持有句柄时，
 * rename 会抛 EPERM/EBUSY，且通常是瞬时锁（几十毫秒级）。本模块提供统一的
 * 退避重试，供各 store 的「写 tmp → rename 原子替换」使用，避免把瞬态锁误判为致命错误。
 *
 * 与 src/main/pi/SessionFileEditor.ts 的实例方法 renameWithRetry 并存：
 * 后者还带「提交前校验目标内容 + 备份」语义（this.fs 注入），不适用此处的模块级场景。
 */

import { rename } from "node:fs/promises";

/** 重试延迟序列（ms）：首次立即重试，随后 20/75/200ms 退避，总窗口约 300ms。 */
export const RENAME_RETRY_DELAYS = [0, 20, 75, 200];

/** 判断错误是否为 rename 的瞬态锁冲突（EPERM/EBUSY），可安全重试。 */
export function isTransientRenameError(error: unknown): boolean {
	const code = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : undefined;
	return code === "EPERM" || code === "EBUSY";
}

/**
 * 对 rename 的瞬态锁冲突做退避重试；重试耗尽后抛出最后一次错误。
 * 非 EPERM/EBUSY 错误（如 ENOENT 源缺失）立即抛出，不做无谓重试。
 * beforeAttempt 在每次尝试（含首次与每次退避之后）前执行：调用方用它复查
 * 授权等前置条件——Windows 文件锁的退避窗口内插件可能已被禁用/页面被卸载，
 * 此时必须中止提交而不是继续覆盖目标文件（宿主插件 storage 修复，2026-10）。
 */
export async function renameWithRetry(from: string, to: string, beforeAttempt?: () => void | Promise<void>): Promise<void> {
	let lastError: unknown;
	for (const delay of RENAME_RETRY_DELAYS) {
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		await beforeAttempt?.();
		try {
			await rename(from, to);
			return;
		} catch (error) {
			lastError = error;
			if (!isTransientRenameError(error)) throw error;
		}
	}
	throw lastError;
}
