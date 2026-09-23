/**
 * Node 测试用的模块解析钩子。
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * pi 扩展由 **jiti** 加载，仓库约定相对 import **不带扩展名**
 * （`pi-deck-todo.ts:65` → `from "./pi-deck-todo-state"`）。
 * 桥沿用同一约定（与既有扩展一致，也是 pi 能解析的形态）。
 *
 * 但 Node 原生 ESM 要求相对说明符**必须带扩展名**，否则 ERR_MODULE_NOT_FOUND。
 * 于是测试要跑桥的源文件，就得补一层「无扩展名 → 试 .ts / .tsx / .js」的解析。
 *
 * ── 为什么不在生产代码里改成带扩展名 ──────────────────────────
 * 那会让桥与仓库既有 13 个扩展的写法不一致，且 jiti 侧并非必需。
 * 解析差异属于**测试环境**的问题，应当在测试侧解决（同
 * `tests/helpers/loadTsCommonJs.mjs` 存在的理由）。
 *
 * 用法（node --test 会自动读取同目录？不会 —— 需显式 --import）：
 *   node --import ./tests/helpers/registerTsResolve.mjs --test tests/guiBridge.test.mjs
 * 或由测试文件顶部 `import "./helpers/tsResolveHook.mjs"` 自行注册。
 */

import { register } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 候选扩展名：按优先级尝试。 */
const EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/**
 * 解析钩子：把无扩展名的相对/绝对说明符补成真实文件路径。
 *
 * 只处理**相对/绝对路径**（`./`、`../`、`/`、`file:`）；
 * 裸包名（如 `node:fs`、`@earendil-works/...`）原样交给默认解析。
 */
export function resolve(specifier, context, nextResolve) {
	const needsExtension = (specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("/")) && !/\.[cm]?[jt]sx?$/i.test(specifier);
	if (needsExtension) {
		const base = context.parentURL ? new URL(specifier, context.parentURL) : null;
		if (base) {
			const basePath = fileURLToPath(base);
			for (const ext of EXTENSIONS) {
				const candidate = `${basePath}${ext}`;
				if (existsSync(candidate)) {
					return nextResolve(`${specifier}${ext}`, context);
				}
			}
			// 目录 index 兜底
			for (const ext of EXTENSIONS) {
				const candidate = `${basePath}/index${ext}`;
				if (existsSync(candidate)) {
					return nextResolve(`${specifier}/index${ext}`, context);
				}
			}
		}
	}
	return nextResolve(specifier, context);
}

/** 注册钩子（幂等：重复 import 只注册一次）。 */
let registered = false;
export function registerTsResolveHook() {
	if (registered) return;
	registered = true;
	register(import.meta.url, import.meta.url);
}

registerTsResolveHook();
