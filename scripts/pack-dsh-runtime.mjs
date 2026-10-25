#!/usr/bin/env node
/**
 * 打包 DSH runtime 为按需下载的 tarball（AgentRuntimeProvider 阶段 2）。
 *
 *   node scripts/pack-dsh-runtime.mjs [--out <dir>] [--dry-run] [--lite|--full] [--if-missing]
 *
 * 默认 --lite：只产 tgz + 分平台索引，extraResources 目录只留 .gitkeep（官方安装包
 * 不随包 runtime，用户首次用 DSH 时从 AtomGit/GitHub latest 应用 Release 按需下载）。
 * --full 才把归档拷进 extraResources（内网离线 / 自测用）。
 *
 * 产出：<out>/dsh-runtime-<platform>-<arch>.tgz 与
 *       <out>/dsh-runtime-<platform>-<arch>-releases.json，内部结构固定为
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
 *    归档内容会自相矛盾（填了哈希 → 内容变了 → 哈希失效）。校验用的真实哈希
 *    写在归档外随包的 manifest.json（dist-runtime/dsh-runtime/manifest.json）里，
 *    由应用端 `readBundledRuntime` 读取并校验；归档内的 archiveSha256 留空。
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
 *
 * ── 交叉解析模式（--target-os/--target-arch，2026-09 新增）──────────────
 *
 * 原模式（默认）：从项目 node_modules 收集闭包 → 只能产出本机平台归档，
 * 因此 CI 需要 5 个原生 runner + post-release-sidecars 补 2 个平台。
 *
 * 新模式（--target-os=<os> --target-arch=<arch>）：从 package-lock.json 遍历闭包
 * （dshRuntimeLockClosure.mjs），把每个包的 lock 精确版本写进临时 package.json，
 * 在隔离目录 `npm install --os --cpu --libc --ignore-scripts` 交叉解析出目标平台
 * 完整树，再走与原模式相同的闭包收集/裁剪/打包。
 *
 * 可行性根因：所有原生依赖都以 prebuild 分发（node-pty tarball 自带全平台
 * prebuilds；koffi=@koromix/koffi-*、sharp=@img/sharp-*、rg=@vscode/ripgrep-*），
 * 无一需要本机编译；2026-09-18 实证（WSL 真机 boot 通过）。
 *
 * 两个必须的防御：
 * 1. **libc 显式化**：linux 平台包（@img/sharp-linux-x64 等）声明 libc:["glibc"]，
 *    npm 在非 Linux 宿主上检测不到 libc 会把它们静默过滤掉（只剩 wasm32 兜底）。
 *    所以 linux 目标缺省强制 glibc，并在归档校验里断言原生包在位（check-dsh-asar）。
 * 2. **版本钉死**：临时 package.json 用 lock 精确版本，防 ^0.1.5-rc.1 对 prerelease
 *    的 caret 语义漂移到 rc.2（实测 230/240 包漂移）。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
// 裁剪规则独立成模块：CLI 主流程不便 import（会触发打包），测试直接引用规则单测。
import { allEntryCandidates, isExcluded, isNpmHashedLeftoverDir, isSrcPrunable, runtimeEntryResolvableOnDisk } from "./runtime-prune-rules.mjs";
import { collectLockClosure, isPlatformGatedEntry, npmPlatformArgs, normalizeTarget, pinnedDependenciesFromClosure } from "./dshRuntimeLockClosure.mjs";
// 本地包构建的 cwd/命令构造同样独立成模块（交叉模式下符号链接导致 npm 找不到 tsc）。
import { localPackageBuildInvocation } from "./local-package-build.mjs";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 归档内顶层目录名（与 shared/types/dshRuntimeManifest.DSH_RUNTIME_ARCHIVE_ROOT 一致）。 */
const ARCHIVE_ROOT = "dsh-runtime";
/** 随包资源目录名（与 main/dsh/runtime/DshRuntimeManager.DSH_BUNDLED_RUNTIME_DIRNAME 一致）。 */
const DSH_BUNDLED_DIRNAME = "dsh-runtime";

const PLATFORM_NATIVE = process.platform;
const ARCH_NATIVE = process.arch;

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

/** 读 CLI 选项值（--name value 形式；缺省返回 undefined）。 */
function argValue(name) {
	const index = argv.indexOf(name);
	return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * 交叉解析模式：--target-os/--target-arch 任一出现即启用。
 * 两个参数必须成对出现（只给一个 platform 就是语义不完整，直接报错）。
 */
const targetRequested = argv.includes("--target-os") || argv.includes("--target-arch");
let target = null;
if (targetRequested) {
	const normalized = normalizeTarget({
		os: argValue("--target-os"),
		arch: argValue("--target-arch"),
		libc: argValue("--target-libc"),
	});
	if (normalized.error) {
		console.error(`[pack-dsh-runtime] ${normalized.error}`);
		process.exit(1);
	}
	target = normalized;
}
/**
 * 官方默认 lite：不把 runtime 打进 extraResources。
 * --full 才拷进随包目录；--lite 显式传入时与默认等价（兼容旧脚本/文档）。
 * --full 与 --lite 同时出现时 --full 赢——维护者想打离线包时不应被默认 lite 挡掉。
 */
const lite = !argv.includes("--full");
/** --if-missing：tgz 已存在就跳过（给快速打包链路用，避免每次都重打 20 秒）。 */
const ifMissing = argv.includes("--if-missing");
const outIndex = argv.indexOf("--out");
const outDir = outIndex >= 0 ? resolve(argv[outIndex + 1]) : join(projectRoot, "dist-runtime");

/**
 * lite 包必须把 extraResources 清成只剩 .gitkeep。
 * dist:fast 的 --if-missing 跳过重打时也要走这一步，否则本地残留的 --full tgz/manifest
 * 会被 electron-builder 打进安装包，「安装包不随 runtime」被静默摧掉。
 */
function ensureLiteExtraResources(bundleDir) {
	mkdirSync(bundleDir, { recursive: true });
	if (existsSync(bundleDir)) {
		for (const name of readdirSync(bundleDir)) {
			if (name !== ".gitkeep") rmSync(join(bundleDir, name), { recursive: true, force: true });
		}
	}
	// 只在文件不存在时创建占位（首次检出/目录被删场景）；已在版本库里的 .gitkeep
	// 带说明注释，绝不能被每次打包清空——否则 git 工作区永远显示它被修改（diff 噪声）。
	if (!existsSync(join(bundleDir, ".gitkeep"))) {
		writeFileSync(join(bundleDir, ".gitkeep"), "");
	}
}

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

/**
 * 作用域外的种子：dsh-bill 不在 @deepseek-ai 下，但 hostEntry 会
 * `require.resolve` 它（用量计费插件），缺了 host 起不来。
 * 提前到交叉解析之前声明：lock 闭包遍历与临时 package.json 都要用它。
 */
const EXTRA_SEED_NAMES = ["dsh-bill"];

/**
 * 判断包目录是否为 file: 本地依赖的 symlink（npm 7+ 对 file:/workspace: 建链）。
 * 真实路径与 node_modules 内路径不一致即视为本地包。
 */
function isSymlinkedLocalPackage(dir) {
	try {
		return realpathSync(dir) !== resolve(dir);
	} catch {
		return false;
	}
}

/**
 * 闭包入口预检（file: 本地包未构建防护）。
 *
 * 事故背景（2026-09 v0.7.5 sidecar）：当时的 file: 本地包 dsh-tool-pwsh-persistent
 * 的 lib/ 是 gitignore 的构建产物——全新检出上 npm ci 只把包以链接形式挂进
 * node_modules，源码-only 的包被原样打进归档，host 启动时 require.resolve
 * 命中不存在的 lib/index.js 即崩。该类包现已下线，但 file: 本地包随时可能再加，
 * 护栏保留。
 * check-dsh-asar 只守护 CI 上传链路，手动 pack/upload 会绕过——所以打包前必须
 * 在磁盘上把每个闭包包运行时入口钉死。
 *
 * 规则：入口缺失且包带 build 脚本 → 自动执行构建后复检；仍缺失（或无构建脚本）
 * → 报错退出。宁可打包失败，也不产出 host 起不来的归档。
 * 判定语义与 check-dsh-asar 一致：main + exports["."] 运行时条件里
 * 「至少一个可解析」即通过（个别上游包 exports 指向从未发布的文件，见该脚本注释）。
 */
function ensureClosureEntriesBuilt(closureDirs) {
	for (const dir of closureDirs) {
		const pkg = readPackageJson(dir);
		if (!pkg || String(pkg.name ?? "").startsWith("@types/")) continue;
		const entries = allEntryCandidates(dir);
		if (entries.length === 0) continue; // 无运行时入口的包无需校验
		if (entries.some((entry) => runtimeEntryResolvableOnDisk(dir, entry))) continue;
		const rel = relative(nodeModulesRoot, dir);
		// 自动构建只对 file: 本地包（symlink 到仓库内源码目录）生效：全新检出下
		// lib/ 等编译产物不存在是这类包的真实风险（2026-09 dsh-tool-pwsh-persistent
		// 缺 lib/index.js 事故）。registry 包一律不自动构建——dist/ 已存在但
		// exports["."] 指不存在文件（子路径导出包）更常见，跑构建既慢又炸流程，
		// 直接报错交给人判断。
		if (isSymlinkedLocalPackage(dir) && typeof pkg.scripts?.build === "string") {
			console.warn(`[pack-dsh-runtime] ⚠️ ${rel}: 运行时入口缺失（${entries.join(", ")}），自动执行 npm run build...`);
			// 构建调用交给 local-package-build.mjs（cwd 用真实路径）：交叉模式下 dir 是
			// 临时工作区里的符号链接，按逻辑路径 npm 找不到仓库工具链（tsc），原因见该模块注释。
			const build = localPackageBuildInvocation(dir);
			execFileSync(build.command, build.args, { cwd: build.cwd, stdio: "inherit" });
			if (entries.some((entry) => runtimeEntryResolvableOnDisk(dir, entry))) continue;
			console.error(`[pack-dsh-runtime] ❌ ${rel}: npm run build 后入口仍缺失（${entries.join(", ")}），中止打包。`);
			process.exit(1);
		}
		console.error(`[pack-dsh-runtime] ❌ ${rel}: 运行时入口全部不可解析（${entries.join(", ")}），中止打包。\n` + `   file: 本地包请先构建（npm run build）；registry 包可能是子路径导出包（exports["."] 指向未发布文件），\n` + `   请确认该包确为 dsh 运行所需后手动处理（补文件或从闭包剔除），再重试。`);
		process.exit(1);
	}
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

/**
 * 归档命名与平台三元组：
 * - 默认模式：本机平台（兼容旧行为，runtime:pack 在构建机原地产出）。
 * - 交叉模式：--target-* 指定平台，闭包源是临时目录的 npm 交叉解析结果。
 */
const PLATFORM = target?.os ?? PLATFORM_NATIVE;
const ARCH = target?.arch ?? ARCH_NATIVE;
const LIBC = target?.libc ?? "";

/**
 * 交叉解析的隔离工作区（node_modules + 临时 package.json）。
 * mkdtemp 保证多次运行不互相污染；失败路径里 rmSync 清理。
 */
let crossWorkspace = null;

function cleanupCrossWorkspace() {
	if (!crossWorkspace) return;
	try {
		rmSync(crossWorkspace, { recursive: true, force: true });
	} catch {
		// Windows 上文件可能被杀软短暂锁住；残留目录交给下次 mkdtemp 不冲突
	}
	crossWorkspace = null;
}

/**
 * 交叉解析出目标平台的闭包树，返回作为闭包收集源的 node_modules 根目录。
 * 在默认模式下直接返回项目 node_modules（零行为变化）。
 */
function resolveClosureNodeModulesRoot() {
	if (!target) {
		// 默认模式保留原校验：项目 node_modules 必须先 npm install。
		if (!existsSync(join(nodeModulesRoot, "@deepseek-ai"))) {
			console.error("[pack-dsh-runtime] node_modules/@deepseek-ai 不存在，请先 npm install");
			process.exit(1);
		}
		return nodeModulesRoot;
	}

	const lockPath = join(projectRoot, "package-lock.json");
	if (!existsSync(lockPath)) {
		console.error("[pack-dsh-runtime] 交叉模式需要 package-lock.json（闭包遍历与版本钉死的数据源）");
		process.exit(1);
	}
	const lockPackages = JSON.parse(readFileSync(lockPath, "utf8")).packages ?? {};

	/** 种子：@deepseek-ai 作用域全集 + 两个作用域外种子（与磁盘模式同一份数据源）。 */
	const scopeNames = Object.keys(lockPackages)
		.filter((key) => /^node_modules\/(@deepseek-ai\/[^/]+)$/.test(key))
		.map((key) => key.slice("node_modules/".length));
	const seedNames = [...scopeNames, ...EXTRA_SEED_NAMES];

	const { keys, versions, multiVersion } = collectLockClosure(lockPackages, seedNames);
	console.log(`[pack-dsh-runtime] lock 闭包: ${keys.length} 条目 / ${versions.size} 个包名` + (multiVersion.size > 0 ? `（同名多版本 ${multiVersion.size}，次要版本由 npm 嵌套落位）` : ""));

	const missingSeeds = ["@deepseek-ai/dsh", "dsh-bill"].filter((name) => !versions.has(name));
	if (missingSeeds.length > 0) {
		console.error(`[pack-dsh-runtime] lock 里找不到种子包：${missingSeeds.join(", ")}（package.json 与 package-lock.json 不同步？先 npm install）`);
		process.exit(1);
	}
	// file: 本地包在 lock 里是 link 条目，没有版本号；
	// 只要仓库内 packages/ 目录存在且已构建（入口预检会验）就算种子在位。
	for (const name of EXTRA_SEED_NAMES) {
		const entry = lockPackages[`node_modules/${name}`];
		if (entry?.link && typeof entry.resolved === "string") {
			if (!existsSync(join(projectRoot, entry.resolved, "package.json"))) {
				console.error(`[pack-dsh-runtime] file: 本地包目录缺失：${entry.resolved}`);
				process.exit(1);
			}
		}
	}

	// 临时 package.json：闭包内每个包用 lock 精确版本钉死，从根上防 ^prerelease 漂移。
	// 平台专有包（os/cpu/libc 门控，如 @img/sharp-*、@koromix/koffi-*、
	// @deepseek-ai/node-addon-system-*）必须写进 optionalDependencies：它们在
	// lock/registry 里就是 optional，写成 dependencies 会让 npm 在非目标平台报
	// notsup 硬错误退出（2026-09-18 实证），optional 下则正确跳过并留给目标平台。
	const deps = pinnedDependenciesFromClosure(versions);
	const optionalDeps = {};
	for (const key of keys) {
		const entry = lockPackages[key];
		if (!isPlatformGatedEntry(entry)) continue;
		// 提取包名：key 形如 node_modules/<scope>/<name> 或 …/pkg/node_modules/<name>。
		// 注意用 /node_modules/ 带前导斜杠的分隔符只能命中嵌套段；顶层 key 以
		// node_modules/ 开头（前面没有斜杠），必须单独剥前缀，否则 name 拿到的是
		// 整条 key，versions.has 必然 false → 平台包全部漏进 dependencies（EBADPLATFORM）。
		const name = key
			.replace(/^node_modules\//, "")
			.split("/node_modules/")
			.at(-1);
		if (!name || !versions.has(name)) continue;
		// 同名多版本的次要版本会被顶层版本覆盖：optional 表只留顶层版本。
		optionalDeps[name] = versions.get(name);
		delete deps[name];
	}
	// file: 本地包不在 registry，不能写版本号——必须继续走仓库内源码目录，否则
	// npm install 直接报 No matching version。file: 相对路径以 workdir 为基准，
	// 所以这里写成指向仓库内 packages/ 的绝对路径（跨盘/跨目录都稳）。
	for (const name of EXTRA_SEED_NAMES) {
		const entry = lockPackages[`node_modules/${name}`];
		if (entry?.link && typeof entry.resolved === "string") {
			deps[name] = `file:${resolve(join(projectRoot, entry.resolved)).split(sep).join("/")}`;
			delete optionalDeps[name];
		}
	}

	crossWorkspace = mkdtempSync(join(tmpdir(), "dsh-cross-"));
	const workNodeModules = join(crossWorkspace, "node_modules");
	const workPackageJson = {
		name: "dsh-runtime-cross",
		private: true,
		version: "0.0.0",
		dependencies: deps,
		// 空对象在 npm 里表示「无 optional 依赖」，写出去便于诊断（直接看 workdir）。
		optionalDependencies: Object.keys(optionalDeps).length > 0 ? optionalDeps : {},
	};
	writeFileSync(join(crossWorkspace, "package.json"), `${JSON.stringify(workPackageJson, null, 2)}\n`);
	console.log(`[pack-dsh-runtime] 临时 package.json: ${Object.keys(deps).length} 硬依赖 + ${Object.keys(optionalDeps).length} 平台 optional`);

	console.log(`[pack-dsh-runtime] 交叉解析: ${target.os}-${target.arch}` + (target.libc ? ` libc=${target.libc}` : "") + ` （${keys.length} 个 lock 条目，--ignore-scripts）`);
	// 交叉解析只下 prebuild 与 JS，不需要任何 install 脚本；--ignore-scripts 同时
	// 是供应链面收窄（不在用户机上跑第三方 postinstall）。
	// ⚠不要加 --prefer-offline：共享缓存 node_modules/.cache/dsh-cross-npm 可能留着
	// 上一个 dsh 大版本（0.1.5-rc.1）抓的 packument，--prefer-offline 会在 TTL 内直接信任
	// 过期元数据而不 revalidate。2026-09-30 实证：缓存里 @deepseek-ai/cosmokit 的 packument
	// 停更在 1.8.3，dsh 0.2.0-rc.2 要求 ~1.8.5 → npm 报 ETARGET/cosmokit，同时把
	// dsh-agent-preset 的 peer cordis 报成「cordis@undefined」的 ERESOLVE（误导性极强，
	// 实际与版本无关）。默认行为会 revalidate 元数据（缓存命中时 <1s）且 tarball 仍走缓存。
	const npmArgs = ["install", "--no-audit", "--no-fund", ...npmPlatformArgs(target), "--cache", resolve(join(projectRoot, "node_modules/.cache/dsh-cross-npm"))];
	try {
		execFileSync("npm", npmArgs, { cwd: crossWorkspace, stdio: "inherit", shell: process.platform === "win32" });
	} catch (error) {
		cleanupCrossWorkspace();
		console.error(`[pack-dsh-runtime] 交叉解析失败（npm install ${target.os}-${target.arch}）：${error.message}`);
		process.exit(1);
	}
	if (!existsSync(workNodeModules)) {
		cleanupCrossWorkspace();
		console.error("[pack-dsh-runtime] 交叉解析未产出 node_modules（npm install 静默失败）");
		process.exit(1);
	}
	return workNodeModules;
}

/** 成功路径的收尾：打包完成后清交叉工作区（失败路径在各 exit 前已清）。 */
process.on("exit", () => cleanupCrossWorkspace());
// Ctrl+C / kill 也要清：mkdtemp 的临时目录带 220MB node_modules，不清会堆积。
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		cleanupCrossWorkspace();
		process.exit(1);
	});
}

const closureNodeModulesRoot = resolveClosureNodeModulesRoot();
const dshScopeDir = join(closureNodeModulesRoot, "@deepseek-ai");
if (!existsSync(dshScopeDir)) {
	cleanupCrossWorkspace();
	console.error(`[pack-dsh-runtime] 闭包源里没有 @deepseek-ai 作用域：${dshScopeDir}`);
	process.exit(1);
}
// runtimeVersion 取 dsh 包版本。交叉模式下临时 package.json 用的是 lock 精确版本，
// 安装结果与磁盘模式同构，两种模式都从装好的 dsh/package.json 读。
const dshVersion = readPackageJson(join(dshScopeDir, "dsh")).version;
const appVersion = appPackage.version;

/**
 * --if-missing：tgz 已在 outDir 就跳过闭包扫描。官方默认 lite，extraResources
 * 目录只留 .gitkeep——不能再看 bundleDir/manifest.json，否则本地残留的 --full
 * 产物会被当成「已齐备」直接打进安装包。
 * 不比对内容哈希：依赖变了需要手动删 dist-runtime/ 重打。
 * 放在交叉解析之后：命中跳过时也要先把交叉工作区清掉再退出。
 */
if (ifMissing) {
	const archiveName = `dsh-runtime-${PLATFORM}-${ARCH}.tgz`;
	const archivePath = join(outDir, archiveName);
	const indexPath = join(outDir, `dsh-runtime-${PLATFORM}-${ARCH}-releases.json`);
	const bundleDir = join(outDir, DSH_BUNDLED_DIRNAME);
	if (lite) {
		// lite：只看 outDir 的 tgz+索引。跳过重打也必须清 extraResources，
		// 否则 dist:fast 会把上次 --full 残留打进安装包。
		if (existsSync(archivePath) && existsSync(indexPath)) {
			cleanupCrossWorkspace();
			ensureLiteExtraResources(bundleDir);
			console.log("[pack-dsh-runtime] --if-missing：归档与索引已存在，跳过（已清 extraResources）");
			process.exit(0);
		}
	} else if (existsSync(join(bundleDir, "manifest.json")) && existsSync(join(bundleDir, archiveName))) {
		cleanupCrossWorkspace();
		console.log("[pack-dsh-runtime] --if-missing：随包 runtime 已存在，跳过");
		process.exit(0);
	}
}

const seedDirs = [
	...readdirSync(dshScopeDir)
		.filter((name) => !isNpmHashedLeftoverDir(name))
		.map((name) => join(dshScopeDir, name))
		.filter((dir) => existsSync(join(dir, "package.json"))),
	...EXTRA_SEED_NAMES.map((name) => join(closureNodeModulesRoot, name)).filter((dir) => existsSync(join(dir, "package.json"))),
];

// 随 app 分发的包不在 runtime 里重复带（electron-builder 已打进 asar，装完也用得上）。
// @deepseek-ai 作用域例外：依赖分区后它们会从 app 依赖里移走，必须自带。
//
// ⚠️ 2026-08 生产事故：这里曾用 appOwnDeps 过滤掉「同时是 app 依赖」的闭包包
// （@earendil-works/pi-ai、node-pty），但 host 的模块解析锚点只有 runtime
// node_modules（见文件头说明），app.asar 里的副本 host 根本看不见——
// 结果 runtime 里留下一个没有 package.json/index.js 的空壳 pi-ai，
// dsh-llm-pi-ai 加载即崩（host exit 1）。runtime 必须自包含，不再做此裁剪。
const closure = collectClosure(seedDirs).filter((dir) => {
	const base = dir.split(/[/\\]/).pop() ?? "";
	// leftover 仍有 package.json，不能只凭名字当活包；种子过滤漏掉时这里再拦一道。
	return Boolean(packageNameOf(dir)) && !isNpmHashedLeftoverDir(base);
});
const closureSet = new Set(closure);

// 入口预检必须发生在文件收集之前：自动构建产生的 lib/ 产物要能进入归档。
ensureClosureEntriesBuilt(closure);

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
				// 嵌套 leftover（npm 升级残留）即使不在种子里也会被父包 walk 扫到，必须跳过。
				if (isNpmHashedLeftoverDir(entry.name) || closureSet.has(full)) continue;
				walk(full, base);
				continue;
			}
			const rel = relative(base, full).split(sep).join("/");
			const size = statSync(full).size;
			if (isExcluded(rel, base, srcPrunable, PLATFORM)) prunedBytes += size;
			else files.push({ abs: full, relInClosure: relative(closureNodeModulesRoot, full) });
		}
	};
	walk(dir, dir);
}

const totalBytes = files.reduce((sum, f) => sum + statSync(f.abs).size, 0);

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
	// Typert Remote 契约（见 docs/dsh-remote-contract.md）：
	// dsh-host-apiproxy 已废，fetch 半在 dsh-client-connection，网关在
	// dsh-api-gateway（base 补丁自带），领域端点在 dsh-api-session-controller。
	requiredPackages: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-app-boot", "@deepseek-ai/dsh-cmdline", "@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-api-gateway", "@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-api-session-controller"],
	packageCount: closure.length,
};

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)}MB`;
console.log("[pack-dsh-runtime] 平台:", `${PLATFORM}-${ARCH}${LIBC ? `-${LIBC}` : ""}${target ? "（交叉解析）" : "（本机）"}`);
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
// 归档临时 manifest 写进闭包源 node_modules（与 tar 的 cwd 同根）：默认模式是项目
// node_modules，交叉模式是临时工作区——后者随 cleanupCrossWorkspace 一起回收。
const manifestTmp = join(closureNodeModulesRoot, MANIFEST_TMP_NAME);
writeFileSync(manifestTmp, JSON.stringify(manifest, null, 2));

try {
	await tar.c(
		{
			gzip: { level: 9 },
			file: archivePath,
			cwd: closureNodeModulesRoot,
			portable: true,
			onWriteEntry: (entry) => {
				// 条目统一带 "./" 传入（规避 tar 对 "@" 开头路径的特殊解释——
				// 作用域包 @deepseek-ai/x 会被吃掉 "@" 变成 deepseek-ai/x），
				// 这里把前缀去掉再拼归档内的目标路径。
				const rel = entry.path.replace(/^\.\//, "");
				// relInClosure 是相对 node_modules 的路径（不含 node_modules 段），
				// 这里补回来：归档内必须是 dsh-runtime/node_modules/<pkg>/... ，
				// 与 DshRuntimeManager 解压后的期望布局一致。
				entry.path = rel === MANIFEST_TMP_NAME ? `${ARCHIVE_ROOT}/manifest.json` : `${ARCHIVE_ROOT}/node_modules/${rel}`;
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
	ensureLiteExtraResources(bundleDir);
	console.log("[pack-dsh-runtime] --lite：随包目录留空（已清理旧产物），安装走在线/手动导入");
} else {
	copyFileSync(archivePath, join(bundleDir, archiveName));
	// 随包这份 manifest 必须带真实 sha256：应用端用它校验归档完整性。
	writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify({ ...manifest, archiveSha256: sha256 }, null, 2));
	console.log("[pack-dsh-runtime] 随包目录:", bundleDir, "（拷进 resources/ 即可离线安装）");
}

/**
 * 分平台索引：挂到当前 latest 应用 Release（vX.Y.Z），禁止独立 dsh-runtime tag
 *（会抢走 GitHub /releases/latest）。url 先写归档文件名占位，客户端按
 * updateSource 改写为 AtomGit/GitHub latest 资产地址。CI 各平台 job 各写一份，
 * 互不覆盖（win32-x64 不会把 darwin-arm64 的索引冲掉）。
 */
const indexPath = join(outDir, `dsh-runtime-${PLATFORM}-${ARCH}-releases.json`);
writeFileSync(
	indexPath,
	`${JSON.stringify(
		{
			schemaVersion: 1,
			releases: [
				{
					runtimeVersion: dshVersion,
					minAppVersion: appVersion,
					maxAppVersion: "",
					url: archiveName,
					sha256,
					size: finalSize,
				},
			],
		},
		null,
		2,
	)}
`,
);
console.log("[pack-dsh-runtime] 索引:", indexPath);

console.log("[pack-dsh-runtime] 产出:", archivePath);
console.log("[pack-dsh-runtime] 压缩后:", mb(finalSize), `（压缩率 ${((1 - finalSize / totalBytes) * 100).toFixed(0)}%）`);
console.log("[pack-dsh-runtime] sha256:", sha256);
console.log("[pack-dsh-runtime] 上传到当前 latest 应用 Release（vX.Y.Z）后客户端即可按需下载");
