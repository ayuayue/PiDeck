import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync } from "node:fs";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { DshRunnerNodeInstallResult } from "../../shared/types/dshRunnerNode";
import {
	DSH_RUNNER_NODE_INDEX_FILE,
	DSH_RUNNER_NODE_SIDECAR_VERSION,
	defaultDshRunnerNodeIndexUrl,
	dshRunnerNodeAssetDownloadUrl,
	dshRunnerNodeSidecarArch,
	dshRunnerNodeZipInnerDir,
	dshRunnerNodeZipName,
	selectDshRunnerNodeRelease,
	type DshRunnerNodeArch,
	type DshRunnerNodeRelease,
	type DshRunnerNodeReleaseIndex,
} from "../../shared/types/dshRunnerNodeRelease";
import type { UpdateSourceId } from "../../shared/types/settings";
import { isDshRunnerNodeCompatible, parseNodeVersion } from "./dshRunnerNode";
import { dshRunnerNodeUserDataSidecar } from "./dshRunnerNodeSidecar";
import { getAppLogger } from "../logging/sharedLogger";

const execFileAsync = promisify(execFile);

export { DSH_RUNNER_NODE_SIDECAR_VERSION, dshRunnerNodeSidecarArch, dshRunnerNodeZipInnerDir, dshRunnerNodeZipName };

export type DshRunnerNodeDownloader = (url: string, destPath: string, onProgress?: (received: number, total?: number) => void, signal?: AbortSignal) => Promise<void>;

export type DshRunnerNodeIndexFetcher = (url: string) => Promise<DshRunnerNodeReleaseIndex | null>;

export type InstallDshRunnerNodeInput = {
	userDataPath: string;
	platform?: NodeJS.Platform;
	arch?: string;
	version?: string;
	force?: boolean;
	updateSource?: UpdateSourceId;
	/** 覆盖默认索引（测试 / 内网）；空串走内置 AtomGit/GitHub latest 应用 Release。 */
	indexUrl?: string;
	download?: DshRunnerNodeDownloader;
	fetchIndex?: DshRunnerNodeIndexFetcher;
	extract?: (zipPath: string, destDir: string, innerExeRel: string) => Promise<string>;
	probeVersion?: (executable: string) => Promise<string>;
	sha256OfFile?: (filePath: string) => Promise<string>;
	onProgress?: (received: number, total?: number) => void;
	signal?: AbortSignal;
};

function resolveSystemTar(): string | null {
	const windowsTar = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`;
	if (existsSync(windowsTar)) return windowsTar;
	return "tar";
}

/** 用系统 tar 只抽出 zip 里的 node.exe，不解整个发行包。 */
export async function extractNodeExeFromZip(zipPath: string, destDir: string, innerExeRel: string): Promise<string> {
	const tarBin = resolveSystemTar();
	if (!tarBin) throw new Error("系统 tar 不可用，无法解压 Node 压缩包");
	mkdirSync(destDir, { recursive: true });
	await execFileAsync(tarBin, ["-xf", zipPath, "-C", destDir, innerExeRel], {
		windowsHide: true,
	});
	return join(destDir, innerExeRel);
}

async function defaultProbeVersion(executable: string): Promise<string> {
	const { stdout } = await execFileAsync(executable, ["-v"], {
		timeout: 5_000,
		windowsHide: true,
	});
	return parseNodeVersion(stdout);
}

async function defaultSha256(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	const stream = createReadStream(filePath);
	for await (const chunk of stream) hash.update(chunk as Buffer);
	return hash.digest("hex");
}

/**
 * 把索引条目的 url 改成当前更新源 latest 应用 Release 的资产。
 * 打包脚本写的是 nodejs.org 占位；客户端永远按 latest 拉，国内默认 AtomGit。
 */
export function resolveDshRunnerNodeReleaseUrl(release: DshRunnerNodeRelease, source: UpdateSourceId, arch: DshRunnerNodeArch, version: string): string {
	if (release.url.startsWith("file:") || /^[a-zA-Z]:[\\/]/.test(release.url) || release.url.startsWith("/")) {
		return release.url;
	}
	return dshRunnerNodeAssetDownloadUrl(source, dshRunnerNodeZipName(version, arch));
}

export function resolveDshRunnerNodeIndexUrl(input: { indexUrl?: string; updateSource?: UpdateSourceId }): string {
	const override = input.indexUrl?.trim();
	if (override) return override;
	return defaultDshRunnerNodeIndexUrl(input.updateSource ?? "atomgit");
}

/**
 * 下载 Node 24 的 CUI node.exe 到 `<userData>/dsh-runner-node/`。
 * 源是当前 latest 应用 Release（AtomGit/GitHub），不改 PATH、不直连 nodejs.org。
 */
export async function installDshRunnerNodeSidecar(input: InstallDshRunnerNodeInput): Promise<DshRunnerNodeInstallResult> {
	const platform = input.platform ?? process.platform;
	if (platform !== "win32") {
		return { ok: false, error: "仅 Windows 需要单独的 Node 24 沙箱副本" };
	}
	const version = input.version ?? DSH_RUNNER_NODE_SIDECAR_VERSION;
	const destExe = dshRunnerNodeUserDataSidecar(input.userDataPath, platform);
	const destDir = dirname(destExe);
	const probe = input.probeVersion ?? defaultProbeVersion;

	if (!input.force && existsSync(destExe)) {
		try {
			const existing = await probe(destExe);
			if (isDshRunnerNodeCompatible(existing)) {
				return { ok: true, path: destExe, version: existing };
			}
		} catch {
			// 损坏副本走重新下载
		}
	}

	const download = input.download;
	const fetchIndex = input.fetchIndex;
	if (!download || !fetchIndex) {
		return { ok: false, error: "下载器未装配" };
	}

	const arch = dshRunnerNodeSidecarArch(input.arch);
	const source = input.updateSource ?? "atomgit";
	const indexUrl = resolveDshRunnerNodeIndexUrl({ indexUrl: input.indexUrl, updateSource: source });
	const index = await fetchIndex(indexUrl);
	if (!index || !Array.isArray(index.releases)) {
		return { ok: false, error: `无法读取 Node 24 下载索引：${indexUrl}` };
	}
	const release = selectDshRunnerNodeRelease(index.releases, arch, version);
	if (!release) {
		return {
			ok: false,
			error: `索引中没有 Node ${version} win-${arch}（${DSH_RUNNER_NODE_INDEX_FILE}）`,
		};
	}

	const url = resolveDshRunnerNodeReleaseUrl(release, source, arch, version);
	const zipPath = join(destDir, dshRunnerNodeZipName(version, arch));
	const innerRel = `${dshRunnerNodeZipInnerDir(version, arch)}/node.exe`;
	const extract = input.extract ?? extractNodeExeFromZip;
	const sha256OfFile = input.sha256OfFile ?? defaultSha256;

	mkdirSync(destDir, { recursive: true });
	// 下载外部 Node 二进制并替换已安装文件，属供应链相关落盘动作，来源必须可审计
	getAppLogger()?.info("dsh-runner", "Node 24 runner download started", { url, version, arch, destExe });
	try {
		await download(url, zipPath, input.onProgress, input.signal);
		const actual = await sha256OfFile(zipPath);
		if (actual.toLowerCase() !== release.sha256.toLowerCase()) {
			getAppLogger()?.error("dsh-runner", "Node 24 package checksum mismatch", { url, expected: release.sha256, actual });
			return { ok: false, error: "Node 24 压缩包校验失败（sha256 不匹配）" };
		}
		const extracted = await extract(zipPath, destDir, innerRel);
		if (!existsSync(extracted)) {
			return { ok: false, error: `解压后未找到 ${innerRel}` };
		}
		await rm(destExe, { force: true });
		renameSync(extracted, destExe);
		await rm(join(destDir, dshRunnerNodeZipInnerDir(version, arch)), { recursive: true, force: true });
		const installed = await probe(destExe);
		if (!isDshRunnerNodeCompatible(installed)) {
			return { ok: false, error: `下载到的 Node 版本不兼容：${installed || "未知"}` };
		}
		getAppLogger()?.info("dsh-runner", "Node 24 runner installed", { path: destExe, version: installed });
		return { ok: true, path: destExe, version: installed };
	} catch (error) {
		getAppLogger()?.warn("dsh-runner", "Node 24 runner install failed", { url, error: error instanceof Error ? error.message : String(error) });
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	} finally {
		await rm(zipPath, { force: true });
	}
}
