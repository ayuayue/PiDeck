import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 静态扫描扩展源码，提取 pi.registerEntryRenderer(customType, …) 注册的 customType 集合。
 *
 * 为什么扫源码而不是问 pi：注册表只活在 pi 进程内，RPC 没有「列出已注册 entry renderer」
 * 的端点。PiDeck 的时间线口径与 pi 对齐（docs/session-format.md）——只有注册了 renderer 的
 * type:"custom" 条目才算 transcript 内容，其余不显示。SessionHistoryReader 拿本模块的结果
 * 做投影闸口（未注册 → 默认隐藏），避免第三方扩展的内部 appendEntry 记账漏成裸 JSON 卡。
 *
 * 提取边界（一律按「未注册」处理，宁可漏显示不错显示）：
 * - 第一参只认字符串字面量或 const/let/var 字符串别名（esbuild dist 用 var，如 billion-context-pi）；
 *   变量运行时求值/模板插值提取不到；
 * - 从入口沿相对导入做有界 BFS（深度 6 / 32 文件上限，visited 防环）收集注册与常量别名；
 *   动态 import、包名导入、非字面量路径不在收集范围。
 */

/** 单个文件体积上限：超过不扫描（极端打包产物兜底，避免读入超大文件）。 */
const MAX_SCAN_BYTES = 2 * 1024 * 1024;

// 别名捕获含 var/let：esbuild 打包产物常用 var 声明常量。
const CONST_STRING_PATTERN = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/g;

// 匹配 registerEntryRenderer(<T>) / registerEntryRenderer.call(pi, 的第一参；
// 泛型参数里不允许出现括号（真实签名是类型名/联合，足够覆盖）。
const RENDERER_CALL_PATTERN = /\bregisterEntryRenderer(?:<[^<>]*>)?(?:\s*\.\s*call\s*\(\s*[\w$.]+\s*,|\s*\()\s*([A-Za-z_$][\w$]*|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)/g;

// 相对路径的命名导入（node:/包名开头的不跟随，追不到本地文件）。
const RELATIVE_NAMED_IMPORT_PATTERN = /\bimport\s*\{([^}]*)\}\s*from\s*["'](\.[^"']*)["']/g;

/** 字符串字面量 → 字符串值。模板串含 ${} 视为动态值返回 undefined。 */
function parseStringLiteral(literal: string): string | undefined {
	if (literal.startsWith('"')) {
		try {
			return JSON.parse(literal) as string;
		} catch {
			return undefined;
		}
	}
	const quote = literal[0];
	const raw = literal.slice(1, -1);
	if (quote === "`" && raw.includes("${")) return undefined;
	// 单引号/反引号串没有标准 JSON 转义，按常见转义做 best-effort 还原。
	return raw.replace(/\\(['"`\\])/g, "$1");
}

/** 单文件扫描结果：renderer 类型、字符串别名（供跨文件解析）、未解析的标识符实参、相对命名导入。 */
type ModuleScan = {
	types: readonly string[];
	aliases: ReadonlyMap<string, string>;
	unresolvedArgs: readonly string[];
	relativeImports: ReadonlyArray<{ names: readonly string[]; specifier: string }>;
};

function scanSource(source: string): ModuleScan {
	const aliases = new Map<string, string>();
	for (const match of source.matchAll(CONST_STRING_PATTERN)) {
		const value = parseStringLiteral(match[2]);
		if (value !== undefined) aliases.set(match[1], value);
	}
	const types = new Set<string>();
	const unresolvedArgs = new Set<string>();
	for (const match of source.matchAll(RENDERER_CALL_PATTERN)) {
		const arg = match[1] ?? "";
		if (/^[`"']/.test(arg)) {
			const resolved = parseStringLiteral(arg);
			if (resolved) types.add(resolved);
		} else if (aliases.has(arg)) {
			types.add(aliases.get(arg)!);
		} else {
			unresolvedArgs.add(arg);
		}
	}
	const relativeImports: Array<{ names: string[]; specifier: string }> = [];
	for (const match of source.matchAll(RELATIVE_NAMED_IMPORT_PATTERN)) {
		const names = (match[1] ?? "")
			.split(",")
			// 「type X」是 TS 类型导入，运行时不存在，剔除
			.map((part) => (part.trimStart().startsWith("type ") ? part.trimStart().slice(5) : part))
			.map((part) => part.split(/\s+as\s+/)[0]?.trim() ?? "")
			.filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
		if (names.length > 0) relativeImports.push({ names, specifier: match[2] ?? "" });
	}
	return { types: [...types], aliases, unresolvedArgs: [...unresolvedArgs], relativeImports };
}

type ScanCacheValue = { mtimeMs: number; size: number; scan: ModuleScan };

// 模块级缓存：分页/窗口读会反复扫描同一批扩展文件，按 stat 指纹失效。
const scanCache = new Map<string, ScanCacheValue>();

/** 清空扫描缓存（测试与「扩展集变更需强制重扫」的调用方使用）。 */
export function clearExtensionEntryRendererScanCache(): void {
	scanCache.clear();
}

/** 提取单个源码文本里注册的 entryRenderer customType（不跟随 import，见模块注释的提取边界）。 */
export function extractEntryRendererTypes(source: string): readonly string[] {
	return scanSource(source).types;
}

function statFile(modulePath: string): { mtimeMs: number; size: number } | undefined {
	try {
		const stat = statSync(modulePath);
		if (!stat.isFile() || stat.size > MAX_SCAN_BYTES) return undefined;
		return { mtimeMs: stat.mtimeMs, size: stat.size };
	} catch {
		return undefined;
	}
}

function readModuleScan(modulePath: string, stat: { mtimeMs: number; size: number }): ModuleScan {
	const cached = scanCache.get(modulePath);
	if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.scan;
	const scan = scanSource(readFileSync(modulePath, "utf8"));
	scanCache.set(modulePath, { mtimeMs: stat.mtimeMs, size: stat.size, scan });
	return scan;
}

function resolveRelativeImport(fromDir: string, specifier: string): string | undefined {
	const base = join(fromDir, specifier);
	const candidates = [base, `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.ts`, `${base}.tsx`, join(base, "index.js"), join(base, "index.ts")];
	return candidates.find((candidate) => statFile(candidate) !== undefined);
}

/**
 * 汇总「会被 pi 加载的扩展入口」注册的 entryRenderer customType 集合。
 * 每个入口独立做有界 BFS：ES 模块图整体求值，图内任意模块的 renderer 注册都会在 pi 生效，
 * 常量别名跨模块传递，所以类型与别名都随访问累积、收尾用全图别名回填未解析标识符
 * （如 pi-subagents 的 SUPERVISOR_REPLY_ENTRY_TYPE 定义在 ../intercom/supervisor-ui.js）。
 * 只跟相对导入；visited 集 + 深度/数量上限防失控（异常依赖图按已见内容兕底）。
 * 单文件读不到/超限/解析失败只影响该文件（其类型视为未注册），不抛错。
 */
const MAX_FOLLOW_MODULES = 32;
const MAX_FOLLOW_DEPTH = 6;

export function collectEntryRendererTypes(entryPaths: readonly string[]): string[] {
	const all = new Set<string>();
	for (const entryPath of entryPaths) {
		const rootStat = statFile(entryPath);
		if (!rootStat) {
			scanCache.delete(entryPath);
			continue;
		}
		const aliases = new Map<string, string>();
		const unresolved = new Set<string>();
		const queue: Array<{ path: string; stat: { mtimeMs: number; size: number }; depth: number }> = [{ path: entryPath, stat: rootStat, depth: 0 }];
		const visited = new Set<string>([entryPath]);
		while (queue.length > 0) {
			const module = queue.shift()!;
			const scan = readModuleScan(module.path, module.stat);
			for (const type of scan.types) all.add(type);
			for (const [name, value] of scan.aliases) aliases.set(name, value);
			for (const arg of scan.unresolvedArgs) unresolved.add(arg);
			if (module.depth >= MAX_FOLLOW_DEPTH || scan.relativeImports.length === 0) continue;
			const dir = dirname(module.path);
			for (const { specifier } of scan.relativeImports) {
				const resolved = resolveRelativeImport(dir, specifier);
				if (!resolved || visited.has(resolved)) continue;
				const stat = statFile(resolved);
				if (!stat) {
					scanCache.delete(resolved);
					continue;
				}
				visited.add(resolved);
				if (visited.size > MAX_FOLLOW_MODULES) continue;
				queue.push({ path: resolved, stat, depth: module.depth + 1 });
			}
		}
		for (const arg of unresolved) {
			const value = aliases.get(arg);
			if (value) all.add(value);
		}
	}
	return [...all];
}
