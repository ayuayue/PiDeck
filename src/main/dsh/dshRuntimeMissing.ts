/**
 * 「DSH 运行时未安装」错误与渲染层契约。
 *
 * 与 dshManualStop.ts 同构：错误构造、判定、转 SessionMessagePage 收敛在本模块，
 * 避免策略层（DshHost）与进程层（DshHostProcess）各自拼一份判定。
 */
import type { SessionMessagePage } from "../../shared/types";
import { DSH_RUNTIME_MISSING_ERROR, isDshRuntimeMissingMessage } from "../../shared/dshRuntimeMissing";

/**
 * 构造「运行时未安装」错误。
 *
 * 为什么不能直接把 MODULE_NOT_FOUND 抛出去：它会沿 ensureClient → IPC 变成
 * `Error invoking remote method ...`，渲染层既无法区分「用户没装 runtime」与
 * 「代码缺陷」，也拿不到恢复入口（去设置里装 runtime）。
 */
export function dshRuntimeMissingError(runtimeRoot: string, cause: unknown): Error {
	const detail = cause instanceof Error ? cause.message : String(cause);
	return new Error(`${DSH_RUNTIME_MISSING_ERROR}: cannot resolve @deepseek-ai/dsh-base from ${runtimeRoot}. Install the DSH runtime in Settings → DSH, or reinstall PiDeck with the bundled runtime. Cause: ${detail}`);
}

/** 判定错误是否为「运行时未安装」。 */
export function isDshRuntimeMissingError(error: unknown): boolean {
	return error instanceof Error && isDshRuntimeMissingMessage(error.message);
}

/**
 * 把「运行时未安装」转成渲染层的不可用页；其他错误返回 null（调用方继续按普通失败处理）。
 *
 * 复用 SessionMessagePage.unavailable 契约而不是新造返回形状：渲染层已经有「历史暂不可读」
 * 的专态分支，多一种 reason 只是多一条文案。
 */
export function dshRuntimeMissingPageFor(error: unknown): SessionMessagePage | null {
	if (!isDshRuntimeMissingError(error)) return null;
	return { messages: [], total: 0, nextBefore: null, unavailable: "dsh-runtime-missing" };
}
