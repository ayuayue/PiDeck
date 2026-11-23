import { execFile } from "node:child_process";
import type { SessionFileVersion } from "../sessionSummaryCache";

/**
 * WSL 会话文件的批量指纹（mtime/size）读取。
 *
 * 为什么需要批量：WSL 模式下每个会话文件的 mtime/size 都要 stat，而单文件读取走的是
 * **一次 wsl.exe 子进程**。Windows→WSL 每次拉起的固定开销本机实测 90–105ms
 * （300 个文件 / 并发 4 = 20s），上千会话必然撞上 `SessionScanner.scanTimeoutMs`（18s）——
 * 侧栏会话列表永远超时，前端看门狗随即再触发一轮，每轮都重新拉起几百个 wsl.exe，
 * 用户看到的就是「用 WSL 的 pi 时页面未响应」。
 *
 * 改成一次 wsl.exe + 发行版内 sh 循环读 stdin 的路径表：同规模实测 ~300ms（约 66×）。
 * - 路径走 **stdin** 而不是 argv/脚本：空格、引号、`$( )` 都不成为命令语法，也不受
 *   Windows 32KB 命令行上限约束（千级会话的路径表远大于该上限）；
 * - `-exec /bin/sh` 而不是默认 shell 回退：argv 里只有固定的脚本，没有任何数据；
 * - 输出用 `%n\0` 分隔：路径里出现空格/换行都不会切错记录。
 */

/** 发行版内脚本：逐行读 stdin，为每个路径输出 `mtime 秒数 <空格> 字节数 <空格> 路径\0`。 */
export const WSL_STAT_BATCH_SCRIPT = 'while IFS= read -r pideck_path; do stat --printf "%Y %s %n\\0" -- "$pideck_path" 2>/dev/null; done';

/** 单批路径条数：一批一条 wsl.exe，按批并发；批过大只会让失败面变大，不会更快。 */
export const WSL_STAT_BATCH_SIZE = 500;

/** 单批并发：wsl.exe 启动本身就是重活，超过这个数只会互相拖慢（与扫描同量级）。 */
export const WSL_STAT_BATCH_CONCURRENCY = 4;

/** 单批截止：批量读的是几百个小文件的元数据，超过这个数说明发行版已挂起，放弃本批。 */
export const WSL_STAT_BATCH_TIMEOUT_MS = 20_000;

/** 单批输出字节帽：500 条记录 × 约 120 字节，留足余量但不允许无界。 */
export const WSL_STAT_BATCH_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 生产 argv：`wsl.exe -d <distro> -u <user> --exec /bin/sh -c <脚本>`；路径全部走 stdin。 */
export function buildWslStatBatchArgs(distro: string, user: string): string[] {
	return ["-d", distro, "-u", user, "--exec", "/bin/sh", "-c", WSL_STAT_BATCH_SCRIPT];
}

/** 按批切分路径表；空表返回空数组（调用方不必特判）。 */
export function chunkWslStatPaths(paths: readonly string[], size = WSL_STAT_BATCH_SIZE): string[][] {
	if (paths.length === 0) return [];
	const chunk = Math.max(1, size);
	const batches: string[][] = [];
	for (let index = 0; index < paths.length; index += chunk) batches.push(paths.slice(index, index + chunk));
	return batches;
}

/**
 * stdin 协议的输入文本：一行一个路径，**补尾换行**。
 * 少了尾换行，`read` 会对最后一行返回非零、循环体被跳过——最后一条路径静默丢失。
 */
export function buildWslStatBatchInput(paths: readonly string[]): string {
	return paths.length === 0 ? "" : `${paths.join("\n")}\n`;
}

/**
 * 解析批量输出。
 *
 * 记录内路径自带空格，所以只能按「前两个空格切字段」，路径取剩余全部。
 * **只认 NUL 终止的完整记录**：`split` 的末段恒是「最后一个分隔符之后的内容」——正常结束时是
 * 空串，被字节帽/超时截断时就是半条记录（`1712345678 42 /roo` 字段齐全但路径已被切短）。
 * 后者必须丢：缺的路径由调用方退回单文件 stat 补齐，绝不把被切短的路径当成某个文件的指纹。
 */
export function parseWslStatBatchOutput(stdout: string): Map<string, SessionFileVersion> {
	const versions = new Map<string, SessionFileVersion>();
	const records = stdout.split("\0");
	records.pop();
	for (const record of records) {
		if (record.length === 0) continue;
		const firstSpace = record.indexOf(" ");
		if (firstSpace <= 0) continue;
		const secondSpace = record.indexOf(" ", firstSpace + 1);
		if (secondSpace <= 0) continue;
		const mtimeSeconds = Number(record.slice(0, firstSpace));
		const size = Number(record.slice(firstSpace + 1, secondSpace));
		const filePath = record.slice(secondSpace + 1);
		if (filePath.length === 0 || !Number.isFinite(mtimeSeconds) || !Number.isFinite(size)) continue;
		// 与单文件 `stat -c "%Y %s"` 完全同口径（秒 → 毫秒，1s 精度）：两种读法必须给出同一个
		// 版本号，否则摘要缓存会在批量/单条路径之间反复互相判失效。
		versions.set(filePath, { mtimeMs: mtimeSeconds * 1000, size });
	}
	return versions;
}

/** 批量与单文件读取共用的宿主能力：全部由 SessionScanner 注入（发行版配置 / wsl.exe 解析 / 并发工具）。 */
export interface WslFileStatHost {
	/** 当前 WSL 发行版配置；本地模式返回 null（非 WSL 链路上不该被调用）。 */
	config(): { distro: string; user: string } | null;
	/** wsl.exe 解析结果，与扫描链路共用同一份（找不到 System32 时回退 shell 模式）。 */
	resolveWslExe(): { command: string; shell: boolean };
	/** 与 SessionScanner.mapLimited 同一实现：模块内不自带并发策略。 */
	mapLimited<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]>;
}

/**
 * 单轮 WSL 扫描的文件指纹：批量预热 + 命中即回内存 + 失败退回单文件 stat。
 *
 * 快照**只在一轮扫描内有效**：`list()` 开头 prime、`finally` 里 clear。
 * 跨轮复用会让侧栏读到上一轮的旧 mtime/size，摘要缓存随之判错命中
 *（用户看到的是「会话内容没变但列表还是旧的」）。
 */
export class WslFileVersionBatch {
	private readonly host: WslFileStatHost;
	private snapshot: Map<string, SessionFileVersion> | null = null;

	constructor(host: WslFileStatHost) {
		this.host = host;
	}

	/**
	 * 一次 wsl.exe 取回全表指纹（为什么必须批量见本文件头部说明）。
	 *
	 * 批量只是加速手段：任何失败（发行版挂起、超时、个别文件消失导致的非零退出）都退回
	 * 逐文件 stat，绝不因此让列表不出结果。
	 */
	async prime(files: readonly string[], signal?: AbortSignal): Promise<void> {
		const wsl = this.host.config();
		if (!wsl || files.length === 0) return;
		const snapshot = new Map<string, SessionFileVersion>();
		// 先挂上再填：只要有批回来，已覆盖的文件就不必再逐条 spawn。
		this.snapshot = snapshot;
		const { command, shell } = this.host.resolveWslExe();
		const args = buildWslStatBatchArgs(wsl.distro, wsl.user);
		// 换行符会破坏「一行一个路径」的 stdin 协议：这类路径退回逐文件 stat（真实会话文件不会有）。
		const usable = files.filter((file) => !/[\r\n]/u.test(file));
		await this.host.mapLimited(
			chunkWslStatPaths(usable),
			WSL_STAT_BATCH_CONCURRENCY,
			(batch) =>
				new Promise<void>((done) => {
					const child = execFile(command, args, { encoding: "utf8", shell, signal, windowsHide: true, timeout: WSL_STAT_BATCH_TIMEOUT_MS, maxBuffer: WSL_STAT_BATCH_MAX_OUTPUT_BYTES }, (error, stdout) => {
						// 非零退出是协议的一部分（个别文件在 find 与 stat 之间被删）：已写出的记录照样要。
						// 只有拉不起来（ENOENT 等）与超时/中止（错误码是字符串）才整批放弃，由调用方逐文件补齐。
						const code: unknown = (error as NodeJS.ErrnoException | null)?.code;
						if (!error || typeof code === "number") {
							for (const [filePath, version] of parseWslStatBatchOutput(stdout ?? "")) snapshot.set(filePath, version);
						}
						done();
					});
					child.stdin?.end(buildWslStatBatchInput(batch));
				}),
		);
	}

	/** 本轮快照命中即回内存结果——这是 WSL 扫描避免「每文件一个子进程」的唯一出口；回副本防调用方改写。 */
	get(wslPath: string): SessionFileVersion | undefined {
		const primed = this.snapshot?.get(wslPath);
		return primed ? { ...primed } : undefined;
	}

	/** 一轮扫描结束（含异常路径）必须清空：见本类头部的跨轮失效说明。 */
	clear(): void {
		this.snapshot = null;
	}

	/** 单文件兜底读法：批量没覆盖到的路径（见 prime 的失败分支）。 */
	readVersion(wslPath: string, signal?: AbortSignal): Promise<SessionFileVersion> {
		const primed = this.get(wslPath);
		if (primed) return Promise.resolve(primed);
		const wsl = this.host.config();
		const { command, shell } = this.host.resolveWslExe();
		return new Promise((resolve, reject) => {
			execFile(command, ["-d", wsl!.distro, "-u", wsl!.user, "stat", "-c", "%Y %s", wslPath], { shell, encoding: "utf8", timeout: 5_000, signal, windowsHide: true }, (err, stdout) => {
				if (err) {
					reject(err);
					return;
				}
				const [mtimeSeconds, size] = stdout.trim().split(/\s+/).map(Number);
				resolve({ mtimeMs: mtimeSeconds * 1000, size });
			});
		});
	}
}
