import { dirname, join } from "node:path";

/**
 * 引导安装（便携副本）在 PiDeck 数据目录里的路径约定——**唯一来源**。
 *
 * 为什么单独成模块：这套相对层级同时被三处用到（便携 Node 安装器、PiLocator 的扫描目录、
 * IPC 里的便携 npm 解析）。各处自己拼一次迟早漂移，而漂移的代价很大：
 * 2026-09-30 实测 Linux 上少了一层 `bin/`，表现为「引导装完 pi → 重新检测说没装 →
 * 又引导你再装一遍」，以及「便携 node 永远被判未安装」。
 *
 * **平台差异（必须记牢）**：
 * - POSIX：npm 全局可执行放 `<prefix>/bin`（`pi-global/bin/pi`），官方 node tar 包放
 *   `<release>/bin/node`。
 * - Windows：npm 全局 shim 直接放 `<prefix>`（`pi-global\pi.cmd`），node zip 的 `node.exe`
 *   在发行包根目录。
 *
 * 本模块必须保持零 Electron / 零 Node 运行时副作用（只依赖 node:path），
 * 因为 PiLocator 会在裸 Node 沙箱里被加载（测试与检测链路都要求轻量）。
 */

/** `<userData>/pi-runtime` 根目录。 */
export function piRuntimeRootDir(userDataPath: string): string {
	return join(userDataPath, "pi-runtime");
}

/** 便携 Node 发行包解压根目录（`<root>/node`）。 */
export function piRuntimeNodeDir(userDataPath: string): string {
	return join(piRuntimeRootDir(userDataPath), "node");
}

/**
 * 便携 node 可执行文件路径。
 * POSIX 官方 tar 包的可执行文件在 `bin/` 下，Windows 官方 zip 的 `node.exe` 在发行包根目录；
 * 我们解压后把发行包整层内容平铺到 `<root>/node/`，所以这一层相对路径必须跟平台走。
 */
export function piRuntimeNodeExePath(userDataPath: string, platform: NodeJS.Platform = process.platform): string {
	const exe = platform === "win32" ? "node.exe" : join("bin", "node");
	return join(piRuntimeNodeDir(userDataPath), exe);
}

/**
 * 便携 node 的可执行文件所在目录。
 * 两个用途：给 pi 子进程前置 PATH（pi 的 shim 是 `#!/usr/bin/env node`，没有系统 node 的
 * 机器上必须能找到同目录的 node），以及定位同目录的便携 npm。
 */
export function piRuntimeNodeBinDir(userDataPath: string, platform: NodeJS.Platform = process.platform): string {
	return dirname(piRuntimeNodeExePath(userDataPath, platform));
}

/** 引导安装的 pi 的 npm 安装前缀（`npm install -g --prefix` 的目标）。 */
export function piRuntimePiPrefixDir(userDataPath: string): string {
	return join(piRuntimeRootDir(userDataPath), "pi-global");
}

/**
 * 引导安装的 pi 可执行文件所在目录（即 PiLocator 要扫描的目录）。
 * POSIX 是 `<prefix>/bin`（npm 全局 bin），Windows 是 `<prefix>` 本身。
 */
export function piRuntimePiBinDir(userDataPath: string, platform: NodeJS.Platform = process.platform): string {
	const prefix = piRuntimePiPrefixDir(userDataPath);
	return platform === "win32" ? prefix : join(prefix, "bin");
}
