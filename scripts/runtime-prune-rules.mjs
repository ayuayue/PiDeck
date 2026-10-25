/**
 * DSH runtime 打包的裁剪规则（与 scripts/pack-dsh-runtime.mjs 共享的唯一来源）。
 *
 * 原则：只删运行时不会 require 的东西，绝不删可能被加载的文件。
 *
 * 已知雷区（2026-08 实测踩坑）：
 * - `yaml` 包的编译产物里有 `dist/doc/` 目录（Document.js 等），composer.js 会
 *   `require('../doc/directives.js')`。早年正则用 `docs?` 把 `doc` 也当成文档裁掉，
 *   导致 host 启动即崩（Cannot find module '../doc/directives.js' → exit(1)）。
 *   因此这里只裁 **docs/**（复数，npm 文档惯例），单数 `doc/` 一律保留——
 *   不裁多出的体积可忽略，裁错就是 host 起不来。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * npm 在 Windows 上升级 scoped 包时，旧目录会被 rename 成 `.pkg-<8char>` 残留。
 * 这些目录仍有 package.json（内容是上一版），pack 若按「有 package.json 就当活包」
 * 收进种子/闭包，会把整份旧 @deepseek-ai 作用域再打进归档（实测
 * `.dsh-base-cFJMOBFY` = @deepseek-ai/dsh-base 0.1.1-rc.2，整作用域 leftover ~99MB）。
 *
 * 只匹配「点开头 + 任意名 + 连字符 + 8 位字母数字」：npm 包名不能以点开头，
 * 活包目录（dsh-base、cordis）不会误伤。嵌套在包内的同类残留同样用此判定跳过。
 * 顶层 `node_modules/.katex-*` 不在 runtime 种子里，不在本函数的收口范围。
 */
export function isNpmHashedLeftoverDir(name) {
	return typeof name === "string" && /^\..+-[A-Za-z0-9]{8}$/.test(name);
}

/** 归一化入口路径（处理 ./ 与 ../），返回相对包目录的规范路径。 */
function normalizeEntryPath(entry) {
	const parts = entry.replace(/\\/g, "/").split("/");
	const out = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

/**
 * 与 check-dsh-asar 的 collectAllEntries 完全同语义的入口候选收集：
 * main + exports 整树全部字符串值（含子路径导出条件）。
 * 个别上游包的 exports["."] 指向从未发布过的文件（如 @modelcontextprotocol/sdk
 * 的 import 条件指 dist/esm/index.js），实际运行时只走子路径导出——只看 "."
 * 会误报「入口缺失」；进入打包前预检必须在“至少一个候选项可解析”的粒度上判定。
 */
export function allEntryCandidates(pkgDir) {
	const out = [];
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	} catch {
		return out;
	}
	if (typeof pkg.main === "string" && pkg.main && normalizeEntryPath(pkg.main) !== "package.json") out.push(pkg.main);
	const walk = (value) => {
		if (typeof value === "string") {
			// exports["./package.json"] 是元数据导出（Node 允许包外读 package.json），
			// 文件必然存在，不能充当「运行时代码入口」。2026-09 事故中
			// dsh-tool-pwsh-persistent 的 exports 同时声明 "." → lib/index.js 与
			// "./package.json"，缺 lib 时不过滤会被 package.json 误判为可解析，
			// 坏归档静默通过校验（本函数与 check-dsh-asar 同语义，两侧都需过滤）。
			// 含 "*" 的是子路径通配模式（如 dsh-web-frontend 的 "./dist/*"），
			// 指向的文件按模式展开，无法字面 stat，同样不进候选。
			if (value && !value.includes("*") && normalizeEntryPath(value) !== "package.json") out.push(value);
		} else if (value && typeof value === "object") {
			for (const v of Object.values(value)) walk(v);
		}
	};
	if (pkg.exports) walk(pkg.exports);
	return out;
}

/**
 * 包运行时入口在磁盘上是否可解析（main / exports 候选，含无扩展名补全）。
 * 入口无扩展名时按 Node 规则补 .js/.cjs/.mjs 与 index.*（与 check-dsh-asar 的
 * 归档侧 resolveEntry 同语义）。供 pack 脚本打包前预检：file: 本地包在全新检出下
 * 可能没有编译产物（lib/ 是 gitignore 产物），源码-only 的包被打进归档会让 host
 * require.resolve 直接崩（2026-09 v0.7.5 sidecar：dsh-tool-pwsh-persistent
 * 缺 lib/index.js 事故）。
 */
export function runtimeEntryResolvableOnDisk(pkgDir, entry) {
	const norm = normalizeEntryPath(entry);
	if (!norm) return false;
	const candidates = [norm];
	if (!/\.(js|cjs|mjs|json)$/.test(norm)) {
		for (const ext of [".js", ".cjs", ".mjs"]) candidates.push(norm + ext);
		for (const ext of ["index.js", "index.cjs", "index.mjs"]) candidates.push(`${norm}/${ext}`);
	}
	// 必须按 isFile 判定：入口指到目录时（如 main: "dist"）裸目录本身不可解析，
	// Node 会继续尝试 index.* 补全；existsSync 会把目录误判成可解析。
	return candidates.some((candidate) => {
		try {
			return statSync(join(pkgDir, candidate)).isFile();
		} catch {
			return false;
		}
	});
}

/**
 * 包内是否有编译产物目录。有 lib/ 或 dist/ 时，src/ 只是源码副本，
 * 运行时加载的是产物，src 可以整块丢掉（这是归档里最大的一块冗余）。
 */
export function hasBuildOutput(pkgDir) {
	return existsSync(join(pkgDir, "lib")) || existsSync(join(pkgDir, "dist")) || existsSync(join(pkgDir, "build"));
}

/**
 * 从 main/exports 提取运行时会加载的入口（相对包目录，统一 `/` 分隔）。
 * 取 main 与 exports["."] 的全部运行时条件值（import/require/node/default，
 * types 等纯类型条件不在此列），与 check-dsh-asar 的 collectAllEntries 对齐：
 * 上游包可能只发布部分条件指向的文件（如 @modelcontextprotocol/sdk 的
 * import 条件指 dist/esm/index.js 但从未发布，实际走 require/default），
 * 调用方按「至少一个可解析」判定，不能只取第一个条件。
 */
export function entryPointsFromPkg(main, exports) {
	const entries = [];
	// 空字符串 main（如纯类型数据包 @octokit/openapi-types 的 main: ""）不算入口。
	if (typeof main === "string" && main) entries.push(main);
	const dot = exports?.["."];
	if (typeof dot === "string") {
		if (dot) entries.push(dot);
	} else if (dot && typeof dot === "object") {
		// 条件对象：收集全部运行时条件值（import > require > node > default 顺序），
		// 不做 first-match——「至少一个可解析」要求看到全部候选。
		for (const cond of ["import", "require", "node", "default"]) {
			if (typeof dot[cond] === "string" && dot[cond]) entries.push(dot[cond]);
		}
	}
	return entries;
}

/**
 * 运行时会加载的入口文件（相对包目录，统一 `/` 分隔）。
 * 取 package.json 的 main 与 exports["."] 的运行时条件（import/require/node/default），
 * types 等纯类型条件不在此列。
 */
export function runtimeEntryPoints(pkgDir) {
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
	} catch {
		return [];
	}
	return entryPointsFromPkg(pkg.main, pkg.exports);
}

/**
 * 少数包不遵循「源码在 src/、产物在 lib|dist/」的惯例：
 * 运行时代码本身就在 src/ 里，lib/ 只是原生二进制等非 JS 产物。
 * 对这些包必须保留 src/，否则入口解析到一半崩（koffi 事故：
 * index.cjs -> require('./src/koffi/index.cjs')，src/ 被裁后
 * dsh-subprocess-local / dsh-sandbox-local 全部加载失败）。
 */
export const KEEP_SRC_PACKAGES = new Set(["koffi"]);

/**
 * src/ 是否可裁（整包级判定）：
 * - 有编译产物（lib|dist|build）是前提；
 * - 但入口（main / exports["."] 运行时条件）落在 src/ 里的包不能裁
 *   （如 node-fetch main=./src/index.js、ecdsa-sig-formatter main=src/…），
 *   入口在 src/ 说明运行时直接加载源码；
 * - KEEP_SRC_PACKAGES 白名单兜底间接引用（入口在根目录、但内部 require 到 src/ 的包）。
 */
export function isSrcPrunable(pkgDir) {
	if (!hasBuildOutput(pkgDir)) return false;
	try {
		const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
		if (pkg.name && KEEP_SRC_PACKAGES.has(pkg.name)) return false;
	} catch {
		// 读不到 package.json 的目录不是合法包，交给入口判定（返回空则继续）
	}
	return !runtimeEntryPoints(pkgDir).some((entry) => entry.replace(/^\.\//, "").split("/")[0] === "src");
}

/** 其他平台的 prebuilds：Electron 只跑当前平台。 */
export function isOtherPlatformPrebuild(relPath, platform) {
	const match = relPath.match(/prebuilds[/\\]([a-z0-9]+)-[\w-]+[/\\]/);
	if (!match) return false;
	return match[1] !== platform;
}

/**
 * 文件级裁剪判定。
 * relPath 是相对包目录的路径（统一用 `/` 分隔）；srcPrunable 表示包内已有编译产物。
 *
 * 排除的都是「运行时不会被 require 的东西」：调试符号、source map、测试、示例、
 * 文档（仅 docs/）、类型声明、其他平台的原生二进制、官方包内的历史版本副本，
 * 以及有编译产物时的 src/ 源码。**LICENSE 一律保留**（分发合规）。
 */
export function isExcluded(relPath, pkgDir, srcPrunable, platform = process.platform) {
	if (relPath.endsWith(".pdb")) return true;
	if (relPath.endsWith(".map")) return true;
	if (relPath.endsWith(".d.ts")) return true;
	// third_party：官方包内的历史版本副本（运行时只取 prebuilds/ 里的当前版本）。
	// 用锚点正则覆盖「包根目录下」与「嵌套路径中」两种位置。
	if (/(^|\/)third_party\//.test(relPath) || relPath.includes("\\third_party\\")) return true;
	if (isOtherPlatformPrebuild(relPath, platform)) return true;
	// 测试 / 示例 / 文档（复数 docs/）：npm 包常带，运行时不加载。
	// 注意 docs? 会误伤 yaml 的 dist/doc/（编译产物），见文件头说明，这里只用 docs。
	if (/(^|\/)(tests?|__tests__|spec|examples?|demo|docs)\//.test(relPath)) return true;
	if (/\.(test|spec)\.[cm]?js$/.test(relPath)) return true;
	// README/CHANGELOG 之类：运行时不读，且量不小（数百个包累加约 5MB）
	if (/\.(md|markdown)$/.test(relPath)) return true;
	// 有 lib/ 或 dist/ 时，src/ 是源码副本
	if (srcPrunable && relPath.startsWith("src/")) return true;
	return false;
}
