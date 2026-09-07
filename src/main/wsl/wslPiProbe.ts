/**
 * WSL 内 pi 的探测与启动参数拼装（纯函数层，无 Electron / 子进程依赖，可单测）。
 *
 * 为什么需要这一层：`wsl.exe -d D -u U <cmd>` 用的是**非登录、非交互** shell，
 * nvm / fnm / volta / asdf / mise 的 PATH 注入写在 `~/.bashrc` 的交互守卫之后
 * （Ubuntu 默认 `.bashrc` 开头就 `case $- in *i*) ... *) return`），
 * 所以这类 shell 里 `which pi` 必然为空 —— 表现为「WSL 里能用 pi，PiDeck 说未检测到」。
 * 即便拿到绝对路径，pi 的 shebang 是 `#!/usr/bin/env node`，node 不在 PATH 时仍会失败。
 *
 * 因此本模块约定两件事，探测与启动必须共用：
 * 1. 探测分三层：交互登录 shell 的 PATH → 已知安装目录 glob → 包管理器 prefix；
 * 2. 启动统一走 `-e /usr/bin/env PATH=<node bin>:<系统目录> <pi 绝对路径>`，
 *    既绕开 shell rc 依赖，也绕开 wsl.exe 不带 `-e` 时把参数拼成命令行二次解析的引号坑。
 */

/** 探测超时：冷启动 WSL VM 时 `wsl.exe` 首条命令可能很慢，8s 明显不够。 */
export const WSL_PI_PROBE_TIMEOUT_MS = 20_000;
/** 负缓存有效期：用户「装完 pi 不重启应用」也要能在一个 TTL 内自动恢复。 */
export const WSL_PI_NEGATIVE_CACHE_TTL_MS = 60_000;

/** WSL 默认非登录 shell 的系统 bin，保证 git / sh / coreutils 仍能找到。 */
export const WSL_PI_BASE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

export type WslPiProbeResult = {
	/** pi 可执行文件（或 npm shim）的 Linux 绝对路径。 */
	piPath: string;
	/** 与该 pi 配套的 node 所在目录；启动时前置注入 PATH，供 `env node` shebang 使用。 */
	nodeBinDir: string;
};

/**
 * 已知的 Linux 侧安装位置，按优先级排列（版本管理器 → 包管理器 → 系统目录）。
 * `$HOME` / `$PNPM_HOME` 与 `*` 由 WSL 内的 shell 展开，因此列表里保留原始写法。
 */
export const WSL_PI_CANDIDATE_DIRS: readonly string[] = [
	"$HOME/.nvm/versions/node/*/bin",
	"$HOME/.fnm/node-versions/*/installation/bin",
	"$HOME/.local/share/fnm/node-versions/*/installation/bin",
	"$HOME/.fnm/aliases/default/bin",
	"$HOME/.local/share/fnm/aliases/default/bin",
	"$HOME/.volta/bin",
	"$HOME/.asdf/shims",
	"$HOME/.local/share/mise/shims",
	"$HOME/.local/share/mise/installs/node/*/bin",
	"$HOME/.npm-global/bin",
	"$PNPM_HOME",
	"$HOME/.local/share/pnpm",
	"$HOME/.yarn/bin",
	"$HOME/.config/yarn/global/node_modules/.bin",
	"$HOME/.bun/bin",
	"$HOME/.deno/bin",
	"$HOME/.cargo/bin",
	"$HOME/.local/bin",
	"$HOME/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin",
	"/opt/homebrew/bin",
	"/home/linuxbrew/.linuxbrew/bin",
];

/** 探测脚本输出的键名；rc 噪音（PROMPT_COMMAND、欢迎语）靠它过滤。 */
const PI_KEY = "PIDECK_PI=";
const NODE_BIN_KEY = "PIDECK_NODE_BIN=";

function isAbsoluteLinuxPath(value: string): boolean {
	return value.startsWith("/");
}

function quoteProbeCandidate(dir: string): string {
	// Keep the wildcard unquoted so pathname expansion still happens, but quote
	// HOME/PNPM_HOME themselves. Linux home directories are allowed to contain
	// spaces, and the old `for _d in $HOME/...` split those paths into fragments.
	if (dir.startsWith("$HOME/")) return `"$HOME"/${dir.slice("$HOME/".length)}/pi`;
	if (dir === "$PNPM_HOME") return `"$PNPM_HOME"/pi`;
	const value = `${dir}/pi`;
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * WSL interop 命中：`appendWindowsPath=true` 时 Linux PATH 会带上 `/mnt/c/...`，
 * 那里找到的是 Windows 侧 pi.cmd shim，不是 distro 内的 Linux 安装，不能当 WSL pi 用。
 */
export function isWslInteropPath(path: string): boolean {
	return /^\/mnt\/[A-Za-z](\/|$)/i.test(path);
}

/**
 * 生成一次往返完成探测的 POSIX sh 脚本。
 * 命中即 `exit 0` 并打印 `PIDECK_PI=` / `PIDECK_NODE_BIN=`；未命中打印 `PIDECK_MISS=1` 且仍 exit 0，
 * 这样「脚本跑通但没装 pi」与「bash 不存在 / spawn 失败」在调用端可区分。
 */
export function buildWslPiProbeScript(extraCandidateDirs: readonly string[] = []): string {
	const candidateDirs = [...WSL_PI_CANDIDATE_DIRS, ...extraCandidateDirs].filter(Boolean);
	const candidateList = candidateDirs.map(quoteProbeCandidate).join(" ");
	return [
		"_pideck_emit() {",
		// 必须是绝对路径、可执行、且不是 Windows interop shim
		'  case "$1" in /*) ;; *) return 1 ;; esac',
		'  case "$1" in /mnt/*) return 1 ;; esac',
		'  [ -x "$1" ] || return 1',
		'  _bin="$2"',
		'  [ -n "$_bin" ] || _bin=$(dirname "$1")',
		'  printf \'PIDECK_PI=%s\\n\' "$1"',
		'  printf \'PIDECK_NODE_BIN=%s\\n\' "$_bin"',
		"  exit 0",
		"}",
		// L1：交互登录 shell 已 source nvm/fnm 初始化，覆盖用户自定义安装位置
		'_p=$(command -v pi 2>/dev/null)',
		'_n=$(command -v node 2>/dev/null)',
		'_nb=""',
		'if [ -n "$_n" ]; then _rn=$(readlink -f "$_n" 2>/dev/null); [ -n "$_rn" ] && _nb=$(dirname "$_rn"); fi',
		// fnm/nvm 的 /run/user/.../fnm_multishells 目录随 shell 退出失效，改用稳定的 installation/bin
		'case "$_p" in /run/user/*) if [ -n "$_nb" ] && [ -x "$_nb/pi" ]; then _p="$_nb/pi"; fi ;; esac',
		// command -v may return a symlink (including a symlink into /mnt/c). Resolve it
		// before the interop check and cache the executable path, not the link name.
		'_rp=$(readlink -f "$_p" 2>/dev/null); [ -n "$_rp" ] && _p="$_rp"',
		'_pideck_emit "$_p" "$_nb"',
		// L2：已知安装目录（不依赖任何 shell rc）。先筛可执行再解符号链接，避免为不存在的候选白跑 fork。
		`for _d in ${candidateList}; do`,
		'  [ -x "$_d" ] || continue',
		// Keep the candidate's bin directory for the shebang Node lookup. The
		// resolved target is often cli.js under node_modules, not beside node.
		'  _db=$(dirname "$_d")',
		'  _rd=$(readlink -f "$_d" 2>/dev/null)',
		'  [ -n "$_rd" ] && _d="$_rd"',
		'  case "$_d" in /mnt/*) continue ;; esac',
		'  _pideck_emit "$_d" "$_db"',
		"done",
		// L3：问包管理器要全局 prefix（仅在 L1/L2 全落空时才会付出这点开销）
		'if command -v npm >/dev/null 2>&1; then _x=$(npm config get prefix 2>/dev/null); [ -n "$_x" ] && _pideck_emit "$_x/bin/pi" "$_x/bin"; fi',
		'if command -v mise >/dev/null 2>&1; then for _x in $(mise bin-paths 2>/dev/null); do _pideck_emit "$_x/pi" "$_x"; done; fi',
		'if command -v volta >/dev/null 2>&1; then _x=$(volta which pi 2>/dev/null); [ -n "$_x" ] && _pideck_emit "$_x" ""; fi',
		'if command -v asdf >/dev/null 2>&1; then _x=$(asdf which pi 2>/dev/null); [ -n "$_x" ] && _pideck_emit "$_x" ""; fi',
		'printf "PIDECK_MISS=1\\n"',
		"exit 0",
	].join("\n");
}

/**
 * 解析探测脚本输出。
 * 容忍 rc 噪音与 GBK/UTF-16 混排：只认 `PIDECK_PI=` / `PIDECK_NODE_BIN=` 两种行，取最后一次。
 * node bin 缺失时回退到 pi 自身所在目录（nvm/fnm/volta/mise 的全局 bin 与 node 同目录）。
 */
export function parseWslPiProbeOutput(stdout: string): WslPiProbeResult | null {
	let piPath = "";
	let nodeBinDir = "";
	for (const rawLine of String(stdout ?? "").split(/\r?\n/)) {
		const line = rawLine.replace(/\0/g, "").trim();
		if (line.startsWith(PI_KEY)) piPath = line.slice(PI_KEY.length);
		else if (line.startsWith(NODE_BIN_KEY)) nodeBinDir = line.slice(NODE_BIN_KEY.length);
	}
	if (!isAbsoluteLinuxPath(piPath) || isWslInteropPath(piPath)) return null;
	if (!isAbsoluteLinuxPath(nodeBinDir) || isWslInteropPath(nodeBinDir)) {
		nodeBinDir = piPath.slice(0, piPath.lastIndexOf("/")) || "/";
	}
	return { piPath, nodeBinDir };
}

export type WslPiExecArgsInput = {
	distro: string;
	user: string;
	/** `wsl://` 标记里的命令段：绝对 Linux 路径，或裸命令名 `pi`。 */
	piCommand: string;
	/** 与 pi 配套的 node bin 目录；缺省时从 piCommand 推导。 */
	nodeBinDir?: string;
	/** 已转换好的 Linux 工作目录（`--cd`）。 */
	wslCwd?: string;
	args: readonly string[];
};

/**
 * 组装 `wsl.exe` 的参数数组 —— 探测（`--version`）与启动（RPC）共用同一个函数，
 * 杜绝「检测得到、启动失败」这类不对称失败。
 *
 * 绝对路径分支：`-e /usr/bin/env PATH=<nodeBin>:<系统目录> <pi> <args…>`
 * - `-e` 让 wsl.exe 直接 exec，不把参数交给默认 shell 二次解析（空格/引号安全）；
 * - 注入 PATH 让 `#!/usr/bin/env node` 找得到 node。
 * 裸命令名分支：保持历史行为，不注入 PATH（否则会覆盖掉用户 distro 里的完整环境）。
 */
export function buildWslPiExecArgs(input: WslPiExecArgsInput): string[] {
	const args = ["-d", input.distro, "-u", input.user];
	if (input.wslCwd) args.push("--cd", input.wslCwd);

	if (!isAbsoluteLinuxPath(input.piCommand)) {
		return [...args, input.piCommand, ...input.args];
	}

	const candidate = input.nodeBinDir ?? "";
	const nodeBinDir =
		isAbsoluteLinuxPath(candidate) && !isWslInteropPath(candidate)
			? candidate
			: input.piCommand.slice(0, input.piCommand.lastIndexOf("/")) || "/";
	const pathValue = nodeBinDir === "/" ? WSL_PI_BASE_PATH : `${nodeBinDir}:${WSL_PI_BASE_PATH}`;
	return [...args, "-e", "/usr/bin/env", `PATH=${pathValue}`, input.piCommand, ...input.args];
}

export type ParsedWslCommandMarker = {
	distro: string;
	user: string;
	piCommand: string;
};

/**
 * 解析 `wsl://<distro>/<user>/<piCommand>` 标记。
 * 用正则而非 split("/")：命令段本身带斜杠（绝对 Linux 路径），且 `wsl://` 的双斜杠不能产生空元素。
 */
export function parseWslCommandMarker(url: string): ParsedWslCommandMarker | null {
	const match = /^wsl:\/\/([^/\r\n]+)\/([^/\r\n]+)\/([^\r\n]+)$/.exec(url);
	if (!match) return null;
	const [, distro, user, piCommand] = match;
	// Only the generated bare command or an absolute Linux path is valid. This
	// prevents a corrupted setting such as `wsl://D/U/-e` from becoming another
	// wsl.exe option, and keeps /mnt/c host shims out of the WSL path.
	if (piCommand !== "pi" && (!isAbsoluteLinuxPath(piCommand) || isWslInteropPath(piCommand))) return null;
	return { distro, user, piCommand };
}

/** 构造 `wsl://` 标记；piPath 以 `/` 开头时保留双斜杠，与 parseWslCommandMarker 对称。 */
export function buildWslCommandMarker(distro: string, user: string, piCommand: string): string {
	return `wsl://${distro}/${user}/${piCommand}`;
}
