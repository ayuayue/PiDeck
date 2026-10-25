/** DSH profile loader 表达式的运行时包解析改写（dump 前的一个纯函数步骤）。 */
import { isRecord } from "./dshProfileSettings";

/**
 * 官方 0.2.0-rc.2 起 cordis 预设的 `skill-filesystem.customSkillDirs` 用
 * `createRequire(baseUrl).resolve('<pkg>/package.json')` 定位 skills 目录。官方
 * dsh CLI 的 profile 是 pnpm workspace，包就装在 profile 自己的 node_modules，
 * 从 baseUrl 向上解析必中；PiDeck 的 runtime 包在外置安装目录
 * （userData/runtimes/dsh/<ver>/node_modules），与 `$DSH_HOME/.pideck/profile`
 * 不在同一条 Node 查找链上——原样 dump 的表达式在每个会话展开 cordis 预设时必抛
 * "Cannot find module"（resume/create 失败，2026-11 用户报障，本机已复现）。
 *
 * 修复：把表达式中该形状的 resolve 片段替换为 host 侧 runtimeRequire 预解析的
 * 绝对路径字面量。bundle 每次 host 启动重新生成，runtime 升级后路径自动刷新；
 * 解析失败保留原表达式（fail-safe，与 agent-team 缺包跳过同策略），但留日志
 * 线索——剩余的 createRequire 表达式在当前布局下同样会失败。
 */

/** 官方 loader 表达式定位包的完整片段：`process.getBuiltinModule('node:module').createRequire(baseUrl).resolve('<specifier>')`（前导方法链可省略）。只替换 createRequire(baseUrl).resolve(...) 会残留悬空的 `.'path'` 语法错误，必须连同前导链一起换成路径字面量。 */
const CREATE_REQUIRE_RESOLVE_PATTERN = /(?:process\.getBuiltinModule\('node:module'\)\.)?createRequire\(\s*baseUrl\s*\)\.resolve\(\s*'([^']+)'\s*\)/g;

/** 由调用方提供：从 runtime 安装范围解析 npm 说明符；失败返回 undefined。 */
export type RuntimePackageResolver = (specifier: string) => string | undefined;

/**
 * 递归改写 patch 树中所有 `!!js` 表达式节点，返回与输入结构完全同构的新树
 * （不修改输入——overlay 解析结果可能被 appBoot 内部缓存引用）。普通对象、
 * 数组、`{ __jsExpr }` 节点之外的值原样返回。
 */
export function rewriteLoaderExprPackageResolves<T>(node: T, resolveFromRuntime: RuntimePackageResolver): T {
	if (Array.isArray(node)) {
		return node.map((item) => rewriteLoaderExprPackageResolves(item, resolveFromRuntime)) as unknown as T;
	}
	if (!isRecord(node)) return node;
	if (typeof node.__jsExpr === "string") {
		return { __jsExpr: rewriteExprText(node.__jsExpr, resolveFromRuntime) } as unknown as T;
	}
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) result[key] = rewriteLoaderExprPackageResolves(value, resolveFromRuntime);
	// 结构恒等（仅替换 __jsExpr 字符串），断言只反映这一同构关系。
	return result as unknown as T;
}

function rewriteExprText(text: string, resolveFromRuntime: RuntimePackageResolver): string {
	let rewritten = false;
	const next = text.replace(CREATE_REQUIRE_RESOLVE_PATTERN, (fragment, specifier: string) => {
		const resolved = resolveFromRuntime(specifier);
		if (resolved === undefined) return fragment;
		rewritten = true;
		// JSON 字符串字面量在 loader 的 eval 求值里等价（含 Windows 路径转义）。
		return JSON.stringify(resolved);
	});
	if (!rewritten && text.includes("createRequire(")) {
		console.error(`[dsh-host-profile] loader expression kept unresolved (runtime resolve failed or unsupported shape): ${text}`);
	}
	return next;
}
