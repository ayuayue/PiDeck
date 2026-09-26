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
import type { DshRunnerNodeReleaseIndex } from "../../../shared/types/dshRunnerNodeRelease";
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
export function createTarExtractor(log?: (scope: string, message: string, detail?: unknown) => void, reject?: (path: string) => boolean): DshRuntimeExtractor {
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
async function extractWithSystemTar(tarBin: string, archivePath: string, destDir: string, log: ((scope: string, message: string, detail?: unknown) => void) | undefined, reject: ((path: string) => boolean) | undefined): Promise<void> {
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
 * 用 Electron net 下载到文件（跟随重定向、支持取消、进度与 Range 续传）。
 * 与 app update 不同源的地方：runtime 归档较大（数十 MB），这里按 chunk 落盘
 * 而不是整份进内存，避免峰值内存翻倍。
 *
 * 续传（`options.resumeFromBytes`）：几百 MB 的模型一旦断线就重下，体验不可接受。
 * 调用方把已落盘的字节数传进来，这里带 `Range` 请求剩余部分并追加写；
 * 服务端不理 Range（回 200 全量）时按全量重写，语义仍然正确——最终校验由调用方负责。
 */
export function createNetDownloader(log?: (scope: string, message: string, detail?: unknown) => void): DshRuntimeDownloader {
	return async (url, destPath, onProgress, signal, options) => {
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
		// 断点不存在（文件被清掉/还没写过）就按 0 处理，别让 Range 头写出 `bytes=0-` 之外的怪值。
		let offset = Math.max(0, options?.resumeFromBytes ?? 0);
		if (offset > 0 && !existsSync(destPath)) offset = 0;
		let currentUrl = url;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
			if (signal?.aborted) throw new Error("download aborted");
			const response = await requestOnce(currentUrl, destPath, onProgress, signal, log, offset);
			if (response.kind === "done") return;
			if (response.kind === "restart") {
				// 服务端说这个起点无效（416：远端比我们手里的文件小，或干脆不支持分段）
				// ——半截文件不可信，从 0 重来。
				offset = 0;
				continue;
			}
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
 * 变成未捕获异常。
 */
function fetchJsonIndex<T>(url: string, scope: string, validate: (parsed: T) => boolean, log?: (scope: string, message: string, detail?: unknown) => void): Promise<T | null> {
	const localPath = localPathFromUrl(url);
	if (localPath) {
		return Promise.resolve(
			(() => {
				try {
					const parsed = JSON.parse(readFileSync(localPath, "utf8")) as T;
					return validate(parsed) ? parsed : null;
				} catch (error) {
					log?.(scope, "local index unreadable", { error: String(error) });
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
				log?.(scope, "index request failed", { status: response.statusCode });
				resolvePromise(null);
				return;
			}
			let body = "";
			response.on("data", (chunk: Buffer) => {
				body += chunk.toString("utf8");
			});
			response.on("end", () => {
				try {
					const parsed = JSON.parse(body) as T;
					resolvePromise(validate(parsed) ? parsed : null);
				} catch {
					log?.(scope, "index is not valid json");
					resolvePromise(null);
				}
			});
			response.on("error", (error) => {
				log?.(scope, "index response error", { error: String(error) });
				resolvePromise(null);
			});
		});
		request.on("error", (error) => {
			log?.(scope, "index request error", { error: String(error) });
			resolvePromise(null);
		});
		request.end();
	});
}

export function fetchDshRuntimeIndex(url: string, log?: (scope: string, message: string, detail?: unknown) => void): Promise<DshRuntimeReleaseIndex | null> {
	return fetchJsonIndex<DshRuntimeReleaseIndex>(url, "dsh-runtime", (parsed) => Array.isArray(parsed?.releases), log);
}

export function fetchDshRunnerNodeIndex(url: string, log?: (scope: string, message: string, detail?: unknown) => void): Promise<DshRunnerNodeReleaseIndex | null> {
	return fetchJsonIndex<DshRunnerNodeReleaseIndex>(url, "dsh-runner-node", (parsed) => Array.isArray(parsed?.releases), log);
}

type RequestOutcome = { kind: "done" } | { kind: "redirect"; location: string } | { kind: "restart" };

/**
 * 排空不打算消费的响应体（重定向 / 错误响应）。
 * 不读完会让底层连接一直挂着，重定向链一长就堆积 socket。
 */
function discardResponse(response: Electron.IncomingMessage): void {
	response.on("data", () => {
		/* 丢弃 */
	});
}

function requestOnce(url: string, destPath: string, onProgress: ((received: number, total?: number) => void) | undefined, signal: AbortSignal | undefined, log: ((scope: string, message: string, detail?: unknown) => void) | undefined, resumeFrom: number): Promise<RequestOutcome> {
	return new Promise<RequestOutcome>((resolvePromise, rejectPromise) => {
		const request = net.request(url);
		const settle = (outcome: RequestOutcome) => {
			request.removeAllListeners();
			resolvePromise(outcome);
		};

		if (resumeFrom > 0) request.setHeader("Range", `bytes=${resumeFrom}-`);

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
			// 416：请求起点超出远端资源长度。手里的半截文件不可信，交回外层从 0 重来。
			if (status === 416) {
				discardResponse(response);
				log?.("dsh-runtime", "range not satisfiable, restarting from zero", { url, resumeFrom });
				settle({ kind: "restart" });
				return;
			}
			if (status < 200 || status >= 300) {
				discardResponse(response);
				rejectPromise(new Error(`download failed with status ${status}`));
				return;
			}
			// 只有 206 才是真续传；服务端忽略 Range 回 200 全量时必须覆盖写，
			// 否则会把整份内容接在已有半截之后。
			const resuming = resumeFrom > 0 && status === 206;
			const totalHeader = response.headers["content-length"];
			const contentLength = Array.isArray(totalHeader) ? Number.parseInt(totalHeader[0] ?? "", 10) : Number.parseInt(String(totalHeader ?? ""), 10);
			const rangeTotal = resuming ? parseContentRangeTotal(response.headers["content-range"]) : undefined;
			const totalBytes = Number.isFinite(contentLength) ? (resuming ? (rangeTotal ?? resumeFrom + contentLength) : contentLength) : undefined;

			// 进度对调用方始终是「累计字节 / 整份体积」，续传段只是接着往上加。
			let received = resuming ? resumeFrom : 0;
			response.on("data", (chunk: Buffer) => {
				received += chunk.length;
				onProgress?.(received, totalBytes);
			});
			response.on("aborted", () => rejectPromise(new Error("download aborted by remote")));
			response.on("error", (error) => rejectPromise(error));

			const writeStream = createWriteStream(destPath, { flags: resuming ? "a" : "w" });
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

/** 从 `Content-Range: bytes 512-1023/1024` 里取资源总长；解析失败返回 undefined。 */
function parseContentRangeTotal(header: string | string[] | undefined): number | undefined {
	const raw = Array.isArray(header) ? header[0] : header;
	const matched = /\/\s*(\d+)\s*$/.exec(raw ?? "");
	if (!matched) return undefined;
	const total = Number.parseInt(matched[1] ?? "", 10);
	return Number.isFinite(total) ? total : undefined;
}
