#!/usr/bin/env node
/**
 * 校验 DSH runtime 归档（原「校验 asar 里的 dsh 包」，阶段 2 后职责迁移）。
 *
 *   node scripts/check-dsh-asar.mjs [--target-os <os>] [--target-arch <arch>] [<dsh-runtime-*.tgz>]
 *
 * 不传路径时默认取 dist-runtime/dsh-runtime-<platform>-<arch>.tgz（runtime:pack 的产物）；
 * --target-* 与 pack 脚本同语义，用于校验交叉打包的目标平台归档（CI 单 runner 逐平台调用）。
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
 *
 * 原生包在位断言（2026-09-18 新增）：交叉解析模式下 linux 平台包声明 libc:["glibc"]，
 * npm 在非 Linux 宿主上检测不到 libc 会把它们静默过滤（只剩 wasm32 兑底），
 * 归档体积还会变小（看似「优化」实为缺陷）。这里按目标平台断言 @img/sharp-*、
 * @koromix/koffi-*、node-pty prebuilds 的平台原生目录必须在位。
 */
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import { normalizeTarget } from "./dshRuntimeLockClosure.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));

// --target-os/--target-arch 与 pack 脚本同源解析（校验哪个平台的归档）。
const argv = process.argv.slice(2);
const argValue = (name) => {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
};
const hasTarget = argv.includes("--target-os") || argv.includes("--target-arch");
let targetPlatform = process.platform;
let targetArch = process.arch;
let targetLibc = "";
if (hasTarget) {
	const normalized = normalizeTarget({
		os: argValue("--target-os") ?? process.platform,
		arch: argValue("--target-arch") ?? process.arch,
		libc: argValue("--target-libc"),
	});
	if (normalized.error) {
		console.error(`[check-dsh-asar] ${normalized.error}`);
		process.exit(1);
	}
	targetPlatform = normalized.os;
	targetArch = normalized.arch;
	targetLibc = normalized.libc ?? "";
}

const firstNonFlag = argv.find((value, index) => !value.startsWith("--") && (index === 0 || !argv[index - 1].startsWith("--")));
const defaultArchive = join(scriptDir, "..", "dist-runtime", `dsh-runtime-${targetPlatform}-${targetArch}.tgz`);

const archivePath = firstNonFlag ? resolve(firstNonFlag) : defaultArchive;

if (!existsSync(archivePath)) {
	console.error(`用法: node scripts/check-dsh-asar.mjs [<dsh-runtime-*.tgz>]\n找不到归档: ${archivePath}`);
	process.exit(1);
}

/** 回归基线：原 asar 校验的 19 个顶层 dsh 依赖，缺一个 host 就起不来。
 *  0.2.1：dsh-invariants 停发（原 36 个包的 peer），subagent-in-process-driver 拆成
 *  spawn/fork-in-process 两个 provider 包（dsh-base patch 的直接入口）。 */
const REQUIRED = [
	"cordis-plugin-group",
	"dsh-anonymous-user-id",
	"dsh-atomic-write",
	"dsh-bash-local",
	"dsh-ptc-runtime-node",
	"dsh-compaction",
	"dsh-fs",
	"dsh-output-retention",
	"dsh-sandbox",
	"dsh-scope",
	"dsh-session-telemetry",
	"dsh-session-title-llm",
	"dsh-shell",
	"dsh-spill",
	"dsh-subagent-fork-in-process",
	"dsh-subagent-spawn-in-process",
	"dsh-subprocess",
	"dsh-timeout",
	"dsh-workflow",
];

/** hostEntry 动态 resolve 的入口，外加两个作用域外的种子包。
 *  0.1.5：dsh-host-apiproxy 已废，传输半在 dsh-client-connection，
 *  网关/端点在 dsh-api-gateway / dsh-api-session-controller（见
 *  docs/dsh-remote-contract.md）。 */
const ENTRY_PACKAGES = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-cmdline", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-api-session-controller", "dsh-bill"];

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
		// 顶层包（prefix 不含 node_modules 段 = 归档根下直接一级）计入包名单
		if (!prefix.includes("node_modules/")) {
			present.add(pkgName);
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
	if (typeof pkg.main === "string" && pkg.main && normalizeEntry(pkg.main) !== "package.json") out.push(pkg.main);
	const walk = (value) => {
		if (typeof value === "string") {
			// exports["./package.json"] 是元数据导出：文件必然在包里，不能充当
			// 运行时代码入口。2026-09 事故：dsh-tool-pwsh-persistent 缺 lib/ 时
			// 靠 "./package.json" 候选“可解析”骗过校验，坏归档照样发布。
			// 含 "*" 的通配模式（dsh-web-frontend 的 "./dist/*"）按模式展开，
			// 不能字面解析，同样不进候选。
			if (value && !value.includes("*") && normalizeEntry(value) !== "package.json") out.push(value);
		} else if (value && typeof value === "object") {
			for (const v of Object.values(value)) walk(v);
		}
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

// koffi 可由 npm 嵌套安装；检查每一份的间接入口，不能要求顶层提升，也不能让一份好包掩盖坏副本。
const koffiDirs = [...presentRelByDir.keys()].filter((dir) => dir.endsWith("/koffi"));
if (!koffiDirs.length) failures.push("missing critical package: koffi");
for (const dir of koffiDirs) {
	if (!presentRelByDir.get(dir).has("src/koffi/index.cjs")) failures.push(`missing critical file: ${dir}/src/koffi/index.cjs`);
}

/**
 * 原生包在位断言：按目标平台检查三类原生资产的目录在位。
 * 这是交叉解析模式独有的门禁——libc 缺包（linux）或 --os/--cpu 参数错误时
 * npm 不报错而是静默跳过 optional 平台包，只有这里能拦住。
 * sharp/koffi/rg 可能被 npm hoist 到顶层或嵌套在依赖它的包下（lock 布局
 * 与临时 package.json 解析结果可能不同），所以扫全部包目录而非仅顶层。
 */
const expectedNativePackages = [
	// sharp 的平台二进制（dsh-attachment-local 的图像处理后端）。
	`@img/sharp-${targetPlatform}-${targetArch}`,
	// koffi 的平台二进制（沙箱 ACL / win32-process / 持久 pwsh 都走它）。
	`@koromix/koffi-${targetPlatform}-${targetArch}`,
	// rg 平台二进制（dsh-tool-fs-search 的搜索引擎）。
	`@vscode/ripgrep-${targetPlatform}-${targetArch}`,
];
for (const nativePkg of expectedNativePackages) {
	// 归档条目收集的 dir 键由贪婪正则拼接（prefix 含最近的 node_modules/ 段），
	// 嵌套在 sharp 下的 @img/* 会被拼成 …/sharp/@img/<pkg>（少一段 node_modules）。
	// 所以这里不拼 dir 形状，直接用「包名后缀 + 路径中含该包」双条件兜住两种布局。
	const found = [...presentRelByDir.keys()].some((dir) => dir.endsWith(`/${nativePkg}`));
	if (!found) failures.push(`native package missing for ${targetPlatform}-${targetArch}: ${nativePkg}`);
}
// node-pty 是 @deepseek-ai/dsh-subprocess-local 的运行时依赖（win32 上 conpty.dll 是
// 硬运行时依赖）。它可能被 npm 提升到顶层，也可能嵌套在依赖它的包下，所以按「任意
// 位置的完整包」判定，不要求顶层：包目录存在但缺 package.json 仍是坏包（只留
// prebuilds 会让入口解析与 prebuild 断言都看不到缺口）。
// 2026-10 事故：本地 pwsh 工具下线后，项目自身那份 node-pty@1.1.0 不再进 runtime
// 闭包，归档里只剩 dsh-subprocess-local 的嵌套副本；旧的「必须顶层 package.json」
// 断言把正常归档判红。
const ptyDirs = [...presentRelByDir.keys()].filter((dir) => dir.endsWith("/node-pty"));
if (ptyDirs.length === 0) {
	failures.push("missing critical package: node-pty（@deepseek-ai/dsh-subprocess-local 的运行时依赖）");
} else {
	if (!ptyDirs.some((dir) => presentRelByDir.get(dir)?.has("package.json"))) {
		failures.push("missing critical file: node-pty/package.json");
	}
	// prebuilds/<platform>-<arch>/ 结构由 node-gyp-build 运行时选择；任一份副本带有
	// 目标平台 prebuild 即可。
	const ptyPrebuildPrefix = `prebuilds/${targetPlatform}-${targetArch}/`;
	const ptyHasPrebuild = ptyDirs.some((dir) => [...(presentRelByDir.get(dir) ?? new Set())].some((rel) => rel.startsWith(ptyPrebuildPrefix)));
	if (!ptyHasPrebuild) {
		failures.push(`node-pty prebuilds/${targetPlatform}-${targetArch}/ missing（原生模块缺平台二进制）`);
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
console.log(`OK    ${REQUIRED.length} baseline + ${ENTRY_PACKAGES.length} entry packages present; ` + `${pkgJsonByDir.size} package dirs entry-resolved; critical files present`);
