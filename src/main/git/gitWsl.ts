// 本地 import 带 .ts 扩展名：本模块经 gitRun 被 rewind checkpointCore 串联，
// 由 tests/*.test.mjs 用 Node type stripping 直接加载（见 gitRun.ts 同注）。
import { tmpdir } from "node:os";
import { DEFAULT_GIT_TIMEOUT_MS } from "./gitProcess.ts";
import { decodeWslOutput, getWslExe } from "../wsl/wslExe.ts";
import { parseWslUncPath, toWindowsHostPath, toWslLinuxPath } from "../wsl/WslPaths.ts";

/**
 * WSL 内 git 执行的规划层（纯计算，可单测）。
 *
 * 为什么需要这一层：项目位于 WSL 发行版内时（ProjectStore 存的是
 * `\\wsl.localhost\<distro>\...` UNC 路径），用宿主 git.exe 操作有两个问题：
 * 1) safe.directory —— git.exe 经 9P 访问 UNC 共享，仓库被判定为「他人所有」，
 *    未配置 safe.directory 时命令直接失败；
 * 2) 更根本的是 git.exe 用 Windows 视角解释索引与工作区（文件模式、符号链接、换行），
 *    与发行版内 git 交替使用会让同一仓库反复出现「整树改动」。
 * 因此当 cwd 是 WSL UNC 路径时，改在发行版内执行：
 *
 *     wsl.exe -d <distro> -e /bin/sh -c <cd 守卫> pideck <linuxCwd> /usr/bin/env [K=V ...] git <args...>
 *
 * 本模块只做「把宿主调用翻译成 WSL 调用」的纯计算（argv 改写、路径/env 翻译、输出回译），
 * 不 spawn 进程，因此可完整单测；真正的执行在 gitRun.ts。
 */

/** WSL 内 git 执行目标：发行版 + Linux 侧工作目录。 */
export type WslGitTarget = {
	distro: string;
	linuxCwd: string;
};

/**
 * WSL 分支的最小超时。wsl.exe 冷启动（拉起发行版 + 挂载）与 9P 目录遍历都可能
 * 超过宿主 30s 默认值，WSL 侧统一抬到这个下限；调用方给更大值时取大者。
 */
export const WSL_GIT_TIMEOUT_FLOOR_MS = 60_000;

/**
 * WSL 分支的有效超时（调用方值与该分支下限取大者）。
 * 单独抽成函数是为了让「下限生效」可被单测——否则只能靠 60s 真等待观察。
 */
export function resolveWslGitTimeout(timeoutMs?: number): number {
	return Math.max(timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS, WSL_GIT_TIMEOUT_FLOOR_MS);
}

/** 宿主绝对路径特征：盘符（`C:\` / `C:/`）或 UNC（`\\`）。 */
const HOST_ABSOLUTE_PATH_RE = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/;

export function isHostAbsolutePath(value: string): boolean {
	return HOST_ABSOLUTE_PATH_RE.test(value);
}

/**
 * 这个 cwd 是否应在 WSL 发行版内执行 git（纯函数）。
 *
 * 只认 UNC：`\\wsl.localhost\<distro>\...` / `\\wsl$\...`。盘符路径一律走宿主 git ——
 * 与 ProjectStore 的存储约定一致（normalizeSelectedWslProjectPath 把 WSL 内项目存成 UNC、
 * 把 /mnt/c 下的项目存成 `C:\`）。非 Windows 平台没有 wsl.exe，恒返回 null。
 */
export function resolveWslGitTarget(cwd: string, platform: NodeJS.Platform = process.platform): WslGitTarget | null {
	if (platform !== "win32") return null;
	const parsed = parseWslUncPath(cwd);
	return parsed ? { distro: parsed.distro, linuxCwd: parsed.linuxPath } : null;
}

/**
 * sh 守卫脚本：`$0`=占位名，`$1`=Linux cwd，其余为真正的命令 argv。
 *
 * 为什么不用 `wsl.exe --cd`：目标目录不存在时 --cd 静默退回 `/` 且 exit 0，
 * 后续 git 会在错误的目录上「成功」执行（表现为面板全空却不报错）。cd 失败必须
 * 非零退出（90，与 wsl.exe 自身错误码区分），错误才不会被吞掉。
 * 发行版里没装 git 时单独探测（91）：/usr/bin/env 的报错文案随发行版 locale 变化，
 * 自带一条稳定的英文消息，GitService 才能把它归类为「未安装 git」而不是静默空面板。
 * 命令经 `exec "$@"` 替换进程，不经过第二次 shell 解析，路径里的空格/特殊字符安全。
 */
export const WSL_GIT_CD_GUARD = `cd "$1" || { printf '%s\\n' "pideck: cannot change directory to $1" >&2; exit 90; }
shift
command -v git >/dev/null 2>&1 || { printf '%s\\n' "pideck: git is not installed in this WSL distribution" >&2; exit 91; }
exec "$@"`;

/**
 * argv 改写：只认两个「路径位置」，其余位置出现宿主绝对路径直接抛错。
 * 1. `-C <path>` 的值；
 * 2. `--` 之后的所有项（pathspec）。
 *
 * 为什么不「所有形如绝对路径的项一律转换」：参数区里还有选项与修订表达式，
 * 盲转可能改坏非路径语义的字符串；而漏转的路径位置又会让 Linux git 把
 * `C:\x\y` 当相对文件名（凭空出现怪名未跟踪文件）。两条规则一咬合，
 * 漏转在开发期就以抛错暴露，而不是等用户看到错误结果。
 */
export function toWslGitArgs(args: string[], target: WslGitTarget): string[] {
	const converted: string[] = [];
	let afterSeparator = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index]!;
		if (afterSeparator) {
			converted.push(convertPathArgument(arg, target));
			continue;
		}
		if (arg === "--") {
			afterSeparator = true;
			converted.push(arg);
			continue;
		}
		if (arg === "-C") {
			const value = args[index + 1];
			if (value === undefined) throw new Error("invalid git invocation: -C requires a path argument");
			converted.push(arg, convertPathArgument(value, target));
			index++;
			continue;
		}
		if (isHostAbsolutePath(arg)) {
			throw new Error(`Refusing to pass host path ${JSON.stringify(arg)} to WSL git outside a path position (-C value or after --)`);
		}
		converted.push(arg);
	}
	return converted;
}

/** 宿主绝对路径 → Linux 绝对路径；相对路径与已是 Linux 形态的值原样保留。 */
function convertPathArgument(value: string, target: WslGitTarget): string {
	return isHostAbsolutePath(value) ? toWslLinuxPath(value, target) : value;
}

/**
 * 环境变量转发：Windows 进程的环境变量不会进入 WSL 进程（只有 WSLENV 白名单变量会），
 * 因此调用方显式注入给 git 的 env（GIT_INDEX_FILE / GIT_AUTHOR_* 等）必须经
 * `/usr/bin/env K=V` 前缀逐条带过去；process.env 不转发，避免把 Windows 的 PATH/HOME
 * 泄进发行版。
 *
 * 值为宿主绝对路径的必须改写（GIT_INDEX_FILE=C:/Users/... → /mnt/c/Users/...）：
 * 否则 Linux git 会把 `C:/...` 当相对路径，在 cwd 下建出一个怪名文件。
 * 相对路径与 Linux 形态的值原样转发。不支持冒号分隔的列表型变量
 * （GIT_ALTERNATE_OBJECT_DIRECTORIES / PATH 这类）——当前没有调用方使用。
 */
export function toWslGitEnv(env: NodeJS.ProcessEnv | undefined, target: WslGitTarget): string[] {
	const forwarded: string[] = [];
	for (const [key, value] of Object.entries(env ?? {})) {
		if (value === undefined) continue;
		forwarded.push(`${key}=${convertPathArgument(value, target)}`);
	}
	return forwarded;
}

/**
 * git 输出里的绝对路径 → 宿主形态（WSL 分支：`/mnt/c/...` → `C:\...`，其余 Linux 路径 → UNC；
 * 宿主分支原样返回）。
 *
 * 只用于「git 保证输出绝对路径」的字段：rev-parse --show-toplevel / --git-common-dir、
 * worktree list --porcelain。status / diff 输出的是仓库相对路径，无需转换。
 * 相对路径（如 `.git`）原样返回，由调用方按 cwd resolve。
 */
export function toHostGitOutputPath(path: string, target: WslGitTarget | null): string {
	if (!target || !path.startsWith("/")) return path;
	return toWindowsHostPath(path, target);
}

/**
 * WSL 分支的 stdout 解码：UTF-16 特征（BOM 或 ASCII+NUL 交替）按 UTF-16LE，
 * 否则按 UTF-8 —— 且**必须保留 NUL**：git 的 -z 输出靠 NUL 分隔，
 * wslExe.decodeWslOutput 的 UTF-8 分支会剥掉 NUL，不能直接用在 git 输出上。
 */
export function decodeWslGitStdout(raw: Buffer): string {
	if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) return raw.subarray(2).toString("utf16le").replace(/\0/g, "");
	if (raw.length >= 4 && raw[1] === 0x00 && raw[3] === 0x00) return raw.toString("utf16le").replace(/\0/g, "");
	return raw.toString("utf8");
}

/** WSL 分支的 stderr 解码：wsl.exe 自身报错是 UTF-16LE 本地化文案，复用 wslExe 的统一解码。 */
export function decodeWslGitStderr(raw: Buffer): string {
	return decodeWslOutput(raw);
}

export type GitSpawnPlan = {
	/** 最终 spawn 的命令。 */
	command: string;
	args: string[];
	/** 进程 cwd：WSL 分支用宿主临时目录（Linux 侧工作目录由守卫脚本保证）。 */
	cwd: string;
	/** 命中 WSL 时的目标；null = 宿主 git。 */
	target: WslGitTarget | null;
	/** 调用方显式注入的环境变量（宿主分支与 process.env 合并；WSL 分支只转发这些）。 */
	env?: NodeJS.ProcessEnv;
	/**
	 * 日志/错误消息用的可读命令描述。真实 argv 含守卫脚本（多行、含换行），
	 * 直接拼进错误消息会破坏「首行 = 命令、其余 = stderr」的约定。
	 */
	display: string;
};

export type GitSpawnPlanOptions = {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	/** 宿主 git 命令（用户配置优先），仅宿主分支使用。 */
	nativeCommand?: string;
	/** 平台，仅测试注入用。 */
	platform?: NodeJS.Platform;
	/** wsl.exe 路径，仅测试注入用；默认走 wslExe 的解析结果。 */
	wslCommand?: string;
};

/**
 * 把一次 git 调用翻译成 spawn 计划。
 *
 * WSL 分支的进程 cwd 用宿主临时目录而不是 UNC：CreateProcess 以 UNC 作为工作目录
 * 属于未定义行为（部分 Windows API 直接拒绝），而 Linux 侧工作目录本来就由守卫脚本保证。
 */
export function planGitSpawn(args: string[], options: GitSpawnPlanOptions): GitSpawnPlan {
	const target = resolveWslGitTarget(options.cwd, options.platform ?? process.platform);
	if (!target) {
		const command = options.nativeCommand ?? "git";
		return { command, args, cwd: options.cwd, target: null, env: options.env, display: `${command} ${args.join(" ")}` };
	}
	const command = options.wslCommand ?? getWslExe().command;
	const gitArgs = toWslGitArgs(args, target);
	return {
		command,
		args: buildWslGitArgs(target, gitArgs, toWslGitEnv(options.env, target)),
		cwd: tmpdir(),
		target,
		env: options.env,
		// 展示时省略守卫脚本与 env 前缀，只留「在哪个发行版里执行了什么 git 命令」。
		display: `${command} -d ${target.distro} git ${gitArgs.join(" ")}`,
	};
}

/** 组装 wsl.exe 的完整 argv（`-e` 之后的项原样传给 Linux 进程，`$0` 位置放占位名）。 */
export function buildWslGitArgs(target: WslGitTarget, gitArgs: string[], envArgs: string[]): string[] {
	return ["-d", target.distro, "-e", "/bin/sh", "-c", WSL_GIT_CD_GUARD, "pideck", target.linuxCwd, "/usr/bin/env", ...envArgs, "git", ...gitArgs];
}
