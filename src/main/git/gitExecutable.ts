import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
// 类型契约在 shared/types/git.ts（主进程与渲染层共用）。import type 会被 Node
// type stripping 直接剥离、不产生运行时依赖，故本模块仍可被 tests/*.test.mjs 直接加载。
import type {
	GitExecutableInfo,
	GitExecutableProbe,
	GitSystemProbe,
} from "../../shared/types/git";

/**
 * git 可执行文件解析与探测（可单测的独立模块）。
 *
 * 背景：GitService / WorktreeService 此前一律 spawn 字面量 "git"，完全依赖 PATH。
 * Windows 上用户安装 Git for Windows 时若选择「仅 Git Bash 可用」，PATH 里就没有 git，
 * 整个 Git 面板与 worktree 功能会全部退化。这里提供：
 *
 * - 用户显式配置优先（`settings.gitExecutablePath`）；
 * - 未配置时 PATH 解析；
 * - PATH 失败时按平台候选安装位置兜底探测。
 *
 * 只依赖 node 内置模块与 node:util，可被 Node 24 的 type stripping 直接加载
 * （tests/*.test.mjs 里 `import ... from "../src/main/git/gitExecutable.ts"`）。
 */

const execFileAsync = promisify(execFile);

/**
 * 当前生效的用户配置（由装配层在设置加载/保存后写入，见 setConfiguredGitPath）。
 *
 * 为什么用模块级状态而不是给 GitService/WorktreeService 注入依赖：git 调用点分散在两个类
 * 共三十余处（runGit + execFileAsync），逐处透传 provider 会让业务方法签名被基础设施污染。
 * 主进程内 settings 本就是单例语义，模块级持有与之一致；测试不调用 setter 时默认值即 "git"。
 */
let configuredGitPath = "";

/** 设置加载或保存后同步用户配置；非法值按「未配置」处理。 */
export function setConfiguredGitPath(path: string | null | undefined): void {
	configuredGitPath = typeof path === "string" ? path.trim() : "";
}

/** 当前实际应 spawn 的 git 命令：用户配置优先，否则字面量 "git" 走 PATH。 */
export function currentGitExecutable(): string {
	return resolveGitExecutable(configuredGitPath);
}

/** 探测用子进程超时：git --version 是毫秒级操作，5s 足够覆盖冷启动的杀软扫描。 */
const GIT_PROBE_TIMEOUT_MS = 5_000;

/**
 * 各平台已知的 git 安装候选位置（纯函数）。
 *
 * 顺序即优先级：先系统级目录，再包管理器/用户级目录。
 * Windows 上 `cmd\git.exe` 是官方推荐的外部调用入口（比 mingw64\bin\git.exe 启动更快）。
 */
export function gitPathCandidates(
	platform: NodeJS.Platform = process.platform,
	localAppData: string | undefined = process.env.LOCALAPPDATA,
): string[] {
	if (platform === "win32") {
		return [
			"C:\\Program Files\\Git\\cmd\\git.exe",
			"C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
			"C:\\Program Files\\Git\\bin\\git.exe",
			"C:\\Program Files (x86)\\Git\\cmd\\git.exe",
			...(localAppData ? [`${localAppData}\\Programs\\Git\\cmd\\git.exe`] : []),
		];
	}
	if (platform === "darwin") {
		return [
			// /usr/bin/git 是 Xcode CLT 的 stub，未装 CLT 时执行会弹系统安装框，故排在最前但需验证可执行。
			"/usr/bin/git",
			"/opt/homebrew/bin/git",
			"/usr/local/bin/git",
			"/Applications/Xcode.app/Contents/Developer/usr/bin/git",
		];
	}
	return ["/usr/bin/git", "/usr/local/bin/git", "/snap/bin/git", "/opt/git/bin/git"];
}

/**
 * 决定实际 spawn 的命令（纯函数）：配置非空即用配置，否则回落字面量 "git" 走 PATH。
 */
export function resolveGitExecutable(configuredPath?: string | null): string {
	const trimmed = typeof configuredPath === "string" ? configuredPath.trim() : "";
	return trimmed || "git";
}

/**
 * 从 `git --version` 输出提取语义化版本号（纯函数）。
 * 支持 "git version 2.53.0.windows.4" → "2.53.0"、"git version 2.39" → "2.39.0"。
 */
export function parseGitVersion(raw: string): string {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
	if (!match) return "";
	return `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
}

/** PATH 模式下把 "git" 解析成绝对路径；解析失败返回空串。 */
async function resolvePathLocation(): Promise<string> {
	try {
		const command = process.platform === "win32" ? "where" : "which";
		const { stdout } = await execFileAsync(command, ["git"], {
			timeout: GIT_PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
		// where 在多命中时返回多行，取第一个非空行。
		return stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "";
	} catch {
		return "";
	}
}

/** 执行 `git --version` 并解析；任何失败（不存在/无权限/超时）都返回 null。 */
async function probeExecutable(executable: string): Promise<GitExecutableProbe | null> {
	try {
		const { stdout } = await execFileAsync(executable, ["--version"], {
			timeout: GIT_PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
		const version = parseGitVersion(stdout);
		if (!version) return null;
		const resolvedPath =
			executable === "git" ? await resolvePathLocation() : executable;
		return { resolvedPath: resolvedPath || executable, version };
	} catch {
		return null;
	}
}

/**
 * 探测系统自带的 git（忽略用户配置）：先 PATH，再各平台候选安装位置。
 */
export async function detectSystemGit(): Promise<GitSystemProbe | null> {
	const fromPath = await probeExecutable("git");
	if (fromPath) {
		return { ...fromPath, source: "path" };
	}
	for (const candidate of gitPathCandidates()) {
		if (!existsSync(candidate)) continue;
		const probe = await probeExecutable(candidate);
		if (probe) {
			return { ...probe, source: "known-location" };
		}
	}
	return null;
}

/**
 * 探测当前实际生效的 git：用户配置优先，失败时给出原因并附带系统探测结果供 UI 兜底提示。
 *
 * @param configuredPath 用户配置的路径；空串/非法值表示未配置（走自动解析）。
 */
export async function detectGitExecutable(
	configuredPath?: string | null,
): Promise<GitExecutableInfo> {
	const system = await detectSystemGit();
	const executable = resolveGitExecutable(configuredPath);

	if (executable !== "git") {
		const probe = await probeExecutable(executable);
		if (probe) {
			return {
				source: "configured",
				executable,
				resolvedPath: probe.resolvedPath,
				version: probe.version,
				error: null,
				system,
			};
		}
		return {
			source: "not-found",
			executable,
			resolvedPath: "",
			version: "",
			error: `无法执行配置的 git 路径：${executable}`,
			system,
		};
	}

	if (system) {
		return {
			source: system.source,
			executable: "git",
			resolvedPath: system.resolvedPath,
			version: system.version,
			error: null,
			system,
		};
	}

	return {
		source: "not-found",
		executable: "git",
		resolvedPath: "",
		version: "",
		error: "未检测到 git，请手动指定 git 可执行文件路径或安装 Git。",
		system: null,
	};
}
