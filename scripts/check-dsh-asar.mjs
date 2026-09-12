#!/usr/bin/env node
/**
 * 校验 DSH runtime 归档（原「校验 asar 里的 dsh 包」，阶段 2 后职责迁移）。
 *
 *   node scripts/check-dsh-asar.mjs [<dsh-runtime-*.tgz>]
 *
 * 不传路径时默认取 dist-runtime/dsh-runtime-<platform>-<arch>.tgz（runtime:pack 的产物）。
 * 深校验用 `npm run runtime:check:boot`：解压到临时目录并真实 boot 一次插件树
 * （见 scripts/check-dsh-boot.mjs）。
 *
 * 背景：runtime 外置后 app.asar 里**不该**再有 @deepseek-ai 包（它们已移入
 * devDependencies，electron-builder 不再收集）。所以校验对象从 asar 换成
 * runtime tarball——打包流水线在上传前跑一次，缺包就红。
 *
 * 只遍历归档条目、不解压：3 万多个文件的解压要一分钟，而这里只需要判断路径存在性。
 * 除「包存在」外还做**入口解析校验**：每个包的 main / exports["."] 运行时入口必须在
 * 归档里能解析到真实文件。2026-08 事故教训：只看包名存在抓不到「包在但入口文件被裁 /
 * 依赖包整体缺席」的情况（@earendil-works/pi-ai 空壳、koffi 的 src/ 被裁）。
 * 嵌套依赖（<pkg>/node_modules/<sub>/）按完整目录独立收集，避免子包 package.json
 * 污染外层包的入口判定。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultArchive = join(
	scriptDir,
	"..",
	"dist-runtime",
	`dsh-runtime-${process.platform}-${process.arch}.tgz`,
);

const [rawPath] = process.argv.slice(2);
const archivePath = rawPath ? resolve(rawPath) : defaultArchive;

if (!existsSync(archivePath)) {
	console.error(`用法: node scripts/check-dsh-asar.mjs [<dsh-runtime-*.tgz>]\n找不到归档: ${archivePath}`);
	process.exit(1);
}

/** 回归基线：原 asar 校验的 19 个顶层 dsh 依赖，缺一个 host 就起不来。 */
const REQUIRED = [
	"cordis-plugin-group",
	"dsh-anonymous-user-id",
	"dsh-atomic-write",
	"dsh-bash-local",
	"dsh-code-runtime",
	"dsh-compaction",
	"dsh-fs",
	"dsh-invariants",
	"dsh-output-retention",
	"dsh-sandbox",
	"dsh-scope",
	"dsh-session-telemetry",
	"dsh-session-title-llm",
	"dsh-shell",
	"dsh-spill",
	"dsh-subagent-in-process-driver",
	"dsh-subprocess",
	"dsh-timeout",
	"dsh-workflow",
];

/** hostEntry 动态 resolve 的入口，外加两个作用域外的种子包。
 *  0.1.5：dsh-host-apiproxy 已废，传输半在 dsh-client-connection，
 *  网关/端点在 dsh-api-gateway / dsh-api-session-controller（见
 *  docs/dsh-0.1.5-typert-migration.md）。 */
const ENTRY_PACKAGES = [
	"@deepseek-ai/dsh-base",
	"@deepseek-ai/dsh-app-boot",
	"@deepseek-ai/dsh-cmdline",
	"@deepseek-ai/dsh-client-connection",
	"@deepseek-ai/dsh-api-gateway",
	"@deepseek-ai/dsh-api-remotes",
	"@deepseek-ai/dsh-api-session-controller",
	"dsh-bill",
	"dsh-tool-pwsh-persistent",
];

/**
 * 已知「运行时代码在 src/」的包，归档里必须带这些文件（见 runtime-prune-rules.mjs
 * KEEP_SRC_PACKAGES）。koffi 的入口在根 index.cjs，但内部 require('./src/koffi/…')，
 * 入口解析校验看不到这一层间接引用，这里显式钉死。
 */
const MUST_HAVE_FILES = [
	"node_modules/koffi/src/koffi/index.cjs",
	// node-pty 是 dsh-tool-pwsh-persistent 的运行时依赖；入口解析校验覆盖不到
	// 「依赖包整个缺席」的场景（曾因 appOwnDeps 过滤被挡在归档外）。
	"node_modules/node-pty/package.json",
];

/** 归一化入口（处理 ./ 与 ../），返回相对包目录的规范路径。 */
function normalizeEntry(entry) {
	const parts = entry.replace(/\\/g, "/").split("/");
	const out = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") out.pop();
		else out.push(part);
	}
	return out.join("/");
}

/** 入口文件解析：main/exports 可能无扩展名（Node 会补 .js/.cjs/.mjs）或指向目录（补 index.*）。 */
function resolveEntry(entry, presentRel) {
	const norm = normalizeEntry(entry);
	if (!norm) return undefined; // @types/* 这类 exports 只有 types 条件，无运行时入口
	const candidates = [norm];
	if (!/\.(js|cjs|mjs|json)$/.test(norm)) {
		for (const ext of [".js", ".cjs", ".mjs"]) candidates.push(norm + ext);
		for (const ext of ["index.js", "index.cjs", "index.mjs"]) candidates.push(`${norm}/${ext}`);
	}
	return candidates.find((c) => presentRel.has(c));
}

const present = new Set(); // 顶层包名（去重，归档校验用）
const topLevel = new Map(); // 顶层包名 → 该包目录下文件相对路径集合
const presentRelByDir = new Map(); // 包目录 → 该目录下文件相对路径集合（含嵌套）
const pkgJsonByDir = new Map(); // 包目录 → 该包第一个 package.json 内容
let manifest = null;
let entryCount = 0;

await tar.t({
	file: archivePath,
	onReadEntry(entry) {
		entryCount += 1;
		const path = entry.path.replaceAll("\\", "/");
		if (path.endsWith("/manifest.json")) {
			entry.on("data", (chunk) => {
				try {
					manifest = JSON.parse(chunk.toString("utf8"));
				} catch {
					/* 解析失败会在下面的校验里报出来 */
				}
			});
			entry.resume();
			return;
		}
		// 包目录 = 任意 node_modules 段之后的名字（支持嵌套 node_modules）
		const match = path.match(/^(.*\/)node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/);
		if (!match) return;
		const [, prefix, pkgName, rest] = match;
		const dir = prefix + pkgName; // 完整包目录（含嵌套前缀）
		if (!presentRelByDir.has(dir)) presentRelByDir.set(dir, new Set());
		const relSet = presentRelByDir.get(dir);
		if (rest && !rest.endsWith("/")) relSet.add(rest);
		if (rest === "package.json" && !pkgJsonByDir.has(dir)) {
			let raw = "";
			entry.on("data", (chunk) => {
				raw += chunk.toString("utf8");
			});
			entry.on("end", () => {
				try {
					pkgJsonByDir.set(dir, JSON.parse(raw));
				} catch {
					/* 解析失败跳过入口校验 */
				}
			});
		}
		// 顶层包（prefix 不含 node_modules 段 = 归档根下直接一级）计入包名单与顶层文件映射
		if (!prefix.includes("node_modules/")) {
			present.add(pkgName);
			if (!topLevel.has(pkgName)) topLevel.set(pkgName, new Set());
			if (rest && !rest.endsWith("/")) topLevel.get(pkgName).add(rest);
		}
	},
});

const failures = [];

if (!manifest) {
	failures.push("manifest.json missing or unreadable");
} else {
	if (manifest.schemaVersion !== 1) failures.push(`unexpected schemaVersion: ${manifest.schemaVersion}`);
	if (!manifest.runtimeVersion) failures.push("manifest.runtimeVersion missing");
	// 归档内 manifest 的 archiveSha256 按设计是空串：把归档哈希写进归档内容会
	// 自相矛盾（填了哈希 → 内容变 → 哈希失效）。校验值由下载源索引提供，
	// 这里只检查「如果填了，格式必须对」。
	if (manifest.archiveSha256 && !/^[0-9a-f]{64}$/i.test(manifest.archiveSha256)) {
		failures.push(`manifest.archiveSha256 is not a sha256 hex: ${manifest.archiveSha256}`);
	}
	for (const pkg of manifest.requiredPackages ?? []) {
		if (!present.has(pkg)) failures.push(`requiredPackages missing: ${pkg}`);
	}
}

for (const name of REQUIRED) {
	const scoped = `@deepseek-ai/${name}`;
	if (!present.has(scoped)) failures.push(`missing ${scoped}`);
}
for (const pkg of ENTRY_PACKAGES) {
	if (!present.has(pkg)) failures.push(`missing ${pkg}`);
}

/** 收集包的所有入口候选（main + exports 全部字符串值，递归展开条件对象）。 */
function collectAllEntries(pkg) {
	const out = [];
	if (typeof pkg.main === "string" && pkg.main) out.push(pkg.main);
	const walk = (value) => {
		if (typeof value === "string") out.push(value);
		else if (value && typeof value === "object") for (const v of Object.values(value)) walk(v);
	};
	if (pkg.exports) walk(pkg.exports);
	return out;
}

// 逐包入口解析校验：包在但**所有**入口都解析不到文件 = host 加载到一半崩
// （pi-ai 空壳事故）。判定粒度是「至少一个入口可解析」而不是逐个钉死，因为个别
// 上游包的 exports["."] 指向不存在文件（@modelcontextprotocol/sdk 的 import 条件
// 指 dist/esm/index.js 但该文件从未发布过），实际运行时只走子路径导出。
// @types/* 是纯类型包（.d.ts 会被裁剪规则删掉），host 永远不会加载，跳过。
for (const [dir, pkg] of pkgJsonByDir) {
	const pkgName = dir.split("/node_modules/").at(-1);
	if (pkgName.startsWith("@types/")) continue;
	const presentRel = presentRelByDir.get(dir) ?? new Set();
	const allEntries = collectAllEntries(pkg);
	if (allEntries.length === 0) continue; // 无运行时入口的包无需校验
	const resolvable = allEntries.filter((entry) => resolveEntry(entry, presentRel));
	if (resolvable.length === 0) {
		failures.push(`no resolvable entry: ${pkgName} (main=${pkg.main ?? ""} exports=${JSON.stringify(pkg.exports ?? {})?.slice(0, 80)})`);
	}
}

// 已知关键文件（见 MUST_HAVE_FILES 注释）
for (const file of MUST_HAVE_FILES) {
	const [pkgName, ...relParts] = file.slice("node_modules/".length).split("/");
	const rel = relParts.join("/");
	if (!topLevel.get(pkgName)?.has(rel)) {
		failures.push(`missing critical file: ${file}`);
	}
}

console.log(`entries: ${entryCount} | packages: ${present.size}`);
if (manifest) {
	console.log(`runtimeVersion: ${manifest.runtimeVersion} | minAppVersion: ${manifest.minAppVersion}`);
}

if (failures.length > 0) {
	for (const failure of failures) console.error(`FAIL  ${failure}`);
	process.exit(1);
}
console.log(
	`OK    ${REQUIRED.length} baseline + ${ENTRY_PACKAGES.length} entry packages present; ` +
		`${pkgJsonByDir.size} package dirs entry-resolved; critical files present`,
);
