import { posix, win32 } from "node:path";

/**
 * pi 自更新的「更新通道」判定（纯函数：零 Electron / 零磁盘依赖，可裸 Node 单测）。
 *
 * 为什么需要分派：`pi update --self` 并非对所有安装形态都可用——
 * - **bun 全局安装**（`bun install -g @earendil-works/pi-coding-agent`）：pi 在 Windows 上
 *   只支持 npm/pnpm 自更新（pi `package-manager-cli.js` 的 installMethod gate），bun 形态
 *   直接报错退出。需要 PiDeck 代跑 `bun install -g`（参数与 pi 自身 bun 分支一致：
 *   `--ignore-scripts --minimum-release-age=0`）。
 * - **旧引导前缀副本**（2026-10 之前的引导用 `npm install -g --prefix=<userData>/pi-runtime/pi-global`）：
 *   pi 的 npm 自更新只在 POSIX 按 `lib/node_modules` 形状推断前缀，Windows 显式不推断
 *   （pi `getInferredNpmInstall` 的注释），`npm install -g` 会落到用户真实 npm 全局目录，
 *   前缀里的旧副本原地不动（表现为「更新成功但版本没变」）。需要带 `--prefix` 代跑 npm。
 * - 其余（npm/pnpm/yarn 全局、pi 官方 managed 安装、自定义路径、WSL）：pi 自己能正确
 *   自更新，保持 `pi update --self`。
 *
 * 判定依据是 pi **可执行文件路径的形状**（与 pi detectInstallMethod 同源的特征），而不是
 * PiLocator 的 source 标签：source 只区分 package-manager/portable，分不出 bun 与 npm。
 *
 * WSL 目标一律归 pi-self（内为 Linux 环境，pi 自己能自更新）：PiLocator 在运行时返回的是
 * 空格拼接的召唤命令（`wsl -d <distro> -u <user> <linux pi 路径>`，见 PiLocator 的 WSL 分支），
 * 不是 `wsl://` 标记；自定义路径还可能直接是 UNC 互操作路径（`\\wsl.localhost\<distro>\…`）。
 * 落入 bun 推导会让 PiDeck 拿**宿主**的包管理器去装 pi（装错机器）。
 *
 * 除判定外，这里也集中「该通道实际要跑什么 argv」的纯构造（npm/bun 全局安装参数）与 bun 版本探测的
 * 解析：代跑与失败提示共用同一条命令构造器，避免「代跑加了 flag、提示里还是旧命令」的漂移。
 */
export type PiSelfUpdateChannel =
	| { kind: "pi-self" }
	/**
	 * bun 全局安装：PiDeck 代跑 bun。`bunCommand` 是从 pi 入口推导出的 bun 本体绝对路径；
	 * 它不存在时（Homebrew/scoop 装的 bun 本体在别处）调用方必须回退裸 `bun` 交给 PATH 解析，
	 * 根目录不可识别时这里直接返回 `"bun"`。`bunInstallRoot` 是 shim 与全局包共同的根
	 * （`<root>/bin` 与 `<root>/install/global`），调用方须把它作为 `BUN_INSTALL` 传给子进程——
	 * GUI 启动的 PiDeck 拿不到用户 shell rc 里的 BUN_INSTALL，不传会让 bun 装到默认 `~/.bun`，
	 * 选中安装原地不动（自定义 BUN_INSTALL 的机器上表现为「装完版本没变」）。
	 */
	| { kind: "bun-global"; bunCommand: string; bunInstallRoot?: string }
	/** 旧引导前缀安装：PiDeck 带 --prefix 代跑 npm；prefixDir 即当初 --prefix 的值。 */
	| { kind: "portable-prefix"; prefixDir: string };

/** bun 布局特征：全局 shim/bin（`~/.bun/bin`）或其包目录（`…/install/global/node_modules`，软链解析后）。 */
const BUN_PATH_PATTERN = /[\\/]\.bun[\\/]|[\\/]install[\\/]global[\\/]node_modules[\\/]/;
/** 旧引导前缀布局：`<prefix>/pi.cmd`（Windows）或 `<prefix>/bin/pi`（POSIX），层级见 piRuntimePaths。 */
const PORTABLE_PREFIX_PATTERN = /^(.*?[\\/]pi-runtime[\\/]pi-global)(?:[\\/].*)?$/i;
/**
 * WSL 目标的两种 Windows 侧形态：
 * - 运行时召唤串：`wsl -d <distro> -u <user> <linux 路径>`（PiLocator.check 的返回值，也可能是
 *   `C:\Windows\System32\wsl.exe -d …`）；
 * - UNC 互操作路径：`\\wsl$\<distro>\…` / `\\wsl.localhost\<distro>\…`（自定义路径直接粘了发行版内路径）。
 * 两者都不是本地安装：应交回发行版内的 pi 自己更新，绝不能落到宿主包管理器。
 */
const WSL_TARGET_PATTERN = /^(?:.*[\\/])?wsl(?:\.exe)?\s+(?:-d|--distribution)\s|^\\\\wsl(?:\$|\.localhost)[\\/]/i;

/**
 * bun 安装根目录：`<root>/bin` 同时放 bun 本体与全局命令 shim。
 *
 * 两种可识别形态：
 * - `…/.bun/bin/pi`（官方安装器、多数用户的默认布局）；
 * - `…/install/global/node_modules/<pkg>/…`（软链解析出的真实包路径；BUN_INSTALL 自定义时根目录任意）。
 *
 * 为什么不能沿用「与 pi 入口同目录」：那个假设只对官方安装器成立。Homebrew / scoop 装的 bun
 * 本体在 /opt/homebrew/bin(bun) 或 scoop 目录，而全局 shim 仍写在 `~/.bun/bin`，同目录推导会指向
 * 不存在的文件（更新报 ENOENT——bun 用户报障的根因）；软链解析后的包路径更彻底——
 * `<pkg>/dist/bun` 永远不存在。根目录不可识别时返回 undefined，调用方回退裸 `bun`。
 */
function resolveBunInstallRoot(command: string): string | undefined {
	// 先认 `.bun` 段：它对两种形态都是正确的根（`…/.bun/install/global/…` 同时命中两条规则，取它更稳）。
	const dotBun = /^(.*?[\\/]\.bun)(?:[\\/]|$)/i.exec(command);
	if (dotBun) return dotBun[1];
	// 自定义 BUN_INSTALL：`<root>/install/global/node_modules/…` 的 `<root>` 就是根。
	const installGlobal = /^(.*?)[\\/]install[\\/]global[\\/]node_modules(?:[\\/]|$)/i.exec(command);
	return installGlobal?.[1];
}

/** 官方 npm registry；bun 的默认源也是它，更新失败提示统一指向这里。 */
export const PI_OFFICIAL_REGISTRY = "https://registry.npmjs.org";
const OFFICIAL_REGISTRY_FLAG = `--registry=${PI_OFFICIAL_REGISTRY}`;

/**
 * 作用域包的作用域源旗标（`@scope/name@ver` → `--@scope:registry=<官方源>`）。
 *
 * 为什么光有 `--registry` 不够：.npmrc 里的 `@scope:registry=` 比默认源更具体，会压过 `--registry`。
 * 实测（npm 11.19.0）：默认源指 npmmirror、作用域源指官方时，`npm view @earendil-works/…`
 * 只打了 `https://registry.npmjs.org/…`（308ms，拿到新版本）；只给默认源则 3 次 ECONNRESET、85s 后返回旧版本。
 * 非作用域包返回 undefined（没有可覆盖的 scope）。
 */
function scopedRegistryFlag(spec: string): string | undefined {
	const match = /^(@[^/]+)\//.exec(spec);
	return match ? `--${match[1]}:registry=${PI_OFFICIAL_REGISTRY}` : undefined;
}

/**
 * npm 全局安装参数（代跑与「源未同步」提示共用）。参数与 pi 自身的 npm 分支一致（`--ignore-scripts`
 * 安装脚本隔离、`--min-release-age=0` 绕过刚发布版本被用户发布的年龄门拦下）；`registry` 只在提示里
 * 打开（代跑必须尊重用户配置的源）；`prefixDir` 给旧引导前缀副本，缺了它 npm 会装到用户真实全局目录。
 */
export function npmGlobalInstallArgs(spec: string, options: { prefixDir?: string; registry?: boolean } = {}): string[] {
	const scopedFlag = options.registry ? scopedRegistryFlag(spec) : undefined;
	return ["install", "-g", "--ignore-scripts", "--min-release-age=0", spec, ...(options.prefixDir ? ["--prefix", options.prefixDir] : []), ...(options.registry ? [OFFICIAL_REGISTRY_FLAG] : []), ...(scopedFlag ? [scopedFlag] : [])];
}

/**
 * bun 全局安装参数；参数与 pi 自身的 bun 分支一致（`--minimum-release-age=0` 绕过 bunfig 的发布年龄门）。
 * `releaseAgeFlag` 只对 bun ≥ 1.3 打开（开关本身是 1.3 才引入的）。
 */
export function bunGlobalInstallArgs(spec: string, options: { releaseAgeFlag?: boolean; registry?: boolean } = {}): string[] {
	return ["install", "-g", "--ignore-scripts", ...(options.releaseAgeFlag ? ["--minimum-release-age=0"] : []), spec, ...(options.registry ? [OFFICIAL_REGISTRY_FLAG] : [])];
}

/** 年龄门开关在 bun 1.3 引入（1.3 之前无此开关，发了也不会有集合）。 */
export const BUN_MIN_VERSION_FOR_RELEASE_AGE_FLAG = "1.3.0";

/** POSIX 上 bun 本体可能所在、但 PiLocator 硬编码目录没覆盖的位置（按探测顺序）。 */
const POSIX_BUN_DIRS = ["/home/linuxbrew/.linuxbrew/bin", "/opt/homebrew/bin", "/usr/local/bin", "/nix/var/nix/profiles/default/bin", "/run/current-system/sw/bin"];
/** 相对用户 home 的 bun 本体候选目录（linuxbrew 与 nix 默认都在 home 下）。 */
const HOME_BUN_DIRS = [".bun/bin", ".linuxbrew/bin", ".nix-profile/bin"];

/**
 * bun 本体的候选位置（有序，**纯列表构造**，存在性判断在调用方）。
 *
 * 为什么需要：从 pi 入口只能推出 `$BUN_INSTALL/bin`（默认 `~/.bun/bin`），而 Homebrew/nix 装的 bun 本体
 * 在别处、shim 仍在 `~/.bun/bin`——这时推出来的路径不存在，若不补候选就只能回退裸 `bun` 赌 PATH。
 * macOS 的 brew 目录已在 PiLocator 的硬编码目录里，Linux 的 linuxbrew 与 nix 不在。
 */
export function bunCommandCandidates(homeDir: string, bunName: string, platform: NodeJS.Platform = process.platform): string[] {
	const api = platform === "win32" ? win32 : posix;
	const fromHome = HOME_BUN_DIRS.map((rel) => api.join(homeDir, ...rel.split("/"), bunName));
	// Windows 上没有 linuxbrew/nix 的固定盘符约定；home 下的候选（含 `%USERPROFILE%\.bun\bin`）足够。
	return platform === "win32" ? fromHome : [...fromHome, ...POSIX_BUN_DIRS.map((dir) => api.join(dir, bunName))];
}

/**
 * `bun --version` 输出的版本（如 `1.4.3`，实测单行裸版本号）。只认「整行就是一个版本」的行：直接抓版本号
 * 子串会在包装命令（mise/asdf 等）的摸幅里抽到无关版本，把老 bun 误判成 ≥ 1.3 后塞进它不认识的
 * `--minimum-release-age`（1.3 之前无此开关）。
 */
export function parseBunVersion(raw: string): string | undefined {
	for (const line of raw.split(/\r?\n/)) {
		const match = /^\s*(?:bun\s+)?v?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/i.exec(line);
		if (match) return match[1];
	}
	return undefined;
}

/** 本地绝对路径形态（POSIX `/…`、Windows `C:\…`、UNC `\\…`）；带空格的安装目录同样合法，只按前缀判定。 */
export function isLocalAbsolutePath(value: string): boolean {
	return /^(?:[a-zA-Z]:[\\/]|[\\/])/.test(value);
}

/**
 * 自定义 BUN_INSTALL 的 shim 形态细化（需要磁盘判断，`exists` 由调用方注入以保持本模块零磁盘依赖）。
 *
 * 为什么需要：shim 形态 `<root>/bin/pi[.exe]` 与普通全局安装在路径上无法区分，但 bun 的全局包目录固定是
 * `<root>/install/global/node_modules`——存在就说明这是 bun 安装，根即 `<root>`。不补这一步的后果：
 * Windows 上这类安装会归 `pi-self`，而 pi 在 Windows 明确拒绝非 npm/pnpm 自更新（bun 形态直接报
 * “Update pi manually”），PiDeck 的代跑能力形同不存在；POSIX 上至少还能拿到绝对 bun 路径与 BUN_INSTALL。
 * 非 `pi-self` 通道、非本地绝对路径（含 WSL 召唤串）一律原样返回。
 */
export function refineChannelForCustomBunRoot(channel: PiSelfUpdateChannel, command: string, exists: (path: string) => boolean, platform: NodeJS.Platform = process.platform): PiSelfUpdateChannel {
	if (channel.kind !== "pi-self" || !isLocalAbsolutePath(command)) return channel;
	const api = command.includes("\\") ? win32 : posix;
	const root = api.dirname(api.dirname(command));
	if (!exists(api.join(root, "install", "global", "node_modules"))) return channel;
	return { kind: "bun-global", bunCommand: api.join(root, "bin", platform === "win32" ? "bun.exe" : "bun"), bunInstallRoot: root };
}

export function resolvePiSelfUpdateChannel(command: string, platform: NodeJS.Platform = process.platform): PiSelfUpdateChannel {
	// 裸命令名（所有候选都未命中时的兜底形态）、wsl:// 标记与两种 WSL 目标形态均无从分类；
	// WSL 内是 Linux 环境，pi 自身的 Windows gate 不适用，交给 `pi update --self` 自己判断。
	if (!command || command.startsWith("wsl://") || WSL_TARGET_PATTERN.test(command) || !/[\\/]/.test(command)) return { kind: "pi-self" };
	if (BUN_PATH_PATTERN.test(command.replace(/\\/g, "/"))) {
		// 分隔符跟随命令自身形态（而非宿主平台）：POSIX 形态路径即使在 Windows 主机上
		//（WSL/跨平台测试）也要拼出 POSIX 分隔符，否则生成的 bunCommand 无法命中。
		const pathApi = command.includes("\\") ? win32 : posix;
		const root = resolveBunInstallRoot(command);
		const bunName = platform === "win32" ? "bun.exe" : "bun";
		return { kind: "bun-global", bunCommand: root ? pathApi.join(root, "bin", bunName) : bunName, ...(root ? { bunInstallRoot: root } : {}) };
	}
	const portableMatch = PORTABLE_PREFIX_PATTERN.exec(command);
	if (portableMatch) return { kind: "portable-prefix", prefixDir: portableMatch[1] };
	return { kind: "pi-self" };
}
