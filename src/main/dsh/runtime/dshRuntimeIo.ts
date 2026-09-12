/**
 * DSH runtime 的 IO 适配层（下载与解压的真实实现）。
 *
 * 与 DshRuntimeManager 分离：管理器只管编排与校验规则，IO 是可替换的实现细节
 * （测试注入替身，不碰网络与 tar）。两处都遵守 PiDeck 既有约定：
 * - 下载走 Electron `net`（尊重应用代理设置，与 app update 同源），不走 node fetch；
 * - 解压优先走系统自带 tar（Windows/macOS/Linux 均有，原生实现快约 5 倍），
 *   npm `tar`（纯 JS、无原生模块）作为兜底，保证安全语义一致（见方案文档 §5）。
 */
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { net } from "electron";
import * as tar from "tar";
import type { DshRuntimeReleaseIndex } from "../../../shared/types/dshRuntimeManifest";
import { isSafeArchiveEntry, type DshRuntimeDownloader, type DshRuntimeExtractor } from "./DshRuntimeManager";

/** 重定向跟随上限：GitHub Release 资产会 302 到对象存储，正常 1~2 跳。 */
const MAX_REDIRECTS = 5;

/** 各平台的系统 tar 路径：Windows 自带 bsdtar（Win10 1803+），macOS 自带 bsdtar，Linux 探测常见安装位置（GNU tar 或 bsdtar）。 */
function resolveSystemTar(): string | null {
	if (process.platform === "win32") {
		const windowsTar = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\tar.exe`;
		return existsSync(windowsTar) ? windowsTar : null;
	}
	if (process.platform === "darwin") {
		// macOS 一直自带 /usr/bin/tar（bsdtar）。
		return existsSync("/usr/bin/tar") ? "/usr/bin/tar" : null;
	}
	// Linux：GUI 启动的 PATH 不保证完整，直接探测常见位置（/bin 多为 /usr/bin 的符号链接）。
	for (const candidate of ["/usr/bin/tar", "/bin/tar"]) {
		if (existsSync(candidate)) return candidate;
	}
	return null;
}
const execFileAsync = promisify(execFile);

/**
 * 解压 tar/tar.gz 到目标目录。
 * 只接受安全条目（拒绝绝对路径与 `..` 逃逸），越界的条目直接丢弃——tar slip 会让
 * 归档写穿数据目录，宁可装不上也不能装出洞。
 *
 * 性能：runtime 归档约 4.4 万个小文件，纯 JS 的 npm tar 解压实测 ~80s；系统自带 tar
 * （Windows System32\tar.exe / macOS /usr/bin\tar / Linux /usr/bin\tar）原生实现实测
 * ~16s（快约 5 倍）。三个平台都优先走系统 tar 两遍式（先 `-tf` 列出全部条目做安全校验，
 * 任一条目越界就整体回退 npm tar 逐条过滤，保持与旧实现相同的安全语义），系统 tar
 * 不可用或执行失败也回退 npm tar。
 */
export function createTarExtractor(
	log?: (scope: string, message: string, detail?: unknown) => void,
	reject?: (path: string) => boolean,
): DshRuntimeExtractor {
	return async (archivePath, destDir) => {
		mkdirSync(destDir, { recursive: true });
		const systemTar = resolveSystemTar();
		if (systemTar) {
			try {
				await extractWithSystemTar(systemTar, archivePath, destDir, log, reject);
				return;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log?.("dsh-runtime", "system tar extraction failed, falling back to npm tar", {
					tar: systemTar,
					error: message,
				});
			}
		}
		await tar.x({
			file: archivePath,
			cwd: destDir,
			filter: (path: string) => {
				if (reject?.(path)) return false;
				if (!isSafeArchiveEntry(destDir, path)) {
					log?.("dsh-runtime", "rejected unsafe archive entry", { path });
					return false;
				}
				return true;
			},
		});
	};
}

/** 系统 tar 两遍式解压：先全量列条目做安全校验（任一越界即抛错回退），再解压。
 *  `-tf` / `-xf archive -C dir` 在 bsdtar（Windows、macOS）与 GNU tar（Linux）上语义一致。
 */
async function extractWithSystemTar(
	tarBin: string,
	archivePath: string,
	destDir: string,
	log: ((scope: string, message: string, detail?: unknown) => void) | undefined,
	reject: ((path: string) => boolean) | undefined,
): Promise<void> {
	// -tf 只是流式读归档头部目录（4.4 万条目实测 ~1s），不解落磁盘。
	const { stdout } = await execFileAsync(tarBin, ["-tf", archivePath], {
		windowsHide: true,
		maxBuffer: 1 << 26,
	});
	for (const entry of stdout.split(/\r?\n/)) {
		if (!entry) continue;
		if (reject?.(entry) || !isSafeArchiveEntry(destDir, entry)) {
			log?.("dsh-runtime", "rejected unsafe archive entry", { path: entry });
			throw new Error(`unsafe archive entry: ${entry}`);
		}
	}
	await execFileAsync(tarBin, ["-xf", archivePath, "-C", destDir], {
		windowsHide: true,
	});
}

/**
 * 用 Electron net 下载到文件（跟随重定向、支持取消与进度）。
 * 与 app update 不同源的地方：runtime 归档较大（数十 MB），这里按 chunk 落盘
 * 而不是整份进内存，避免峰值内存翻倍。
 */
export function createNetDownloader(
	log?: (scope: string, message: string, detail?: unknown) => void,
): DshRuntimeDownloader {
	return async (url, destPath, onProgress, signal) => {
		// file:// / 本地路径：直接复制，不走 net（Electron net 不发 file 请求）。
		const localPath = localPathFromUrl(url);
		if (localPath) {
			if (!existsSync(localPath)) throw new Error("local archive not found");
			mkdirSync(dirname(destPath), { recursive: true });
			copyFileSync(localPath, destPath);
			onProgress?.(statSync(destPath).size, statSync(destPath).size);
			return;
		}
		mkdirSync(dirname(destPath), { recursive: true });
		let currentUrl = url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
			if (signal?.aborted) throw new Error("download aborted");
			const response = await requestOnce(currentUrl, destPath, onProgress, signal, log);
			if (response.kind === "done") return;
			currentUrl = response.location;
		}
		throw new Error("too many redirects");
	};
}

/**
 * 把 `file://` URL 或裸绝对路径转成本地文件路径；http(s) 返回 undefined。
 *
 * 用途：内网/离线分发与本地验证。Electron 的 `net` 不发 file:// 请求，所以索引
 * 与 tarball 都允许指到本地文件——这样在 runtime 还没上传到 Release 之前，
 * 整条安装链路（选版本 → 校验 → 解压 → 落位）也能端到端跑通。
 */
function localPathFromUrl(url: string): string | undefined {
	if (url.startsWith("file://")) {
		try {
			return fileURLToPath(url);
		} catch {
			return undefined;
		}
	}
	// 裸绝对路径：Windows 盘符路径或 POSIX 根路径。
	if (/^[a-zA-Z]:[\\/]/.test(url) || url.startsWith("/")) return url;
	return undefined;
}

/**
 * 拉取下载源索引（GET JSON；file:// 走本地文件读取）。
 * 失败一律返回 null 而不是抛错：索引拉不到是「暂时装不上」，不该让 IPC 抛到渲染层
 * 变成未捕获异常，调用方统一按 "runtime index unavailable" 提示。
 */
export function fetchDshRuntimeIndex(
	url: string,
	log?: (scope: string, message: string, detail?: unknown) => void,
): Promise<DshRuntimeReleaseIndex | null> {
	const localPath = localPathFromUrl(url);
	if (localPath) {
		return Promise.resolve(
			(() => {
				try {
					const parsed = JSON.parse(readFileSync(localPath, "utf8")) as DshRuntimeReleaseIndex;
					return Array.isArray(parsed?.releases) ? parsed : null;
				} catch (error) {
					log?.("dsh-runtime", "local runtime index unreadable", { error: String(error) });
					return null;
				}
			})(),
		);
	}
	return new Promise((resolvePromise) => {
		const request = net.request(url);
		request.on("response", (response) => {
			if (response.statusCode < 200 || response.statusCode >= 300) {
				discardResponse(response);
				log?.("dsh-runtime", "runtime index request failed", { status: response.statusCode });
				resolvePromise(null);
				return;
			}
			let body = "";
			response.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			response.on("end", () => {
				try {
					const parsed = JSON.parse(body) as DshRuntimeReleaseIndex;
					resolvePromise(Array.isArray(parsed?.releases) ? parsed : null);
				} catch {
					log?.("dsh-runtime", "runtime index is not valid json");
					resolvePromise(null);
				}
			});
			response.on("error", (error) => {
				log?.("dsh-runtime", "runtime index response error", { error: String(error) });
				resolvePromise(null);
			});
		});
		request.on("error", (error) => {
			log?.("dsh-runtime", "runtime index request error", { error: String(error) });
			resolvePromise(null);
		});
		request.end();
	});
}

type RequestOutcome = { kind: "done" } | { kind: "redirect"; location: string };

/**
 * 排空不打算消费的响应体（重定向 / 错误响应）。
 * 不读完会让底层连接一直挂着，重定向链一长就堆积 socket。
 */
function discardResponse(response: Electron.IncomingMessage): void {
	response.on("data", () => {
		/* 丢弃 */
	});
}

function requestOnce(
	url: string,
	destPath: string,
	onProgress: ((received: number, total?: number) => void) | undefined,
	signal: AbortSignal | undefined,
	log: ((scope: string, message: string, detail?: unknown) => void) | undefined,
): Promise<RequestOutcome> {
	return new Promise<RequestOutcome>((resolvePromise, rejectPromise) => {
		const request = net.request(url);
		const settle = (outcome: RequestOutcome) => {
			request.removeAllListeners();
			resolvePromise(outcome);
		};

		request.on("response", (response) => {
			const status = response.statusCode;
			// 3xx：取出 Location 交给外层重发（net 不自动跟随）。
			if (status >= 300 && status < 400) {
				const location = response.headers.location;
				const target = Array.isArray(location) ? location[0] : location;
				discardResponse(response);
				if (!target) {
					rejectPromise(new Error(`redirect without location (${status})`));
					return;
				}
				settle({ kind: "redirect", location: new URL(target, url).toString() });
				return;
			}
			if (status < 200 || status >= 300) {
				discardResponse(response);
				rejectPromise(new Error(`download failed with status ${status}`));
				return;
			}
			const totalHeader = response.headers["content-length"];
			const total = Array.isArray(totalHeader)
				? Number.parseInt(totalHeader[0] ?? "", 10)
				: Number.parseInt(String(totalHeader ?? ""), 10);
			const totalBytes = Number.isFinite(total) ? total : undefined;

			let received = 0;
			response.on("data", (chunk: Buffer) => {
				received += chunk.length;
				onProgress?.(received, totalBytes);
			});
			response.on("aborted", () => rejectPromise(new Error("download aborted by remote")));
			response.on("error", (error) => rejectPromise(error));

			const writeStream = createWriteStream(destPath);
			// 用 pipeline 串起「HTTP 响应 → 落盘」，任一端出错都会正确销毁两端，
			// 不会留下半截临时文件占据 userData。
			pipeline(response as unknown as NodeJS.ReadableStream, writeStream)
				.then(() => settle({ kind: "done" }))
				.catch((error: unknown) => rejectPromise(error instanceof Error ? error : new Error(String(error))));
		});

		request.on("error", (error) => rejectPromise(error));
		signal?.addEventListener("abort", () => {
			request.abort();
			rejectPromise(new Error("download aborted"));
		});
		request.end();
	});
}
