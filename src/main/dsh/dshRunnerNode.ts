import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { DshRunnerNodeInfo, DshRunnerNodeProbe, DshRunnerNodeSystemProbe } from "../../shared/types/dshRunnerNode";
import { DSH_RUNNER_NODE_ENV, dshRunnerNodeFileName, resolveDshRunnerNodeSidecar, resolveInstalledDshRunnerNodeSidecar } from "./dshRunnerNodeSidecar";

/**
 * Windows DSH 沙箱 runner 的 CUI node 探测（可单测）。
 *
 * 不随包 86MB 的 node.exe：复用本机 Node。GUI electron.exe 当 runner 会闪黑窗口；
 * 受限 token 下也不能 CREATE_NO_WINDOW。必须是真正的 CUI node.exe。
 *
 * koffi 预编译按 Node ABI 分发，DSH runtime 跟 CI 钉在 Node 24，主版本不对会加载失败。
 */

const execFileAsync = promisify(execFile);
const NODE_PROBE_TIMEOUT_MS = 5_000;

/** 与 CI setup-node / DSH runtime koffi ABI 对齐。 */
export const DSH_RUNNER_NODE_MAJOR = 24;

function listChildDirs(parent: string): string[] {
	try {
		return readdirSync(parent, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => join(parent, entry.name));
	} catch {
		return [];
	}
}

/**
 * 版本管理器 / 包管理器里的真实 node 二进制（不是 PATH 垫片）。
 * PATH 上的 `node` 经常是 22/25 的 current，但 nvm/fnm/mise 目录里仍可能装着 24。
 * 只扫磁盘、不改 PATH，其它项目继续用它们自己的版本。
 */
export function versionManagerNodeCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
	const fileName = dshRunnerNodeFileName(platform);
	const home = env.HOME || env.USERPROFILE || homedir();
	const localAppData = env.LOCALAPPDATA;
	const appData = env.APPDATA;
	const out: string[] = [];

	const push = (dir: string, ...segments: string[]) => {
		out.push(join(dir, ...segments, fileName));
	};

	// nvm-windows：%NVM_HOME%\v24.x.y\node.exe 或 %APPDATA%\nvm
	const nvmHome = env.NVM_HOME || (appData ? join(appData, "nvm") : "");
	if (nvmHome) {
		for (const dir of listChildDirs(nvmHome)) push(dir);
	}
	// 官方 nvm（Unix 布局，WSL/部分 Windows 移植也会用）
	for (const dir of listChildDirs(join(home, ".nvm", "versions", "node"))) {
		push(dir, "bin");
	}
	push(home, ".nvm", "current", "bin");

	// fnm：%LOCALAPPDATA%\fnm\node-versions\<ver>\installation\node.exe
	const fnmRoot = env.FNM_DIR || (localAppData ? join(localAppData, "fnm") : join(home, ".fnm"));
	for (const dir of listChildDirs(join(fnmRoot, "node-versions"))) {
		push(dir, "installation");
		push(dir, "installation", "bin");
	}

	// mise：%LOCALAPPDATA%\mise\installs\node\<ver>\node.exe
	const miseDataDir = env.MISE_DATA_DIR || (platform === "win32" && localAppData ? join(localAppData, "mise") : join(home, ".local", "share", "mise"));
	const miseInstalls = env.MISE_INSTALL_PATH || join(miseDataDir, "installs", "node");
	for (const dir of listChildDirs(miseInstalls)) {
		push(dir);
		push(dir, "bin");
	}

	if (platform === "win32") {
		// Scoop 可并存多个 nodejs* bucket；current 可能不是 24，所以连 version 目录一起扫。
		push(home, "scoop", "apps", "nodejs", "current");
		for (const dir of listChildDirs(join(home, "scoop", "apps", "nodejs"))) {
			if (dir.endsWith("current")) continue;
			push(dir);
		}
		push(home, "scoop", "apps", "nodejs-lts", "current");
		for (const dir of listChildDirs(join(home, "scoop", "apps", "nodejs-lts"))) {
			if (dir.endsWith("current")) continue;
			push(dir);
		}
		push(home, "scoop", "apps", "nodejs24", "current");
	}

	// volta 工具链：bin\node.exe 是垫片，真实版本在 tools\image\node\<ver>\
	const voltaHome = env.VOLTA_HOME || (platform === "win32" && localAppData ? join(localAppData, "Volta") : join(home, ".volta"));
	for (const dir of listChildDirs(join(voltaHome, "tools", "image", "node"))) {
		push(dir);
		push(dir, "bin");
	}

	return [...new Set(out)];
}

export function nodePathCandidates(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string[] {
	const fileName = dshRunnerNodeFileName(platform);
	const official: string[] = [];
	if (platform === "win32") {
		const programFiles = env.ProgramFiles ?? "C:\\Program Files";
		const localAppData = env.LOCALAPPDATA;
		official.push(`${programFiles}\\nodejs\\${fileName}`);
		if (localAppData) official.push(`${localAppData}\\Programs\\nodejs\\${fileName}`);
	} else if (platform === "darwin") {
		official.push("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node");
	} else {
		official.push("/usr/bin/node", "/usr/local/bin/node");
	}
	return [...new Set([...official, ...versionManagerNodeCandidates(platform, env)])];
}

/** 从 `node -v` / `v24.13.0` 抽出语义化版本。 */
export function parseNodeVersion(raw: string): string {
	const match = /v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
	if (!match) return "";
	return `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
}

export function nodeMajor(version: string): number | undefined {
	const match = /^(\d+)\./.exec(version);
	if (!match) return undefined;
	return Number(match[1]);
}

export function isDshRunnerNodeCompatible(version: string): boolean {
	return nodeMajor(version) === DSH_RUNNER_NODE_MAJOR;
}

/**
 * 路径里已经写明主版本（nvm 的 v22.12.0、mise 的 22.12.0）且不是 24 时跳过探测。
 * 避免本机装了十几个 Node 时每个都 spawn `node -v`。目录名不含版本的（如 current）仍探测。
 */
export function pathLooksLikeOtherNodeMajor(candidate: string): boolean {
	for (const match of candidate.matchAll(/[\\/]v?(\d+)\.\d+/g)) {
		if (Number(match[1]) !== DSH_RUNNER_NODE_MAJOR) return true;
	}
	return false;
}

export function resolveConfiguredNodePath(configuredPath?: string | null): string {
	return typeof configuredPath === "string" ? configuredPath.trim() : "";
}

/**
 * 版本管理器 / 包管理器放在 PATH 上的转发垫片目录（命中即不能当 runner）。
 *
 * 这些路径上的 `node` 只是几十字节的转发器：真跑起来它会再 CreateProcess 一次
 * 真实 node.exe。Windows Job runner 靠 `stdio[3]=ipc` + 自定义 fd 4（control）
 * 跟宿主通信，多一层转发后这两根管道全部断开——runner 会静默 0 退出、不发任何
 * 直接结果，宿主于是判 `Windows Job runner exited with exit code 0 before proving
 * its managed range empty`，run_code 直接失败（PTC worker-exit）。
 *
 * 统一把分隔符归一成 `\` 再匹配，Unix 的 `~/.local/share/mise/shims/node` 也覆盖。
 */
const NODE_SHIM_SEGMENTS = ["\\mise\\shims\\", "\\scoop\\shims\\", "\\volta\\bin\\", "\\fnm_multishells\\", "\\asdf\\shims\\", "\\.asdf\\shims\\", "\\node_modules\\.bin\\", "\\chocolatey\\bin\\", "\\windowsapps\\"];

export function isNodeShimPath(candidate: string): boolean {
	const normalized = candidate.trim().replace(/\//g, "\\").toLowerCase();
	if (!normalized) return false;
	return NODE_SHIM_SEGMENTS.some((segment) => normalized.includes(segment));
}

/**
 * 能不能直接 spawn 成 runner：必须是真实 node 二进制。
 * Windows 还要 `.exe`（`where node` 常见的第一行就是无扩展名的 bash 脚本垫片，
 * CreateProcess 认它但 IPC 全丢）。
 */
export function isRunnableRunnerNode(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
	const normalized = candidate.trim();
	if (!normalized) return false;
	if (isNodeShimPath(normalized)) return false;
	if (platform === "win32") return normalized.toLowerCase().endsWith(".exe");
	return true;
}

/** `where node` / `which node` 的全部命中（顺序即 PATH 优先级），只保留真实存在的文件。 */
async function resolvePathCandidates(platform: NodeJS.Platform = process.platform): Promise<string[]> {
	try {
		const command = platform === "win32" ? "where" : "which";
		const { stdout } = await execFileAsync(command, ["node"], {
			timeout: NODE_PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
		return stdout
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && existsSync(line));
	} catch {
		return [];
	}
}

async function probeExecutable(executable: string): Promise<DshRunnerNodeProbe | null> {
	try {
		const { stdout } = await execFileAsync(executable, ["-v"], {
			timeout: NODE_PROBE_TIMEOUT_MS,
			windowsHide: true,
		});
		const version = parseNodeVersion(stdout);
		if (!version) return null;
		return { resolvedPath: executable.trim(), version };
	} catch {
		return null;
	}
}

export type DetectSystemNodeInput = {
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	/** 一键下载的专用副本（userData/dsh-runner-node/node.exe）。 */
	sidecarPath?: string;
	/** 测试注入：代替真实的 `where node` / `which node` 命中列表（单测没法改本机 PATH）。 */
	pathHits?: string[];
};

/** 忽略用户配置：PATH 上的真 node → 专用 sidecar → 官方目录 / nvm/fnm/mise。 */
export async function detectSystemNode(platformOrInput: NodeJS.Platform | DetectSystemNodeInput = process.platform, envArg?: NodeJS.ProcessEnv): Promise<DshRunnerNodeSystemProbe | null> {
	const input: DetectSystemNodeInput = typeof platformOrInput === "string" ? { platform: platformOrInput, env: envArg } : platformOrInput;
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	const pathHits = input.pathHits ?? (await resolvePathCandidates(platform));

	// PATH：只认真正的 node 二进制，垫片一律跳过（否则 runner IPC 断、run_code 必失败）。
	let pathIncompatible: DshRunnerNodeSystemProbe | null = null;
	for (const hit of pathHits) {
		if (!isRunnableRunnerNode(hit, platform)) continue;
		const probe = await probeExecutable(hit);
		if (!probe) continue;
		if (isDshRunnerNodeCompatible(probe.version)) {
			return { ...probe, source: "path" };
		}
		pathIncompatible ??= { ...probe, source: "path" };
	}

	const sidecar = input.sidecarPath?.trim();
	if (sidecar && existsSync(sidecar) && isRunnableRunnerNode(sidecar, platform)) {
		const probe = await probeExecutable(sidecar);
		if (probe && isDshRunnerNodeCompatible(probe.version)) {
			return { ...probe, source: "sidecar" };
		}
	}

	for (const candidate of nodePathCandidates(platform, env)) {
		if (!existsSync(candidate)) continue;
		if (!isRunnableRunnerNode(candidate, platform)) continue;
		if (pathLooksLikeOtherNodeMajor(candidate)) continue;
		const probe = await probeExecutable(candidate);
		if (probe && isDshRunnerNodeCompatible(probe.version)) {
			return { ...probe, source: "known-location" };
		}
	}

	// 找到了但不兼容：仍返回 PATH 命中，让 UI 提示版本不对，并引导指定 24 或一键下载。
	if (pathIncompatible) return pathIncompatible;

	// PATH 上只剩垫片：探出版本只为给 UI 解释原因，绝不拿去 spawn。
	for (const hit of pathHits) {
		const probe = await probeExecutable(hit);
		if (probe) return { ...probe, source: "path", shimmed: true };
	}
	return null;
}

export type DetectDshRunnerNodeInput = {
	configuredPath?: string | null;
	envPath?: string | null;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
	userDataPath?: string | null;
	resourcesPath?: string | null;
	appPath?: string | null;
	/** 测试注入：代替真实的 `where node` / `which node` 命中列表。 */
	pathHits?: string[];
};

function incompatibleError(version: string): string {
	return `需要 Node ${DSH_RUNNER_NODE_MAJOR}.x（当前 ${version}）。PATH 上的 node 可以保持现状；请指定本机 Node ${DSH_RUNNER_NODE_MAJOR} 的路径，或一键下载仅给 PiDeck 用的副本。`;
}

function shimError(path: string, version: string): string {
	return `这个 node（${path}${version ? `，${version}` : ""}）是版本管理器垫片，不能当 DSH 沙箱 runner：垫片会再转一次真实 node.exe，runner 的 IPC 通道中途断掉，run_code 就会报清理失败。请选真实二进制的绝对路径（如 …\\mise\\installs\\node\\${DSH_RUNNER_NODE_MAJOR}.x.y\\node.exe），或一键下载仅给 PiDeck 用的副本。`;
}

/**
 * 探测当前应给 DSH runner 用的 node：env 覆盖 > 用户配置 > 系统自动探测。
 */
export async function detectDshRunnerNode(input: DetectDshRunnerNodeInput = {}): Promise<DshRunnerNodeInfo> {
	const platform = input.platform ?? process.platform;
	const env = input.env ?? process.env;
	const sidecarPath = resolveInstalledDshRunnerNodeSidecar({
		platform,
		userDataPath: input.userDataPath ?? undefined,
		resourcesPath: input.resourcesPath ?? undefined,
		appPath: input.appPath ?? undefined,
	});
	const system = await detectSystemNode({ platform, env, sidecarPath, pathHits: input.pathHits });
	const envPath = resolveConfiguredNodePath(input.envPath);
	if (envPath) {
		if (!existsSync(envPath)) {
			return notFound(`环境变量 ${DSH_RUNNER_NODE_ENV} 指向的文件不存在：${envPath}`, system, envPath);
		}
		const probe = await probeExecutable(envPath);
		if (!probe) return notFound(`无法执行 ${envPath}`, system, envPath);
		const shimmed = !isRunnableRunnerNode(envPath, platform);
		const compatible = !shimmed && isDshRunnerNodeCompatible(probe.version);
		return {
			source: "env",
			executable: envPath,
			resolvedPath: probe.resolvedPath,
			version: probe.version,
			error: shimmed ? shimError(envPath, probe.version) : compatible ? null : incompatibleError(probe.version),
			compatible,
			system,
		};
	}

	const configured = resolveConfiguredNodePath(input.configuredPath);
	if (configured) {
		if (!existsSync(configured)) {
			return notFound(`无法执行配置的 Node 路径：${configured}`, system, configured);
		}
		const probe = await probeExecutable(configured);
		if (!probe) return notFound(`无法执行配置的 Node 路径：${configured}`, system, configured);
		const shimmed = !isRunnableRunnerNode(configured, platform);
		const compatible = !shimmed && isDshRunnerNodeCompatible(probe.version);
		return {
			source: "configured",
			executable: configured,
			resolvedPath: probe.resolvedPath,
			version: probe.version,
			error: shimmed ? shimError(configured, probe.version) : compatible ? null : incompatibleError(probe.version),
			compatible,
			system,
		};
	}

	if (system) {
		const shimmed = system.shimmed === true;
		const compatible = !shimmed && isDshRunnerNodeCompatible(system.version);
		return {
			source: system.source,
			executable: system.resolvedPath,
			resolvedPath: system.resolvedPath,
			version: system.version,
			error: shimmed ? shimError(system.resolvedPath, system.version) : compatible ? null : incompatibleError(system.version),
			compatible,
			system,
		};
	}

	return notFound(`未检测到 Node ${DSH_RUNNER_NODE_MAJOR}。可在开发设置里一键下载 PiDeck 专用副本（走应用更新源，不改系统 PATH），或手动指定本机 node.exe。`, null, "");
}

function notFound(error: string, system: DshRunnerNodeSystemProbe | null, executable: string): DshRunnerNodeInfo {
	return {
		source: "not-found",
		executable,
		resolvedPath: "",
		version: "",
		error,
		compatible: false,
		system,
	};
}

/** host fork 用：只返回可 spawn 的兼容绝对路径。 */
export async function resolveDshRunnerNodePath(input: DetectDshRunnerNodeInput = {}): Promise<string | undefined> {
	if ((input.platform ?? process.platform) !== "win32") return undefined;
	const platform = input.platform ?? process.platform;
	const info = await detectDshRunnerNode(input);
	if (info.compatible && info.resolvedPath) return info.resolvedPath;
	// 手动路径/PATH 钉在 22/25（或指到垫片）时，仍用自动探测到的 24 或 userData 专用副本。
	if (info.system && info.system.shimmed !== true && isDshRunnerNodeCompatible(info.system.version) && info.system.resolvedPath) {
		return info.system.resolvedPath;
	}
	// env 指到垫片时也别再回退到它，宁可走 userData 专用副本 / 旧 electron runner 备用路径。
	const envPath = input.envPath && isRunnableRunnerNode(input.envPath, platform) ? input.envPath : undefined;
	return resolveDshRunnerNodeSidecar({
		platform,
		envPath,
		userDataPath: input.userDataPath ?? undefined,
		resourcesPath: input.resourcesPath ?? undefined,
		appPath: input.appPath ?? undefined,
	});
}
