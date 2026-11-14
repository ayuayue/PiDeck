import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { PIDECK_PI_PROXY_SCOPE, buildPiProxyEnvPatch } from "../../sessions/sessionProxyPolicy";
import type { AppSettings } from "../../../shared/types";

/**
 * 子进程环境域（PiLocator 拆分第三刀）：PATH 组装、Electron 宿主 env 消毒、代理注入。
 *
 * 只有「怎么给 pi 子进程准备 env」这一件事，不决定启动哪个 pi、也不发起探测。
 * 搜索目录由宿主以 thunk 传入（`getSearchDirs`），避免本模块反向依赖宿主。
 * 注释是现场结论（Windows 双写 Path、NODE_OPTIONS 里 electron/asar 会污染扩展加载），搬动时不要删。
 */

/** 代理设置切片：`createProcessEnv` 只需要这三个字段。 */
export type PiProxySettings = Pick<AppSettings, "piProxyEnabled" | "piProxyUrl" | "piProxyBypass">;

export function createPiProcessEnv(settings: PiProxySettings | undefined, pathPrefix: string | undefined, wsl: { distro: string; user: string; piCommand: string } | undefined, getSearchDirs: () => string[]) {
	if (wsl) {
		// WSL 模式：保留原始 PATH 以便找到 wsl.exe（在 System32 中），
		// 同时注入代理环境变量（wsl.exe 子进程通过 Windows 网络栈访问外网）。
		const pathValue = pathPrefix || process.env.PATH || process.env.Path || "";
		const base = sanitizePiChildEnv({
			...process.env,
			// Windows cmd 读 Path；部分宿主只改 PATH 会导致 .cmd shim 找不到 node
			PATH: pathValue,
			...(process.platform === "win32" ? { Path: pathValue } : {}),
		});
		return applyPiProxyEnv(base, settings);
	}
	const searchDirs = pathPrefix ? [pathPrefix, ...getSearchDirs().filter((dir) => dir !== pathPrefix)] : getSearchDirs();
	const pathValue = searchDirs.join(delimiter);
	const env = sanitizePiChildEnv({
		...process.env,
		PATH: pathValue,
		// 同步 Path：Windows 下 Node 对 env 键大小写不敏感，但显式双写更稳
		...(process.platform === "win32" ? { Path: pathValue } : {}),
	});

	return applyPiProxyEnv(env, settings);
}

/**
 * 给 pi 子进程消毒 Electron 宿主环境。
 * 桌面端主进程 env 常带 ELECTRON_* / 可能含 electron 注入的 NODE_OPTIONS；
 * 原样继承后 jiti 加载扩展或子进程行为可能与终端 CLI 不一致。
 */
export function sanitizePiChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const next: NodeJS.ProcessEnv = { ...env };
	// 该标记只能由本次 PiDeck 代理 patch 重新写入，不能从宿主环境或用户 shell 继承。
	delete next[PIDECK_PI_PROXY_SCOPE];

	for (const key of Object.keys(next)) {
		if (key.startsWith("ELECTRON_") || key === "ELECTRON_RUN_AS_NODE") {
			delete next[key];
			continue;
		}
		if (key.startsWith("CHROME_") || key.startsWith("GOOGLE_API_")) {
			delete next[key];
		}
	}

	const nodeOptions = next.NODE_OPTIONS;
	if (typeof nodeOptions === "string" && nodeOptions.trim()) {
		const cleaned = nodeOptions
			.split(/\s+/)
			.filter((token) => {
				if (!token) return false;
				const lower = token.toLowerCase();
				return !(lower.includes("electron") || lower.includes("asar") || lower.includes("app.asar") || lower.includes("electron-vite"));
			})
			.join(" ")
			.trim();
		if (cleaned) next.NODE_OPTIONS = cleaned;
		else delete next.NODE_OPTIONS;
	}

	return next;
}

function applyPiProxyEnv(env: NodeJS.ProcessEnv, settings?: PiProxySettings) {
	// 代理 env 的组装规则（含为什么必须带 NODE_USE_ENV_PROXY）集中在
	// sessionProxyPolicy.buildPiProxyEnvPatch，与 DSH host 共用同一套语义，避免两处漂移。
	const patch = buildPiProxyEnvPatch(settings);
	return patch ? { ...env, ...patch } : env;
}

export function getCommandBinDir(command: string) {
	if (!/[\\/]/.test(command) || !existsSync(command)) return undefined;
	const binDir = dirname(command);
	// npm/nvm/asdf/mise shims resolve Node through env/PATH. Prepending the shim's own
	// bin directory keeps that lookup on the Node version that installed pi, instead
	// of a different Node inherited from Finder/Explorer/Electron.
	const nodeName = process.platform === "win32" ? "node.exe" : "node";
	return existsSync(join(binDir, nodeName)) ? binDir : undefined;
}
