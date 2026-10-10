import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import vm from "node:vm";
import ts from "typescript";

const nodeRequire = createRequire(import.meta.url);

function resolveLocalModule(fromFile, specifier) {
	const base = resolve(dirname(fromFile), specifier);
	// Locale-qualified modules such as rendererCopy.en-US still need TypeScript
	// extension resolution; only actual JS/TS suffixes are terminal paths.
	const candidates = /\.(?:[cm]?[jt]sx?)$/i.test(base) ? [base] : [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, resolve(base, "index.ts"), resolve(base, "index.tsx"), resolve(base, "index.js")];
	const match = candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
	if (!match) {
		throw new Error(`Cannot resolve local test module ${specifier} from ${fromFile}`);
	}
	return match;
}

/**
 * Load the production TypeScript dependency graph in a CommonJS VM for Node tests.
 * This keeps tests independent from bundler-only extension resolution without asking
 * production imports to change solely for the test runner.
 */
export function loadTsCommonJs(filePath, options = {}) {
	const cache = new Map();
	const stubs = options.stubs ?? {};

	function load(resolvedPath) {
		const absolutePath = resolve(resolvedPath);
		if (cache.has(absolutePath)) return cache.get(absolutePath).exports;

		const output = ts.transpileModule(readFileSync(absolutePath, "utf8"), {
			compilerOptions: {
				module: ts.ModuleKind.CommonJS,
				target: ts.ScriptTarget.ES2022,
				esModuleInterop: true,
				jsx: ts.JsxEmit.ReactJSX,
			},
			fileName: absolutePath,
		}).outputText;
		const module = { exports: {} };
		cache.set(absolutePath, module);

		const localRequire = (specifier) => {
			if (Object.hasOwn(stubs, specifier)) return stubs[specifier];
			if (specifier.startsWith(".") || specifier.startsWith("/")) {
				return load(resolveLocalModule(absolutePath, specifier));
			}
			// 项目根相对导入（"src/shared/..."，bundler root 语义）：node 解析不到、
			// 也不是包名。npm test 以项目根为 cwd，先按项目根解析本地 TS 文件；
			// 解析不到（node_modules 包）再回退 npm require。
			let rootResolved;
			try {
				rootResolved = resolveLocalModule(process.cwd(), specifier);
			} catch {
				rootResolved = null;
			}
			if (rootResolved) return load(rootResolved);
			return nodeRequire(specifier);
		};

		vm.runInNewContext(
			output,
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
				setTimeout,
				clearTimeout,
				setInterval,
				clearInterval,
				setImmediate,
				clearImmediate,
				queueMicrotask,
				crypto: globalThis.crypto,
				// 构建期 define（electron.vite.config.ts）在沙箱里同样是编译期常量：
				// 不给默认值，任何 import 到 deepLinkScheme / channelIdentity 的生产模块
				// 都会在求值时整片 ReferenceError。默认 stable 通道；测 dev 通道的用例
				// 经 options.globals 覆盖（见 tests/channelIdentity.test.mjs）。
				__PIDECK_DEV_BUILD__: false,
				// vm 是独立的 realm：不给宿主 Error，模块抛的 Error 在测试里 instanceof 失败、
				// assert.rejects(promise, ErrorClass) 一律失配（hostPluginScaffold 踩过）。
				Error,
				TypeError,
				RangeError,
				SyntaxError,
				...options.globals,
			},
			{ filename: absolutePath },
		);
		return module.exports;
	}

	return load(filePath);
}
