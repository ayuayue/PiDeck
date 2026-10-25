import { createRequire } from "node:module";

/**
 * koffi 运行时的唯一加载入口。
 *
 * 为什么不能静态 `import koffi`：koffi 的 JS 包装（index.cjs）在模块求值时
 * 就同步加载原生二进制，找不到时直接抛错（`wrapNative`）。打包产物缺对应
 * 平台/架构的 `@koromix/koffi-*` 可选依赖时（交叉打包的常见缺口，例如 arm64
 * runner 打出的 x64 macOS 包不含 @koromix/koffi-darwin-x64，issue #313），
 * 静态 import 会让应用启动即崩。收敛到函数内 createRequire 后，调用方可以
 * 按平台决定是否加载，并对失败做降级。
 *
 * 独立成文件还有测试原因：`createRequire(__filename)` 不走 loadTsCommonJs
 * 的 localRequire，只有经过本地模块边界，测试才能用 stubs 模拟「原生模块
 * 缺失」的打包环境（见 tests/cua/cuaKoffiFallback.test.mjs）。
 */

/** koffi 默认导出对象的类型（纯类型查询，编译后彻底擦除，不产生运行时 import）。 */
export type Koffi = typeof import("koffi")["default"];

/** 同步加载 koffi；原生模块缺失/加载失败会把底层错误原样抛出，由调用方降级。 */
export function requireKoffi(): Koffi {
	return createRequire(__filename)("koffi") as Koffi;
}
