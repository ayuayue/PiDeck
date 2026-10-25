import initSqlJs from "sql.js";
import type { SqlJsStatic } from "sql.js";

/**
 * 进程级共享的 sql.js WASM 单例。
 *
 * 多个领域（提示词库 xueprompts.db、Kimi Work conversations.sqlite）都要只读
 * SQLite。sql.js 每次初始化都会加载并编译一份 WASM（~1MB 二进制 + 编译产物），
 * 各域各持一份纯属浪费；这里收口为「locateFile 策略由调用方注入、实例全局共享」。
 *
 * locateFile 必须由调用方传：打包后 WASM 在 app.asar.unpacked 下，dev 在
 * node_modules 下（见 XuePromptManager.initSql 的注释；该模块尚未接入本单例，
 * 下轮触达 prompts 域时并轨）。首次调用的 locateFile 生效，后续调用忽略。
 */
let sharedSqlPromise: Promise<SqlJsStatic> | null = null;

export function getSharedSqlJs(locateFile: (file: string) => string): Promise<SqlJsStatic> {
	if (!sharedSqlPromise) {
		sharedSqlPromise = initSqlJs({ locateFile });
	}
	return sharedSqlPromise;
}

/** 仅供测试：重置单例（生产代码不得调用）。 */
export function resetSharedSqlJsForTests(): void {
	sharedSqlPromise = null;
}
