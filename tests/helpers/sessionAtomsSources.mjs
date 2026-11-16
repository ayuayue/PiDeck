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
];

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
 */
export function sessionAtomsLoaderImports({ compileModule, imports }) {
	const pathBySpecifier = new Map(domainPaths.map((path) => [`./${path.slice(path.lastIndexOf("/") + 1, -".ts".length)}`, path]));
	const loaded = new Map();
	const bridge = new Proxy(imports, {
		get(target, specifier) {
			if (typeof specifier !== "string") return Reflect.get(target, specifier);
			const known = Reflect.get(target, specifier);
			if (known !== undefined) return known;
			const path = pathBySpecifier.get(specifier);
			if (!path) return undefined;
			if (!loaded.has(path)) loaded.set(path, compileModule(path, bridge));
			return loaded.get(path);
		},
		has(target, specifier) {
			return Reflect.has(target, specifier) || (typeof specifier === "string" && pathBySpecifier.has(specifier));
		},
	});
	return bridge;
}
