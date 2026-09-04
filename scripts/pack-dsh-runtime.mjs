#!/usr/bin/env node
/**
 * 打包 DSH runtime 为按需下载的 tarball（AgentRuntimeProvider 阶段 2）。
 *
 *   node scripts/pack-dsh-runtime.mjs [--out <dir>] [--dry-run]
 *
 * 产出：<out>/dsh-runtime-<platform>-<arch>.tgz，内部结构固定为
 *
 *   dsh-runtime/
 *     manifest.json
 *     node_modules/@deepseek-ai/...
 *     node_modules/<传递依赖>/...
 *
 * 解压端（DshRuntimeManager）剥掉顶层 dsh-runtime/ 后直接得到 node_modules +
 * manifest，与 hostEntry 期望的 `--dsh-node-modules` 布局一致。
 *
 * 两个设计取舍：
 *
 * 1. **按「整个 @deepseek-ai 作用域」收集，而不是静态闭包**。hostEntry 通过
 *    require.resolve + 动态 import 加载模块，且 cordis 生态大量使用 peerDependencies，
 *    静态分析必然漏包——漏包的后果是 host 启动到一半崩，用户无法自助恢复。
 *    作用域全集更保守，代价是体积，由下面的文件级裁剪兜住。
 *
 * 2. **归档 sha256 不写进归档内的 manifest**。manifest 在归档里，把归档哈希写进
 *    归档内容会自相矛盾（填了哈希 → 内容变了 → 哈希失效）。校验用的哈希由
 *    下载源索引（dsh-runtime-releases.json）提供，manifest 里的 archiveSha256
 *    留空；打包完成后另外输出一份同名 manifest.json 副本（带真实 sha256），
 *    供生成索引条目使用。
 *
 * 裁剪规则（只删运行时用不到的东西，不删任何可能被 require 的文件）：
 *   - *.pdb                调试符号，随包分发但运行时不加载
 *   - *.map                source map（归档里最大的单项冗余，约 29MB）
 *   - 其他平台的 prebuilds  Electron 只跑当前平台，别把 linux/darwin 的 .node 带给 Windows 用户
 *   - third_party/**        官方包内的历史版本副本（运行时只取 prebuilds/ 里的当前版本）
 *   - *.d.ts                类型声明，Node 不加载
 *   - test/ spec/ examples/ docs/ 运行时不会去读（注意：只裁 **docs/** 复数目录，
 *                            `doc/` 可能是编译产物，见 runtime-prune-rules.mjs 的雷区记录）
 *   - *.md                  数百个包的 README/CHANGELOG 累加约 5MB
 *   - src/（仅当包内已有 lib/ 或 dist/，且入口不在 src/、不在 KEEP_SRC 白名单）
 *                           源码副本，约 60MB。**条件很关键**：个别包（如嵌套的 zod）
 *                           只有 src/ 没有编译产物，无脑裁会让模块直接消失；另有
 *                           koffi/node-fetch 这类运行时代码就活在 src/ 里的包，
 *                           判定细节见 runtime-prune-rules.mjs 的 isSrcPrunable。
 *
 * 另注意：runtime 必须**自包含**——host 的模块解析锚点（--dsh-node-modules）只指向
 * runtime 目录，不读 app.asar 里的 node_modules（ESM 无 NODE_PATH 双源回退）。
 * 所以闭包收集**不能**因「包同时是 app 依赖」就跳过（曾因此把 @earendil-works/pi-ai、
 * node-pty 挡在归档外，host 加载 dsh-llm-pi-ai / pwsh 工具时崩）。
 *
 * 实测（win32-x64）：225.4MB → 150.5MB 未压缩，tarball 47.2MB → 33.6MB。
 * 裁剪后必须跑一遍入口解析校验（见 docs 的验证记录），确认没有裁掉运行文件。
 */
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
// 裁剪规则独立成模块：CLI 主流程不便 import（会触发打包），测试直接引用规则单测。
import { isExcluded, isSrcPrunable } from "./runtime-prune-rules.mjs";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 归档内顶层目录名（与 shared/types/dshRuntimeManifest.DSH_RUNTIME_ARCHIVE_ROOT 一致）。 */
const ARCHIVE_ROOT = "dsh-runtime";
/** 随包资源目录名（与 main/dsh/runtime/DshRuntimeManager.DSH_BUNDLED_RUNTIME_DIRNAME 一致）。 */
const DSH_BUNDLED_DIRNAME = "dsh-runtime";

const PLATFORM = process.platform;
const ARCH = process.arch;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
/** --lite：只产 tgz 与索引，不把 runtime 塞进随包资源（用于在意安装体积的场景）。 */
const lite = argv.includes("--lite");
/** --if-missing：随包资源已存在就跳过（给快速打包链路用，避免每次都重打 20 秒）。 */
const ifMissing = argv.includes("--if-missing");
const outIndex = argv.indexOf("--out");
const outDir = outIndex >= 0 ? resolve(argv[outIndex + 1]) : join(projectRoot, "dist-runtime");

// ── 闭包收集 ──

/** 从 fromDir 出发沿 node_modules 查找链解析包名 → 实际目录（支持嵌套 node_modules）。 */
function resolvePackageDir(fromDir, name) {
	let current = fromDir;
	for (;;) {
		const candidate = join(current, "node_modules", ...name.split("/"));
		if (existsSync(join(candidate, "package.json"))) return candidate;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function readPackageJson(dir) {
	try {
		return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * 从种子包出发 BFS 收集磁盘上的依赖目录闭包。
 *
 * 只跟随 dependencies + optionalDependencies，**不跟随 peerDependencies**：
 * peer 的语义是「由宿主提供」，把 react-dom 这类前端 peer 拖进来会白增十几 MB，
 * 而 host 进程根本不加载它们。真正必需的运行时包都写在 dependencies 里。
 * 不跟随 devDependencies。
 */
function collectClosure(seedDirs) {
	const seen = new Set();
	const queue = [...seedDirs];
	while (queue.length > 0) {
		const dir = queue.pop();
		if (!dir || seen.has(dir)) continue;
		seen.add(dir);
		const pkg = readPackageJson(dir);
		if (!pkg) continue;
		const deps = { ...pkg.dependencies, ...pkg.optionalDependencies };
		for (const name of Object.keys(deps)) {
			const depDir = resolvePackageDir(dir, name);
			if (depDir && !seen.has(depDir)) queue.push(depDir);
		}
	}
	return [...seen];
}

/** 包自己的名字（从 package.json 读）；路径推断在嵌套 node_modules 下会出错。 */
function packageNameOf(dir) {
	return readPackageJson(dir)?.name;
}

// ── 文件级裁剪（规则实现见 runtime-prune-rules.mjs） ──

function listFiles(dir) {
	const out = [];
	const walk = (current) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) walk(full);
			else if (entry.isFile()) out.push(full);
		}
	};
	walk(dir);
	return out;
}

// ── 主流程 ──

const appPackage = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
const nodeModulesRoot = join(projectRoot, "node_modules");
const dshScopeDir = join(nodeModulesRoot, "@deepseek-ai");

if (!existsSync(dshScopeDir)) {
	console.error("[pack-dsh-runtime] node_modules/@deepseek-ai 不存在，请先 npm install");
	process.exit(1);
}

// --if-missing：随包资源齐备就跳过。放在闭包扫描之前，跳过时几乎零耗时。
// 判据是「manifest + 当前平台归档都在」，不比对内容哈希——依赖内容变了需要
// 手动删掉 dist-runtime/ 重打，日常迭代用这个粒度换速度是划算的。
if (ifMissing) {
	const bundleDir = join(outDir, DSH_BUNDLED_DIRNAME);
	const archiveName = `dsh-runtime-${PLATFORM}-${ARCH}.tgz`;
	if (existsSync(join(bundleDir, "manifest.json")) && existsSync(join(bundleDir, archiveName))) {
		console.log("[pack-dsh-runtime] --if-missing：随包 runtime 已存在，跳过");
		process.exit(0);
	}
}

/**
 * 作用域外的种子：这两个包不在 @deepseek-ai 下，但 hostEntry 会
 * `require.resolve` 它们（持久 pwsh 工具、用量计费插件），缺了 host 起不来。
 * 它们同样在下面的「随 app 分发则跳过」规则里被豁免——依赖分区后 app 不再带它们。
 */
const EXTRA_SEED_NAMES = ["dsh-bill", "dsh-tool-pwsh-persistent"];

const seedDirs = [
	...readdirSync(dshScopeDir)
		.map((name) => join(dshScopeDir, name))
		.filter((dir) => existsSync(join(dir, "package.json"))),
	...EXTRA_SEED_NAMES.map((name) => join(nodeModulesRoot, name)).filter((dir) =>
		existsSync(join(dir, "package.json")),
	),
];

// 随 app 分发的包不在 runtime 里重复带（electron-builder 已打进 asar，装完也用得上）。
// @deepseek-ai 作用域例外：依赖分区后它们会从 app 依赖里移走，必须自带。
//
// ⚠️ 2026-08 生产事故：这里曾用 appOwnDeps 过滤掉「同时是 app 依赖」的闭包包
// （@earendil-works/pi-ai、node-pty），但 host 的模块解析锚点只有 runtime
// node_modules（见文件头说明），app.asar 里的副本 host 根本看不见——
// 结果 runtime 里留下一个没有 package.json/index.js 的空壳 pi-ai，
// dsh-llm-pi-ai 加载即崩（host exit 1）。runtime 必须自包含，不再做此裁剪。
const closure = collectClosure(seedDirs).filter((dir) => Boolean(packageNameOf(dir)));
const closureSet = new Set(closure);

// 遍历文件时跳过「属于另一个闭包目录」的子目录：嵌套 node_modules 既会被父目录
// 递归到、又会作为独立闭包项单独统计，不去重会把体积算成两倍。
const files = [];
let prunedBytes = 0;
for (const dir of closure) {
	const srcPrunable = isSrcPrunable(dir);
	const walk = (current, base) => {
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const full = join(current, entry.name);
			if (entry.isDirectory()) {
				if (closureSet.has(full)) continue;
				walk(full, base);
				continue;
			}
			const rel = relative(base, full).split(sep).join("/");
			const size = statSync(full).size;
			if (isExcluded(rel, base, srcPrunable)) prunedBytes += size;
			else files.push({ abs: full, relInClosure: relative(nodeModulesRoot, full) });
		}
	};
	walk(dir, dir);
}

const totalBytes = files.reduce((sum, f) => sum + statSync(f.abs).size, 0);
const dshVersion = readPackageJson(join(dshScopeDir, "dsh")).version;
const appVersion = appPackage.version;

const manifest = {
	schemaVersion: 1,
	runtimeVersion: dshVersion,
	builtByAppVersion: appVersion,
	// 兼容区间：产出自当前 app 版本，向上不承诺。发新版 app 且桥协议有变时，
	// 调大 minAppVersion 或收紧 maxAppVersion，让旧 runtime 自动退出候选。
	minAppVersion: appVersion,
	maxAppVersion: "",
	// 见文件头说明：归档哈希由下载源索引提供，这里留空。
	archiveSha256: "",
	requiredPackages: [
		"@deepseek-ai/dsh-base",
		"@deepseek-ai/dsh-app-boot",
		"@deepseek-ai/dsh-host-apiproxy",
		"@deepseek-ai/dsh-cmdline",
	],
	packageCount: closure.length,
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
console.log("[pack-dsh-runtime] 平台:", `${PLATFORM}-${ARCH}`);
console.log("[pack-dsh-runtime] 闭包包数:", closure.length);
console.log("[pack-dsh-runtime] 文件数:", files.length);
console.log("[pack-dsh-runtime] 归档前体积:", mb(totalBytes), `(已裁剪 ${mb(prunedBytes)})`);
console.log("[pack-dsh-runtime] runtime 版本:", dshVersion, "| app 版本:", appVersion);

if (dryRun) {
	console.log("[pack-dsh-runtime] --dry-run：跳过打包");
	process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const archiveName = `dsh-runtime-${PLATFORM}-${ARCH}.tgz`;
const archivePath = join(outDir, archiveName);

/**
 * 零复制打包：直接把 node_modules 里的原文件按目标路径写进归档。
 *
 * 早期版本先把 3.4 万个文件复制进暂存目录再打包、最后删除暂存——那一步在
 * Windows 上要二十多分钟（删比复制还慢）。这里改用相对路径 + onWriteEntry
 * 重命名，既不需要 200MB 级别的临时副本，也没有清理阶段（约 20 秒完成）。
 *
 * 两个坑：
 * - tar v7 没有 `map` 选项（那是 v6 的 API），改条目路径要用 `onWriteEntry`；
 * - 条目必须传**相对 cwd 的路径**。传绝对路径时 tar 只会剥掉盘符，不会按 cwd
 *   相对化，解出来会变成 `Users/14012/...` 这种盘符外的完整路径。
 */
const MANIFEST_TMP_NAME = ".dsh-runtime-manifest.json";
const manifestTmp = join(nodeModulesRoot, MANIFEST_TMP_NAME);
writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2));

try {
	await tar.c(
		{
			gzip: { level: 9 },
			file: archivePath,
			cwd: nodeModulesRoot,
			portable: true,
			onWriteEntry: (entry) => {
				// 条目统一带 "./" 传入（规避 tar 对 "@" 开头路径的特殊解释——
				// 作用域包 @deepseek-ai/x 会被吃掉 "@" 变成 deepseek-ai/x），
				// 这里把前缀去掉再拼归档内的目标路径。
				const rel = entry.path.replace(/^\.\//, "");
				// relInClosure 是相对 node_modules 的路径（不含 node_modules 段），
				// 这里补回来：归档内必须是 dsh-runtime/node_modules/<pkg>/... ，
				// 与 DshRuntimeManager 解压后的期望布局一致。
				entry.path =
					rel === MANIFEST_TMP_NAME
						? `${ARCHIVE_ROOT}/manifest.json`
						: `${ARCHIVE_ROOT}/node_modules/${rel}`;
			},
		},
		// 注意必须带 "./"：见上面 onWriteEntry 的说明。
		[`./${MANIFEST_TMP_NAME}`, ...files.map((f) => `./${f.relInClosure}`)],
	);
} finally {
	try {
		rmSync(manifestTmp, { force: true });
	} catch {
		// 工作区内的删除会被回收站包装拦截（genie-trash 故障时的已知现象）。
		// 退化为清空内容：文件留着不影响构建，下次打包会整体覆盖。
		try {
			truncateSync(manifestTmp, 0);
		} catch {
			/* 清不掉也不影响归档已产出 */
		}
	}
}

const hash = createHash("sha256");
for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
const sha256 = hash.digest("hex");
const finalSize = statSync(archivePath).size;

// 归档外的 manifest 副本带真实 sha256，用于生成下载源索引条目。
writeFileSync(
	join(outDir, "manifest.json"),
	JSON.stringify({ ...manifest, archiveSha256: sha256 }, null, 2),
);

// 顺手产出一份可直接用的索引：url 指本地归档，便于在上传到 Release 之前
// 就把安装链路（选版本 → 校验 → 解压 → 落位）端到端跑通——把 settings 的
// dshRuntimeIndexUrl 或 DSH_RUNTIME_INDEX_URL 指到这个文件即可。
const localIndex = {
	schemaVersion: 1,
	releases: [
		{
			runtimeVersion: dshVersion,
			minAppVersion: manifest.minAppVersion,
			maxAppVersion: manifest.maxAppVersion,
			url: `file:///${archivePath.split(sep).join("/")}`,
			sha256,
			size: finalSize,
		},
	],
};
const indexPath = join(outDir, "dsh-runtime-releases.json");
writeFileSync(indexPath, JSON.stringify(localIndex, null, 2));

/**
 * 随包资源目录：electron-builder 的 extraResources 会把它原样放进 resources/。
 * 应用内 `readBundledRuntime()` 从这里读，有就本地解压安装（零网络、零等待），
 * 没有（--lite 打的包）才走在线索引 / 手动导入。
 *
 * --lite 时仍然创建这个目录（留一个 .gitkeep）：electron-builder 的 extraResources
 * 源目录缺失时的行为不一致，保持目录存在最稳，空目录会被读成「没有随包 runtime」。
 */
const bundleDir = join(outDir, DSH_BUNDLED_DIRNAME);
mkdirSync(bundleDir, { recursive: true });
if (lite) {
	// --lite：随包目录留空，但必须清掉此前非 lite 打包残留的 tgz/manifest——
	// 否则 electron-builder 的 extraResources 会把旧 runtime 打进安装包，
	// “减小体积”的目标被过期产物悄悄破坏。
	for (const name of readdirSync(bundleDir)) {
		if (name !== ".gitkeep") rmSync(join(bundleDir, name), { recursive: true, force: true });
	}
	// 只在文件不存在时创建占位（首次检出/目录被删场景）；已在版本库里的 .gitkeep
	// 带说明注释，绝不能被每次打包清空——否则 git 工作区永远显示它被修改（diff 噪声）。
	if (!existsSync(join(bundleDir, ".gitkeep"))) {
		writeFileSync(join(bundleDir, ".gitkeep"), "");
	}
	console.log("[pack-dsh-runtime] --lite：随包目录留空（已清理旧产物），安装走在线/手动导入");
} else {
	copyFileSync(archivePath, join(bundleDir, archiveName));
	// 随包这份 manifest 必须带真实 sha256：应用端用它校验归档完整性。
	writeFileSync(
		join(bundleDir, "manifest.json"),
		JSON.stringify({ ...manifest, archiveSha256: sha256 }, null, 2),
	);
	console.log("[pack-dsh-runtime] 随包目录:", bundleDir, "（拷进 resources/ 即可离线安装）");
}

console.log("[pack-dsh-runtime] 产出:", archivePath);
console.log("[pack-dsh-runtime] 本地索引:", indexPath, "（可直接用于安装链路验证）");
console.log("[pack-dsh-runtime] 压缩后:", mb(finalSize), `（压缩率 ${((1 - finalSize / totalBytes) * 100).toFixed(0)}%）`);
console.log("[pack-dsh-runtime] sha256:", sha256);
console.log("[pack-dsh-runtime] 上传后，把下面这条写进 dsh-runtime-releases.json 的 releases 数组：");
console.log(
	JSON.stringify(
		{
			runtimeVersion: dshVersion,
			minAppVersion: manifest.minAppVersion,
			maxAppVersion: manifest.maxAppVersion,
			url: `<release asset url>/${archiveName}`,
			sha256,
			size: finalSize,
		},
		null,
		2,
	),
);
