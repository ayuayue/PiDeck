import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);

/**
 * 手写 vm 沙箱加载生产 TS 模块的**统一入口**（替代各测试里重复的
 * `ts.transpileModule + vm.runInNewContext` 片段）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * 测试用手写沙箱执行生产模块时，未识别的 import 会落到 `require(specifier)`，
 * 而它的解析基准是 **tests/ 目录**而不是被加载的生产文件。于是生产代码只要新增
 * 一个本地依赖，这些测试就整片 `MODULE_NOT_FOUND`，报错还指向测试文件本身
 *（2026-09 连踩三次：cacheHitStats 的 node:fs/promises、sessionFileSizeCopy、
 * 以及拆分纯函数模块那次）。每个测试各自补一层 `tryRequireLocalTs` 只是在
 * 追着修——根因是「解析基准错了」，应该由加载器统一按源文件目录解析。
 *
 * ── 与 loadTsCommonJs 的分工 ─────────────────────────────────
 * - `loadTsCommonJs`：需要**完整依赖图**（让 Node 沿真实目录解析嵌套 import）。
 *   适合加载整个模块（如 SessionScanner），stub 通过 options.stubs 注入。
 * - 本模块（`createTsSandbox`）：仍想**自己控制 sandbox 全局**（自定义 process、
 *   注入 Buffer/计时器、观察 globals）但不想再手写 require 桥。它只解决
 *   「相对 import 解析基准」这一个问题，其余全局照旧由调用方给。
 *
 * 两者都不要求生产代码为测试改动，因此新增本地 import 不再连锁破坏测试。
 */

/** 解析本地模块候选路径（带 .ts/.tsx/.js 与 index 兜底）。 */
function resolveLocalFrom(fromFile, specifier) {
	const base = resolve(dirname(fromFile), specifier);
	const candidates = /\.(?:[cm]?[jt]sx?)$/i.test(base) ? [base] : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, resolve(base, "index.ts"), resolve(base, "index.tsx"), resolve(base, "index.js")];
	return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

/**
 * @typedef {object} TsSandboxOptions
 * @property {Record<string, unknown>} [stubs]
 *   按 specifier 覆盖依赖（electron / fs 替身 / 纯函数桁）。
 *   命中即用，不再走文件系统解析——与 loadTsCommonJs 的 stubs 同语义。
 * @property {Record<string, unknown>} [globals]
 *   追加/覆盖 sandbox 全局（process、Buffer、计时器、自定义函数…）。
 * @property {Record<string, unknown>} [compilerOptions]
 *   覆盖默认的 ts.transpileModule 编译选项（少数测试要 JSX / 其他 target）。
 */

/**
 * 创建加载器：`load("src/main/xxx.ts")` 返回该模块的 exports。
 *
 * 同一个加载器实例内带模块缓存，因此互相依赖的模块只求值一次
 *（与 CommonJS 语义一致；测试里注入的桁也在同一实例内共享）。
 *
 * @param {TsSandboxOptions} [options]
 * @returns {(filePath: string) => any}
 */
export function createTsSandbox(options = {}) {
	const cache = new Map();
	const stubs = options.stubs ?? {};
	const globals = options.globals ?? {};
	const compilerOptions = {
		module: ts.ModuleKind.CommonJS,
		target: ts.ScriptTarget.ES2022,
		esModuleInterop: true,
		jsx: ts.JsxEmit.ReactJSX,
		...options.compilerOptions,
	};

	function load(filePath) {
		const absolutePath = resolve(filePath);
		if (cache.has(absolutePath)) return cache.get(absolutePath).exports;

		const { outputText } = ts.transpileModule(readFileSync(absolutePath, "utf8"), {
			compilerOptions,
			fileName: absolutePath,
		});
		const module = { exports: {} };
		// 先入缓存再求值：循环依赖下拿到的是同一份（未完成）exports，与 Node 行为一致
		cache.set(absolutePath, module);

		const localRequire = (specifier) => {
			if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
			if (specifier.startsWith(".") || specifier.startsWith("/")) {
				// 关键：以**被加载文件所在目录**为基准（这是手写沙箱最容易写错的地方）
				const resolved = resolveLocalFrom(absolutePath, specifier);
				if (resolved) return load(resolved);
				throw new Error(`Cannot resolve local module ${specifier} from ${absolutePath}`);
			}
			// 项目根相对导入（"src/shared/..."，bundler root 语义）：node 解析不到也不是包名
			const rootResolved = resolveLocalFrom(process.cwd(), specifier);
			if (rootResolved) return load(rootResolved);
			return nodeRequire(specifier);
		};

		vm.runInNewContext(
			outputText,
			{
				module,
				exports: module.exports,
				require: localRequire,
				__filename: absolutePath,
				__dirname: dirname(absolutePath),
				console,
				process,
				Buffer,
				URL,
				URLSearchParams,
				TextDecoder,
				TextEncoder,
				AbortController,
				AbortSignal,
				setTimeout,
				clearTimeout,
				setInterval,
				clearInterval,
				setImmediate,
				clearImmediate,
				queueMicrotask,
				crypto: globalThis.crypto,
				// 构建期 define 的沙箱默认值（与 loadTsCommonJs 同源）：不预置它，
				// 生产模块只要 import 到 deepLinkScheme / channelIdentity 就整片
				// ReferenceError。默认 stable 通道，dev 通道用例经 globals 覆盖。
				__PIDECK_DEV_BUILD__: false,
				...globals,
			},
			{ filename: absolutePath },
		);
		return module.exports;
	}

	return load;
}
