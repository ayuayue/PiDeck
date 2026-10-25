import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * DSH 沙箱 runner 的 CUI node sidecar（Windows 黑窗口根治 B 方案）。
 *
 * 官方 dsh-web 用 node.exe（控制台子系统）跑 runner，子进程继承已有控制台。
 * PiDeck 的 host 在 Electron utilityProcess 里，`process.execPath` 是 electron.exe
 * （GUI 子系统）。GUI 父进程再拉 GUI runner 时 Windows 会为 pwsh 新建可见控制台；
 * 给 runner AllocConsole 再 Hide 又会闪一帧。
 *
 * 把第一级 / 第二级 runner 的可执行文件换成随包 node.exe 后，runner 本身是 CUI：
 * 用 CREATE_NO_WINDOW 自建无窗口可继承控制台即可，不必再 AllocConsole。
 * 受限 token 的 CreateProcessAsUserW（pwsh）必须继承这份控制台，不能自己再
 * CREATE_NO_WINDOW（否则 STATUS_DLL_INIT_FAILED）。
 *
 * 仅 Windows 需要这份 sidecar；macOS / Linux 的 electron 当 Node 跑没有 GUI 子系统问题。
 */

export const DSH_RUNNER_NODE_ENV = "PIDECK_DSH_RUNNER_NODE";
export const DSH_RUNNER_NODE_DIRNAME = "dsh-runner-node";

/** 当前平台 sidecar 文件名（Windows 必须是 node.exe，否则 CreateProcess 找不到）。 */
export function dshRunnerNodeFileName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "node.exe" : "node";
}

export interface ResolveDshRunnerNodeSidecarInput {
	platform?: NodeJS.Platform;
	/** Electron `process.resourcesPath`（旧包 extraResources 残留，仅兜底）。 */
	resourcesPath?: string;
	/** `app.getAppPath()`：dev 是项目根，打包是 app.asar。 */
	appPath?: string;
	/** 应用数据目录：一键下载的专用 Node 24 落在这里，不进系统 PATH。 */
	userDataPath?: string;
	/** 显式覆盖（dev.js / 测试）。空串视为未设。 */
	envPath?: string;
	/** 设置里的用户路径。空串视为未设。 */
	configuredPath?: string;
}

/** userData 里 PiDeck 专用 node.exe（一键下载产物）。 */
export function dshRunnerNodeUserDataSidecar(userDataPath: string, platform: NodeJS.Platform = "win32"): string {
	return join(userDataPath, DSH_RUNNER_NODE_DIRNAME, dshRunnerNodeFileName(platform));
}

/**
 * 只解析「已落盘的专用副本」（userData / 旧包残留），不含 env 与用户配置。
 * 给自动探测用：配置路径另外处理，避免坏配置把 sidecar 盖掉。
 */
export function resolveInstalledDshRunnerNodeSidecar(input: Pick<ResolveDshRunnerNodeSidecarInput, "platform" | "resourcesPath" | "appPath" | "userDataPath">): string | undefined {
	const platform = input.platform ?? "win32";
	if (platform !== "win32") return undefined;
	const fileName = dshRunnerNodeFileName(platform);
	if (input.userDataPath) {
		const fromUserData = dshRunnerNodeUserDataSidecar(input.userDataPath, platform);
		if (existsSync(fromUserData)) return fromUserData;
	}
	const packaged = input.resourcesPath ? join(input.resourcesPath, DSH_RUNNER_NODE_DIRNAME, fileName) : undefined;
	if (packaged && existsSync(packaged)) return packaged;
	if (input.appPath) {
		const fromApp = join(input.appPath, "resources", DSH_RUNNER_NODE_DIRNAME, fileName);
		if (existsSync(fromApp)) return fromApp;
	}
	return undefined;
}

/**
 * 解析磁盘上已存在的 CUI node（不做 --version）。
 * 优先级：env → 用户配置 → userData 专用副本 → 旧包 extraResources 残留。
 * 系统 PATH / 版本管理器探测走 `detectDshRunnerNode`，不要在这里 spawn。
 */
export function resolveDshRunnerNodeSidecar(input: ResolveDshRunnerNodeSidecarInput): string | undefined {
	const platform = input.platform ?? "win32";
	if (platform !== "win32") return undefined;
	const envPath = input.envPath?.trim();
	if (envPath && existsSync(envPath)) return envPath;
	const configured = input.configuredPath?.trim();
	if (configured && existsSync(configured)) return configured;
	return resolveInstalledDshRunnerNodeSidecar(input);
}
