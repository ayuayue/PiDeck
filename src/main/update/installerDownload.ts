/**
 * 安装包流式下载 + 完整性校验（ChannelSwitchService 与手动应用更新共用）。
 *
 * 数据完整性底线：
 * - 只允许 https 与不含路径分隔/上跳的文件名（落盘路径必须锁在 targetDir）；
 * - 先写 `<name>.part-*`，校验通过后再原子 rename；失败/中断清理 part，绝不留下半个安装包；
 * - GitHub 资产带 digest（"sha256:hex"）时强制比对；缺失才跳过并记日志；
 * - 背压：write 返回 false 时等 drain，主进程不整包驻留内存。
 */

import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getAppLogger } from "../logging/sharedLogger";

export type InstallerDownloadProgress = {
	/** 0-99 的下载进度；完成由调用方统一置 100。 */
	percent: number;
	transferred: number;
	total: number;
	bytesPerSecond: number;
};

export type InstallerNetFetch = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

export type DownloadInstallerAssetOptions = {
	assetName: string;
	assetUrl: string;
	/** GitHub 资产 digest（"sha256:hex"）；缺失则跳过校验并记录日志。 */
	digestSha256?: string;
	/** 落盘目录（由调用方决定：频道切换用 temp，手动更新用系统 Downloads）。 */
	targetDir: string;
	netFetch: InstallerNetFetch;
	signal?: AbortSignal;
	onProgress?: (progress: InstallerDownloadProgress) => void;
};

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 文件名只允许 basename；URL 必须 https。两条都是跨 IPC 入参的边界校验。 */
export function assertSafeInstallerAsset(assetName: string, assetUrl: string): void {
	if (typeof assetName !== "string" || assetName === "" || assetName.includes("/") || assetName.includes("\\") || assetName.includes("..")) {
		throw new Error(`非法安装包文件名：${String(assetName)}`);
	}
	if (typeof assetUrl !== "string" || !assetUrl.startsWith("https://")) {
		throw new Error(`非法下载地址：${String(assetUrl)}`);
	}
}

/** 下载并校验安装包，返回最终绝对路径。 */
export async function downloadInstallerAsset(options: DownloadInstallerAssetOptions): Promise<string> {
	const { assetName, assetUrl, targetDir } = options;
	assertSafeInstallerAsset(assetName, assetUrl);
	mkdirSync(targetDir, { recursive: true });
	const filePath = join(targetDir, assetName);
	const partPath = `${filePath}.part-${process.pid}-${Date.now()}`;
	const hash = createHash("sha256");
	const startedAt = Date.now();
	let stream: ReturnType<typeof createWriteStream> | null = null;
	let streamErrorPromise: Promise<never>;

	const emitProgress = (received: number, total: number, percent: number) => {
		if (!options.onProgress) return;
		const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
		options.onProgress({
			percent,
			transferred: received,
			total,
			bytesPerSecond: Math.round(received / elapsedSeconds),
		});
	};

	try {
		const response = await options.netFetch(assetUrl, options.signal ? { signal: options.signal } : undefined);
		if (!response.ok) {
			throw new Error(`安装包下载失败：HTTP ${response.status}`);
		}
		const body = response.body;
		if (!body) {
			throw new Error("安装包下载失败：响应无内容体");
		}
		const contentLength = Number(response.headers.get("content-length") ?? "");
		const total = Number.isFinite(contentLength) && contentLength > 0 ? contentLength : 0;
		stream = createWriteStream(partPath);
		// 永久错误监听：写盘错误不能让主进程因未处理的 'error' 事件崩溃。
		// 派生一个带 catch 的 promise，避免无人 await 时成为 unhandled rejection。
		streamErrorPromise = new Promise<never>((_, reject) => {
			stream?.once("error", reject);
		});
		streamErrorPromise.catch(() => undefined);

		let received = 0;
		let lastPercent = -1;
		const reader = body.getReader();
		for (;;) {
			if (options.signal?.aborted) throw new Error("安装包下载已取消");
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			hash.update(value);
			received += value.byteLength;
			// 背压处理：写缓冲满时等 drain（或写盘错误），避免大安装包把主进程内存顶高。
			if (!stream.write(value)) {
				await Promise.race([once(stream, "drain"), streamErrorPromise]);
			}
			if (total > 0) {
				const percent = Math.min(99, Math.floor((received / total) * 100));
				if (percent > lastPercent) {
					lastPercent = percent;
					emitProgress(received, total, percent);
				}
			}
		}
		await Promise.race([
			new Promise<void>((resolve, reject) => {
				stream?.once("error", reject);
				stream?.end(() => resolve());
			}),
			streamErrorPromise,
		]);

		if (options.digestSha256) {
			const normalizedDigest = options.digestSha256.trim().toLowerCase();
			const expected = normalizedDigest.startsWith("sha256:") ? normalizedDigest.slice("sha256:".length) : null;
			if (expected === null) {
				throw new Error(`安装包 digest 格式无法识别：${options.digestSha256}`);
			}
			const actual = hash.digest("hex");
			if (actual !== expected) {
				throw new Error(`安装包 digest mismatch：期望 ${expected}，实际 sha256:${actual}`);
			}
		} else {
			getAppLogger()?.info("installerDownload", "发行物未提供 digest，跳过完整性校验", assetName);
		}

		// 校验通过后再替换旧文件：Windows 的 rename 不能覆盖已存在目标，先删再 rename。
		rmSync(filePath, { force: true });
		renameSync(partPath, filePath);
		emitProgress(received, total > 0 ? total : received, 100);
		return filePath;
	} catch (error) {
		try {
			// Windows 上文件句柄未释放时 rm 会 EBUSY：先等 close，再做清理。
			if (stream && !stream.closed) {
				await new Promise<void>((resolve) => {
					stream?.once("close", resolve);
					stream?.destroy();
				});
			} else {
				stream?.destroy();
			}
		} catch {
			// destroy 只做尽量清理；真正的失败原因由下面抛出。
		}
		try {
			rmSync(partPath, { force: true });
		} catch (cleanupError) {
			// 清理失败不能覆盖原始下载错误（残留 part 下次下载会生成新名字，不影响正确性）。
			getAppLogger()?.warn("installerDownload", "安装包临时文件清理失败", { partPath, error: toErrorMessage(cleanupError) });
		}
		getAppLogger()?.warn("installerDownload", "安装包下载失败", { assetName, error: toErrorMessage(error) });
		throw error;
	}
}
