import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { SUBAGENT_ARTIFACTS_DIR_NAME } from "../../../shared/sessionIdentity";

/** 扫描根枚举需要的宿主持有面：wsl.exe 启动方式、WSL 配置、路径归一与归档目录名。 */
export type SessionRootEnumerationHost = {
	/** wsl.exe 命令与启动模式（宿主统一解析，优先绝对路径）。 */
	resolveWslExe(): { command: string; shell: boolean };
	/** 当前 WSL 配置；null 表示本地模式（不枚举 WSL 路径）。 */
	readonly wslConfig: { distro: string; user: string; home: string } | null;
	/** 路径归一（去尾斜杠 + 小写），用于扫描结果去重。 */
	normalizePath(path: string): string;
	/** 归档目录名：归档会话不参与常规扫描。 */
	readonly archiveDirName: string;
	/** 单个根目录的 *.jsonl 枚举（实例级可替换，测试直接接替这层）。 */
	collectJsonl(dir: string): Promise<string[]>;
	collectWslJsonl(sessionsDir: string, signal?: AbortSignal): Promise<string[]>;
};

/** 通过 wsl.exe 在指定目录递归查找 *.jsonl，返回 Linux 绝对路径 */
export async function collectWslJsonl(host: SessionRootEnumerationHost, sessionsDir: string, signal?: AbortSignal): Promise<string[]> {
	const wsl = host.wslConfig!;
	const { command, shell } = host.resolveWslExe();
	return new Promise((resolve, reject) => {
		execFile(
			command,
			[
				"-d",
				wsl.distro,
				"-u",
				wsl.user,
				// 跳过归档目录（.pideck-archive）与回收目录（.trash）：归档会话不参与常规扫描。
				// subagent-artifacts 是 pi-subagents 产物转储，不是会话文件，与本地 collectJsonl 同口径排除。
				"find",
				sessionsDir,
				"-name",
				"*.jsonl",
				"-type",
				"f",
				"-not",
				"-path",
				`*/${host.archiveDirName}/*`,
				"-not",
				"-path",
				`*/${SUBAGENT_ARTIFACTS_DIR_NAME}/*`,
			],
			{
				encoding: "utf8",
				timeout: 15_000,
				signal,
				windowsHide: true,
				shell,
				// 目录列表通常远小于 1MB，但极端场景（上万文件）下兑底防 maxBuffer 溢出。
				maxBuffer: 16 * 1024 * 1024,
			},
			(err, stdout) => {
				if (err) {
					reject(err);
					return;
				}
				const files = stdout.trim().split(/\r?\n/).filter(Boolean);
				resolve(files);
			},
		);
	});
}

export async function collectJsonl(host: SessionRootEnumerationHost, dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (!entry.isDirectory()) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
			continue;
		}
		// 跳过归档目录：归档会话不参与常规扫描（.trash 同理不扫）。
		// 跳过 subagent-artifacts：pi-subagents 的产物转储目录（transcript 等），
		// 不是会话文件；混进扫描会让每个子代理在侧栏「嵌套 + 顶层平铺」重复显示。
		if (entry.name === host.archiveDirName || entry.name === SUBAGENT_ARTIFACTS_DIR_NAME) continue;
		files.push(...(await collectJsonl(host, path)));
	}

	return files;
}

export async function collectFromRootsLocal(host: SessionRootEnumerationHost, roots: string[]): Promise<string[]> {
	const all: string[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		const files = await host.collectJsonl(root).catch(() => [] as string[]);
		for (const file of files) {
			const key = host.normalizePath(file);
			if (seen.has(key)) continue;
			seen.add(key);
			all.push(file);
		}
	}
	return all;
}

export async function collectFromRootsWsl(host: SessionRootEnumerationHost, roots: string[], signal?: AbortSignal): Promise<string[]> {
	const all: string[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		const files = await host.collectWslJsonl(root, signal).catch(() => [] as string[]);
		for (const file of files) {
			const key = host.normalizePath(file);
			if (seen.has(key)) continue;
			seen.add(key);
			all.push(file);
		}
	}
	return all;
}

/**
 * 滑动窗口并发：每个 worker 在 `await mapper(...)` 处自然交回事件循环，因此不需要批次间隔。
 *
 * 为什么不用「分块 + 块间让出」（2026-10 实测）：旧实现在每块之间 `setTimeout(resolve, 0)`，
 * 而 Windows 定时器最小粒度是 **16.3ms/次**（实测 50 次 = 814ms）。本机 1040 个会话 / 并发 4
 * = 260 块 → 每次侧栏扫描白等约 4.2s（实测 3994ms），而真正的 stat 总量只要 45ms。
 * 换成滑动窗口后同一批文件实测 11ms；也不用 setImmediate（部分测试 VM 里没有它）。
 * 回归守卫：tests/sessionScannerMapLimited.test.mjs。
 */
export async function mapLimited<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	const limit = Math.max(1, concurrency);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await mapper(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
