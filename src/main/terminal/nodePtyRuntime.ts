import { createRequire } from "node:module";

/**
 * node-pty 运行时的唯一加载入口。
 *
 * 为什么不能静态 `import * as pty from "node-pty"`：node-pty 是原生模块，加载时会
 * dlopen `build/Release/pty.node`（macOS/Windows 走 prebuilds），失败即同步抛错。
 * 此前 TerminalSessionManager 顶层静态 import，把「原生模块不可用」放大成主进程
 * 模块求值期的未捕获异常——整个应用启动即崩，终端以外的功能也一起没了
 *（2026-10 统信 UOS aarch64 反馈：包里 pty.node 在位，但该发行版 glibc < 2.34，
 * 而 pty.node 需要 openpty/forkpty@GLIBC_2.34，dlopen 失败）。收敛到函数内
 * createRequire 后，终端退化为「打不开 + 一条带原因的提示」，其余功能不受影响。
 * 与 src/main/cua/koffiRuntime.ts 同一约束（AGENTS.md「原生模块禁止顶层静态 import」）。
 *
 * 独立成文件还有测试原因：`createRequire(__filename)` 不走 loadTsCommonJs 的
 * localRequire，只有经过本地模块边界，测试才能用 stubs 模拟「原生模块缺失」的
 * 打包环境（见 tests/terminalNodePtyFallback.test.mjs）。
 */

/** node-pty 模块类型（纯类型查询，编译后彻底擦除，不产生运行时 import）。 */
export type NodePtyModule = typeof import("node-pty");

/** node-pty 不可用的统一错误：detail 是底层 dlopen/解析失败原因，便于用户与日志定位。 */
export class NodePtyUnavailableError extends Error {
	readonly detail: string;

	constructor(detail: string) {
		super(`node-pty native module failed to load: ${detail}`);
		this.name = "NodePtyUnavailableError";
		this.detail = detail;
	}
}

let cachedModule: NodePtyModule | null = null;
let cachedFailure: NodePtyUnavailableError | null = null;

/**
 * 惰性加载 node-pty；失败时抛 NodePtyUnavailableError。
 *
 * 失败结果会被缓存：原生模块在一个进程生命周期内不会「恢复」，缓存既避免每次开
 * 终端都重跑 loader，也保证同一段底层原因只被包装/记录一次。
 */
export function loadNodePty(): NodePtyModule {
	if (cachedModule) return cachedModule;
	if (cachedFailure) throw cachedFailure;
	try {
		cachedModule = createRequire(__filename)("node-pty") as NodePtyModule;
		return cachedModule;
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		cachedFailure = new NodePtyUnavailableError(detail);
		throw cachedFailure;
	}
}
