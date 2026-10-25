/**
 * pi 运行时便携 Node 的按需分发契约。
 *
 * 背景：全新机器上没有 Node/npm 时，PiDeck 的环境引导只能停在「打开 nodejs.org」外链，
 * 链路断裂。这里定义一条与 DSH runner node 同构、但面向最终用户的便携安装链路：
 * 下载官方 Node 发行包（zip/tar.gz）→ sha256 校验 → 解压到 <userData>/pi-runtime/node/
 * → node 自带 npm → 随后用户可一键 `npm install -g` pi（--prefix 指向 pi-runtime）。
 *
 * 与 DSH sidecar 共用同一份官方完整发行包资产（DSH 解压时只抽 node.exe，pi 引导全解）。
 * 下载源回退链见 piRuntimeNodeDownloadUrls：npmmirror → 自有 Release（win32）→
 * 华为云 → nodejs.org 官方；哈希直接固化在代码里，不需要再维护一份索引清单。
 */

import { atomGitFeedUrl, gitHubLatestDownloadBase } from "../updateSources";

/** 引导安装的 Node 版本。与项目 CI / DSH sidecar 对齐的 Node 24 LTS 线。 */
export const PI_RUNTIME_NODE_VERSION = "24.13.0";

/** 官方 SHASUMS256.txt（v24.13.0）中各平台发行包的哈希，写死做离线校验，防镜像被篡改。 */
export const PI_RUNTIME_NODE_SHA256: Readonly<Record<string, string>> = {
	"win32-x64": "ca2742695be8de44027d71b3f53a4bdb36009b95575fe1ae6f7f0b5ce091cb88",
	"win32-arm64": "92b9f9b0c0c123e11e4afc535f0ec19cd987465eea506427553a49971364158a",
	"darwin-x64": "6f03c1b48ddbe1b129a6f8038be08e0899f05f17185b4d3e4350180ab669a7f3",
	"darwin-arm64": "d595961e563fcae057d4a0fb992f175a54d97fcc4a14dc2d474d92ddeea3b9f8",
	"linux-x64": "6223aad1a81f9d1e7b682c59d12e2de233f7b4c37475cd40d1c89c42b737ffa8",
	"linux-arm64": "0f6d40b94c6a2eb6b4c240ffc8b9fd3ada7ab044c177dd413c06e1ef9a63f081",
};

export type PiRuntimePlatform = "win32" | "darwin" | "linux";
export type PiRuntimeArch = "x64" | "arm64";

/** 发行包文件名：Windows 是 zip，mac/Linux 是 tar.gz，与 nodejs.org/dist 命名一致。 */
export function piRuntimeNodeArchiveName(platform: PiRuntimePlatform, arch: PiRuntimeArch): string {
	const version = PI_RUNTIME_NODE_VERSION;
	if (platform === "win32") return `node-v${version}-win-${arch}.zip`;
	return `node-v${version}-${platform}-${arch}.tar.gz`;
}

/** 官方发行包 URL（nodejs.org/dist）。仅作回退链末位与打包脚本参考，客户端优先国内镜像。 */
export function officialPiRuntimeNodeUrl(platform: PiRuntimePlatform, arch: PiRuntimeArch): string {
	return `https://nodejs.org/dist/v${PI_RUNTIME_NODE_VERSION}/${piRuntimeNodeArchiveName(platform, arch)}`;
}

/**
 * npmmirror（阿里 binary 镜像）目录与 nodejs.org/dist 完全同构，国内网络首选。
 * 华为云镜像同样同步官方 dist 目录，作为后续回退。
 */
export const PI_RUNTIME_NODE_MIRRORS = ["https://npmmirror.com/mirrors/node", "https://mirrors.huaweicloud.com/nodejs"] as const;

/**
 * PiDeck 自有 Release 资产（AtomGit/GitHub latest）兜底：DSH runner node 打包流程
 * 已经把 win-x64/arm64 官方完整 zip（含 npm，sha256 与官方 SHASUMS 一致）挂到了
 * latest 应用 Release 上，Windows 可直接复用；mac/Linux 无该资产，不在此列。
 */
export function piRuntimeNodeReleaseAssetUrls(arch: PiRuntimeArch): string[] {
	const file = piRuntimeNodeArchiveName("win32", arch);
	return [`${atomGitFeedUrl()}/${encodeURIComponent(file)}`, `${gitHubLatestDownloadBase()}/${encodeURIComponent(file)}`];
}

/**
 * 按回退顺序返回全部候选下载 URL。
 * win32：npmmirror → AtomGit（自有兜底）→ GitHub（自有兜底）→ 华为云 → 官方；
 * 其他平台：npmmirror → 华为云 → 官方（Release 上无对应资产）。
 */
export function piRuntimeNodeDownloadUrls(platform: PiRuntimePlatform, arch: PiRuntimeArch): string[] {
	const file = piRuntimeNodeArchiveName(platform, arch);
	const mirrorUrls = PI_RUNTIME_NODE_MIRRORS.map((mirror) => `${mirror}/v${PI_RUNTIME_NODE_VERSION}/${file}`);
	// 自有 Release 资产插在 npmmirror 之后：优先用最快的公共镜像，
	// 第三方镜像异常时回落到自有资产（DSH 链路已验证可用）。
	const releaseAssetUrls = platform === "win32" ? piRuntimeNodeReleaseAssetUrls(arch) : [];
	return [...mirrorUrls.slice(0, 1), ...releaseAssetUrls, ...mirrorUrls.slice(1), officialPiRuntimeNodeUrl(platform, arch)];
}

/** 解压后发行包内层目录名（官方命名，zip/tar 一致）。 */
export function piRuntimeNodeInnerDir(platform: PiRuntimePlatform, arch: PiRuntimeArch): string {
	return platform === "win32" ? `node-v${PI_RUNTIME_NODE_VERSION}-win-${arch}` : `node-v${PI_RUNTIME_NODE_VERSION}-${platform}-${arch}`;
}

/** 平台映射：process.platform → 契约平台；不认识的平台返回 null（不提供引导安装）。 */
export function toPiRuntimePlatform(platform: string): PiRuntimePlatform | null {
	return platform === "win32" || platform === "darwin" || platform === "linux" ? platform : null;
}

/** 架构映射：只支持 x64/arm64，其余（如 32 位）返回 null。 */
export function toPiRuntimeArch(arch: string): PiRuntimeArch | null {
	return arch === "x64" || arch === "arm64" ? arch : null;
}

/** 便携 Node 副本状态（给渲染层的检测结果）。 */
export type PiRuntimeNodeStatus = {
	/** 便携副本已安装且版本可执行 */
	installed: boolean;
	/** 便携副本 node 绝对路径 */
	path?: string;
	/** `node -v` 输出（如 v24.13.0） */
	version?: string;
	/** 当前系统是否有可用的 node（不区分来源，用于判断是否需要引导安装） */
	systemNodeAvailable: boolean;
	/** 系统 node 版本（仅 systemNodeAvailable 时有值） */
	systemNodeVersion?: string;
	/** 当前平台是否支持一键安装（win32/darwin/linux + x64/arm64 之外不支持） */
	installSupported: boolean;
	error?: string;
};

/** 便携 Node 安装结果。 */
export type PiRuntimeNodeInstallResult = {
	ok: boolean;
	path?: string;
	version?: string;
	/** 实际命中的下载源（npmmirror / huaweicloud / nodejs.org），用于展示与排障 */
	source?: string;
	error?: string;
};

/** 便携 Node 安装进度事件（渲染层展示下载百分比）。 */
export type PiRuntimeNodeInstallProgress = {
	/** install | verify | extract | probe 阶段 */
	stage: "download" | "verify" | "extract" | "probe";
	receivedBytes?: number;
	totalBytes?: number;
};
