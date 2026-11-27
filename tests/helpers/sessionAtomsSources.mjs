import { readFileSync } from "node:fs";

/**
 * 会话 atoms 源码聚合：入口 `session-atoms.ts` + 按域拆出的同级 `session-*.ts`。
 * 契约测试扫这里，而不是只扫入口——否则域再拆一次，断言会随搬迁失效。
 *
 * 顺序有意义：入口排第一。`thinkingStreamChannel` / `textStreamChannel` 用
 * `indexOf(分支标记)` + 定长切片断言同一条运行时事件机内部的结构，入口在前时
 * 那些偏移仍落在入口文件内，与拆分前一致。
 */
const entryPath = "src/renderer/src/atoms/session-atoms.ts";

/**
 * 显式文件清单（不扫目录）：新增/删除域文件必须同步这里，避免「以为扫到了、
 * 其实没扫」的静默漏断言。加文件时同时补一行来源注释说明这是什么域。
 */
const domainPaths = [
	"src/renderer/src/atoms/session-atoms-types.ts",
	"src/renderer/src/atoms/session-cache-policy.ts",
	"src/renderer/src/atoms/session-message-cache-atoms.ts",
	"src/renderer/src/atoms/session-history-atoms.ts",
	"src/renderer/src/atoms/session-runtime-ui-atoms.ts",
	"src/renderer/src/atoms/session-state-atoms.ts",
	"src/renderer/src/atoms/session-timeline-atoms.ts",
	// 目录对账：已被目录移除的会话，运行态该不该清（纯判据 + dropSessionRuntimesAtom）。
	"src/renderer/src/atoms/vanished-session-runtimes.ts",
];

/**
 * shared 底座清单：atoms 域允许依赖它（方向正确：两层都依赖共同底座）。
 * 域模块 import 它的写法是相对路径（../../../shared/xxx），与域内 ./xxx 不是同一种键，
 * 所以下面按「文件名」建键，两种写法都能命中。
 */
// 空：曾经有过 src/shared/sessionLimits.ts，已删（常量回到 atoms 本文件，hook 走 ports 注入）。
// 留着这个数组是为了让 shared 清单有一个地方可写，不要重建那个文件。
const sharedPaths = [];

export const sessionAtomsSourceFiles = [entryPath, ...domainPaths];

export const sessionAtomsSources = sessionAtomsSourceFiles.map((path) => ({ path, source: readFileSync(path, "utf8") }));

/** 拼成一份源码文本：`// path` 头保留来源，`[\s\S]*?` 形态的跨行断言仍可用。 */
export const sessionAtomsSource = sessionAtomsSources.map(({ path, source }) => `// ${path}\n${source}`).join("\n");

/**
 * 手写 vm 加载器（sessionAtoms / sessionCatalogSelectors / sessionRuntimeUi）的模块图桥。
 *
 * 这三处 loader 用「specifier → 已编译模块」的手写映射，未列出的相对 import 会回落到
 * `nodeRequire`（以 tests/ 为基准）→ 域文件一搬就整片 MODULE_NOT_FOUND。手工逐条补映射
 * 只是追着修，所以这里按上面的显式清单惰性编译域模块，其余 specifier 原样透传给调用方
 * 的映射（桩）或它的 nodeRequire 兜底。
 *
 * @param {object} options
 * @param {(path: string, imports: object) => any} options.compileModule 调用方的编译函数
 * @param {object} options.imports 调用方原有的手写映射（桩）
 * @param {string} [options.entrySpecifier] 入口模块自身的 specifier：域模块反向 import 入口时
 *   拿到的是可后填的桥对象（`loadSessionAtoms` 编译完回填），CJS 产物只在调用时取值，够用。
 */
export function sessionAtomsLoaderImports({ compileModule, imports, entrySpecifier = "./session-atoms" }) {
	// 按文件名建键：域内写 ./xxx、跨层写 ../../../shared/xxx，两种都落到同一张表。
	const baseNameOf = (path) => path.slice(path.lastIndexOf("/") + 1).replace(/\.ts$/, "");
	const pathBySpecifier = new Map([...domainPaths, ...sharedPaths].map((path) => ["./" + baseNameOf(path), path]));
	const loaded = new Map();
	// 入口模块exports：域模块（如 vanished-session-runtimes）会反查它的 atom。
	const entryExports = {};
	const bridge = new Proxy(imports, {
		get(target, specifier) {
			if (typeof specifier !== "string") return Reflect.get(target, specifier);
			const known = Reflect.get(target, specifier);
			if (known !== undefined) return known;
			if (specifier === entrySpecifier) return entryExports;
			// specifier 可能是 ./xxx 或 ../../../shared/xxx：都按最后一段查。
			const path = pathBySpecifier.get("./" + specifier.slice(specifier.lastIndexOf("/") + 1));
			if (!path) return undefined;
			if (!loaded.has(path)) loaded.set(path, compileModule(path, bridge));
			return loaded.get(path);
		},
		has(target, specifier) {
			return Reflect.has(target, specifier) || (typeof specifier === "string" && (specifier === entrySpecifier || pathBySpecifier.has(specifier)));
		},
	});
	return { bridge, bindEntry: (entry) => Object.assign(entryExports, entry) };
}

/**
 * 编译 session-atoms 入口并在编译结束后回填循环依赖：入口 → 域模块（惰性编译）→ 反向 import 入口。
 * 三处 loader 都走这里，新增域文件时只改上面的显式清单。
 *
 * @param {object} options 同 `sessionAtomsLoaderImports`，另加 `entry`（入口路径）。
 */
export function loadSessionAtoms({ compileModule, imports, entry = "src/renderer/src/atoms/session-atoms.ts" }) {
	const { bridge, bindEntry } = sessionAtomsLoaderImports({ compileModule, imports });
	const exports = compileModule(entry, bridge);
	bindEntry(exports);
	return exports;
}
