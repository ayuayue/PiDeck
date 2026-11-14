import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { app } from "electron";
import type { PiInstallationSource } from "../../../shared/types";
// 只依赖纯路径模块（零 Electron / 零副作用）：PiLocator 会在裸 Node 沙箱里被加载，
// 引入便携 Node 安装器会把 DSH 运行时依赖一并拖进来，把检测链路弄重。
import { piRuntimeNodeBinDir, piRuntimePiBinDir } from "../piRuntimePaths";
import { nvmNodeVersionDirs } from "../nvmNodeVersions";

/**
 * 候选搜索目录域（PiLocator 拆分第四刀）：搜索目录枚举、候选文件名、登录 shell PATH 预热。
 *
 * 顺序即解析优先级，任何重排都会静默改掉用户实际启动的 pi；`searchDirEntries` 的注释是
 * 逐个目录的现场结论（Homebrew/#318/#484/官方安装器/便携运行时），搬动时不要删。
 * 登录 shell PATH 是进程级缓存（含负缓存 ""），本模块单例持有，不做多份。
 */

// 登录 shell PATH 的进程级缓存（含负缓存 ""）。readLoginShellPath 曾同步
// execFileSync：每次定位 pi 都在主进程事件循环里跑 /bin/sh -lc，nvm/慢 shell
// 初始化数百毫秒起步，期间所有窗口输入与 IPC 整体冻结——与下方 WSL 探测
// 「禁止回到 execFileSync」注释（:815-825）同一教训，改为异步预热 + 只读缓存。
let cachedLoginShellPath: string | undefined;
let loginShellPathInflight: Promise<string> | undefined;

export function getSearchDirs() {
	// These directories only locate an existing pi installation; pi itself is not bundled yet.
	return [...new Set(searchDirEntries().map((entry) => entry.dir))];
}

/**
 * 扫描目录 + 来源标签。
 *
 * 顺序即解析优先级（resolveCommand / getCandidates 取第一个存在的候选），所以必须保持原有的
 * 「env PATH → 登录 shell PATH → 包管理器/版本管理器目录 → 平台兜底 → PiDeck 自带运行时」；
 * 唯一例外是 macOS 的 Homebrew 目录（排在 env PATH 之前，理由见 entries 首行的注释）；
 * 新增目录时应扦在同类群里，不要插到 PATH 前面（否则会静默改掉已有用户实际启动的 pi）。
 * 来源标签只用于「检测到多个安装」时的展示与排序（见 listInstallations）。
 */
export function searchDirEntries(): Array<{ dir: string; source: PiInstallationSource }> {
	const home = app.getPath("home");
	const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
	const localAppData = process.env.LOCALAPPDATA ?? join(home, "AppData", "Local");
	// mise 数据目录可被 MISE_DATA_DIR 覆盖（安装目录可再被 MISE_INSTALL_PATH 覆盖）。
	// 只扫硬编码默认目录会漏掉自定义安装（如 D:\mise-data），且非 Windows 默认是
	// ~/.local/share/mise 而非 AppData；npm 全局 bin（pi.cmd）默认就装在
	// <mise 数据目录>/installs/node/<version>/ 下，与 node.exe 同目录。
	const miseDataDir = process.env.MISE_DATA_DIR || (process.platform === "win32" ? join(localAppData, "mise") : join(home, ".local", "share", "mise"));
	const miseInstallsDir = process.env.MISE_INSTALL_PATH || join(miseDataDir, "installs");
	// pnpm 全局 bin：Linux 默认 ~/.local/share/pnpm（可被 PNPM_HOME 覆盖），
	// macOS 默认 ~/Library/pnpm，Windows 默认 %LOCALAPPDATA%\pnpm。
	// 官方推荐的 `pnpm add -g --ignore-scripts @earendil-works/pi-coding-agent` 就落在这里。
	const pnpmHome = process.env.PNPM_HOME || (process.platform === "win32" ? join(localAppData, "pnpm") : process.platform === "darwin" ? join(home, "Library", "pnpm") : join(home, ".local", "share", "pnpm"));
	const pkg = (dir: string) => ({ dir, source: "package-manager" as const });
	const plain = (dir: string) => ({ dir, source: "path" as const });
	const portable = (dir: string) => ({ dir, source: "portable" as const });
	// fnm（POSIX）：数据目录可被 FNM_DIR 整体覆盖；旧版默认 ~/.fnm，现代版按 XDG
	// （Linux ~/.local/share/fnm、macOS ~/Library/Application Support/fnm，也尊重 XDG_DATA_HOME）。
	// #318：fnm 装在非 ~/.fnm 布局时，GUI 启动的 PATH 拿不到这些目录，pi 反查不到、
	// 扩展版本检查（npm view）也会全部 ENOENT。多根都扫：listChildDirs 对不存在
	// 的目录返回空集，代价可忽略。Windows 布局（node-versions/<ver>/installation 无 bin 层）
	// 保留在下方 win32 分支，默认目录已被覆盖，FNM_DIR 覆盖场景暂无反馈不扩。
	const fnmRoots = [...(process.env.FNM_DIR ? [process.env.FNM_DIR] : []), join(home, ".fnm"), join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "fnm"), ...(process.platform === "darwin" ? [join(home, "Library", "Application Support", "fnm")] : [])];
	const fnmEntries = process.platform === "win32" ? [] : fnmRoots.flatMap((root) => [plain(join(root, "current", "bin")), ...listChildDirs(join(root, "node-versions")).map((dir) => plain(join(dir, "installation", "bin")))]);
	const entries = [
		// #484：macOS 上 Homebrew 目录必须排在 env PATH 之前。GUI 启动（Dock/Finder）的 PATH 来自
		// /etc/paths，固定且常过期——典型是官方 pkg 装的 node 落在 /usr/local/bin，而 Apple Silicon 的
		// Homebrew 在 /opt/homebrew（不在 /etc/paths，只能靠本项补上）。pi 的 POSIX 垫片是
		// `#!/usr/bin/env node`，PATH 顺序直接决定它拿到哪个 node：排在最后时 `env node` 命中旧 node，
		// pi 一早崩在缺 API 上（老版本 node 22 无 zlib.createZstdDecompress），终端里正常、桌面端起不来。
		// Intel 的 Homebrew 目录就是 /usr/local/bin，通常已是 /etc/paths 首项，此调整无行为变化。
		// 版本管理器目录不在本项：已由上方 fnmEntries / nvm 分支统一覆盖（FNM_DIR/XDG 布局）。
		...(process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"].map(plain) : []),
		...pathDirs().map(plain),
		pkg(join(appData, "npm")),
		// pnpm：PNPM_HOME / 平台默认目录 + Windows 的 %LOCALAPPDATA%\pnpm
		pkg(pnpmHome),
		pkg(join(localAppData, "pnpm")),
		// yarn：classic 的全局 bin 在不同平台分别是 ~/.yarn/bin、~/.config/yarn/global/bin；
		// Windows 的 %LOCALAPPDATA%\Yarn\bin 已由下一行覆盖。
		pkg(join(home, ".yarn", "bin")),
		pkg(join(home, ".config", "yarn", "global", "bin")),
		pkg(join(localAppData, "Yarn", "bin")),
		pkg(join(localAppData, "Volta", "bin")),
		pkg(join(miseDataDir, "shims")),
		...listChildDirs(join(miseInstallsDir, "node")).map(pkg),
		// Windows fnm：node 与 npm 全局 bin（pi.cmd）同在
		// %LOCALAPPDATA%\fnm\node-versions\<ver>\installation，macOS 分支已有等价兜底。
		// Scoop：shims 目录放 scoop 装的 app shim；nodejs 的 npm prefix 默认是
		// apps\nodejs\current（全局包装在该目录，node.exe 同目录）。
		...(process.platform === "win32" ? [...listChildDirs(join(localAppData, "fnm", "node-versions")).map((dir) => join(dir, "installation")), join(home, "scoop", "shims"), join(home, "scoop", "apps", "nodejs", "current")].map(pkg) : []),
		pkg(join(home, ".bun", "bin")),
		pkg(join(home, ".deno", "bin")),
		plain(join(home, ".local", "bin")),
		pkg(join(home, ".npm-global", "bin")),
		pkg(join(home, ".nvm", "current", "bin")),
		...nvmNodeVersionDirs(join(home, ".nvm")).map((dir) => pkg(join(dir, "bin"))),
		...fnmEntries,
		pkg(join(home, ".asdf", "shims")),
		pkg(join(home, ".volta", "bin")),
		// pi 官方安装器（install.sh；Windows 下 install.ps1 需 PI_EXPERIMENTAL=1）的启动器落点。
		//
		// 为什么必须扫：安装器只把 PATH 写进当前 shell 的 rc（bash → ~/.bashrc），
		// 非交互登录 shell 读不到，GUI 启动的 PiDeck 不扫这里就会把「终端里明明有 pi」
		// 判成没装，进而引导用户又装一份 npm 全局副本。入口也可能是 ~/.local/bin 里
		// 指向该启动器的软链（安装器 select_managed_path_bin_dir），那条已在上面扫到。
		//
		// 为什么排在版本管理器目录之后：它只在其他候选都没命中时才生效，
		// 避免静默改掉已有用户实际启动的 pi（换装走设置页/安装列表让用户自己选）。
		// 来源不在这里标 managed：只有 managed-install.json 校验通过才算官方安装
		// （见 classifyInstallationSource），残留/半删的目录不应被宣称成官方安装。
		plain(join(home, ".pi", "agent", "bin")),
		// Linux 常见全局 bin，同样覆盖“桌面启动 PATH 不完整”的场景。
		...(process.platform === "linux" ? ["/usr/local/bin", "/usr/bin"].map(plain) : []),
		// PiDeck 自带引导装的便携 Node/pi 全局目录（<userData>/pi-runtime）：
		// 引导安装不写系统 PATH，装完 pi 可执行落在这两个目录，必须自行扫描。
		//
		// 注意 1：POSIX 比 Windows 多一层 bin/（npm 全局可执行在 <prefix>/bin，Windows 才直接在 <prefix>；
		// 官方 node 包同理 bin/node vs node.exe）。少这一层会导致
		// 「引导装完 -> 重新检测说没装 -> 又引导你再装一遍」。
		// 注意 2：只看当前 userData——dev 与正式版各管自己的 pi-runtime，不做跨数据目录互扫（产品决定）。
		plain(piRuntimeNodeBinDir(app.getPath("userData"), process.platform)),
		portable(piRuntimePiBinDir(app.getPath("userData"), process.platform)),
	];
	return entries.filter((entry) => Boolean(entry.dir));
}

export function getCandidates() {
	// Windows 不再自动检测 pi.ps1：PowerShell shim 与 .cmd 指向同一入口，但执行策略/编码/引号规则更复杂。
	// Linux 另追加 pi.js/pi.mjs/pi.cjs：部分用户通过 alias "node /path/pi.js" 直接运行 JS 源文件而非
	// npm 装出的 shim（#169）；pi 排在前，存在标准 shim 时仍优先命中，不会被同名 JS 误拦。
	const names = process.platform === "win32" ? ["pi.cmd", "pi.exe", "pi"] : ["pi", "pi.js", "pi.mjs", "pi.cjs"];
	return getSearchDirs().flatMap((dir) => names.map((name) => join(dir, name)));
}

function pathDirs() {
	const fromEnv = process.env.PATH ?? process.env.Path ?? "";
	// 只读缓存；未预热时本次仅用 env PATH（不阻塞），同时后台补热，
	// 下次 spawn / 状态检测即拿到登录 shell 目录。绝不允许回到同步 execFileSync。
	if (cachedLoginShellPath === undefined) void warmLoginShellPath();
	const fromShell = cachedLoginShellPath ?? "";
	return [...fromEnv.split(delimiter), ...fromShell.split(delimiter)].filter(Boolean);
}

/** 异步预热登录 shell PATH（win32 恒空）。结果（含失败负缓存 ""）进程级缓存。 */
export async function warmLoginShellPath(): Promise<string> {
	if (process.platform === "win32") {
		// Windows 检测链路不依赖 PowerShell/登录 shell：Explorer 启动的 Electron
		// 已拿到系统合并 PATH，其他包管理器路径由 getSearchDirs 与手动输入兜底。
		return "";
	}
	if (cachedLoginShellPath !== undefined) return cachedLoginShellPath;
	if (loginShellPathInflight) return loginShellPathInflight;
	const task = new Promise<string>((resolve) => {
		execFile("/bin/sh", ["-lc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 3000 }, (error, stdout) => {
			// 失败（超时/无 sh）负缓存 ""：与旧 catch 行为一致，仅退化到 env PATH。
			cachedLoginShellPath = error ? "" : String(stdout).trim();
			loginShellPathInflight = undefined;
			resolve(cachedLoginShellPath);
		});
	});
	loginShellPathInflight = task;
	return task;
}

function listChildDirs(parent: string) {
	try {
		return readdirSync(parent, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(parent, entry.name));
	} catch {
		return [];
	}
}
