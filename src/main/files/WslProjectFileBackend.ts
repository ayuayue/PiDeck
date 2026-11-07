/**
 * WSL 项目的文件后端（`docs/wsl-project-in-distro-io-plan.md` Wave 1a）。
 *
 * 为什么不在 main 里直接读 UNC：9P 一律按发行版**默认用户**鉴权，root 档案的 `/root` 从 Windows 侧
 * 就是 EACCES（与文件属主无关，`wsl.exe -u` 也改不了 Explorer/Node fs 看到的身份）。所以读面必须在
 * 发行版内以档案用户身份执行，也就是经 `WslHelperSession` 的 NDJSON helper 往返。
 *
 * 为什么复用 `RemoteWorkspaceReader` 而不是另写解析：helper 的应答是「远端数据」——形状必须逐字段
 * 证明后才交给调用方；SSH 侧已经把这套校验写完了，这里只把 transport 换成 WSL 会话。`list` 的递归、
 * 元数据、排序与忽略规则是本模块自己的（helper 只答单层），但每一项都走 reader 的校验结果。
 *
 * 回退（决定 6）：helper 建不起来（无 node / 版本过低 / 发行版没起来 / 会话握手失败）时，本次调用
 * 退回原来的 UNC 本机读；本机也读不通才抛**helper 那条**可解释错误。新链路失败不许把老链路能用的人
 * 一起拖倒——但「helper 答了 PATH_NOT_FOUND」不是不可用，那是对这次读的权威结论，不回退。
 *
 * 写面（Wave 1b 才进 helper）：本轮继续委托 UNC 本机实现，行为与今天逐字一致（root 档案写不进去也
 * 和今天一样，不是本 wave 引入的回归）。
 */

import { isUtf8 } from "node:buffer";
import { codeOf } from "../../shared/op";
import type { FileSearchResult, FileTreeNode, ProjectFileTarget } from "../../shared/types";
import type { ProjectDirectoryEntry, ProjectFileStatResult } from "../../shared/types/projectFiles";
import { createRemoteSearchReader } from "../remote/RemoteSearchReader";
import { createRemoteWorkspaceReader, type RemoteWorkspaceReader } from "../remote/RemoteWorkspaceReader";
import { looksNonText, MAX_TRUSTED_STAT_BYTES } from "./textFileRead";
import { parseProjectFileTarget } from "./projectFileTarget";
import type { ProjectFileBackend } from "./ProjectFileBackend";
import type { WslHelperSessionPool, WslHelperSessionTarget } from "../wsl/WslHelperSession";

/** helper 侧的 hostId 只用于 reader 的内部身份校验，WSL 会话不使用它做路由。 */
const WSL_READER_HOST_ID = "wsl";

/** 与 `FileSystemService` 同一份忽略规则：VCS 元数据与依赖目录在任何浏览场景都不展示。 */
const ALWAYS_IGNORED_NAMES = new Set([".git", "node_modules"]);
/** 只在 composer @ 引用的整树扫描里额外跳过；文件抽屉浏览不藏用户自己生成的文件。 */
const SCAN_ONLY_IGNORED_NAMES = new Set(["dist", "build", "target", ".next", "coverage", ".venv", "__pycache__"]);

/** 目录页单层上限：与本地/远端同一常量语义（超出显式 truncated，不伪装成完整）。 */
const DIRECTORY_PAGE_LIMIT = 2000;

/** 批量 stat 的分帧上限：与 helper 契约一致（64 路径/帧）。 */
const STAT_MANY_BATCH = 64;

/** 被读面接受的本机回退：除 `ProjectFileBackend` 的读 API 外还要目录页（与 WSL 本地后端同形）。 */
export type WslProjectFileFallback = ProjectFileBackend & {
	directoryPage(target: ProjectFileTarget, limit?: number): Promise<{ entries: ProjectDirectoryEntry[]; truncated: boolean }>;
};

export type WslProjectFileBackendDeps = {
	pool: WslHelperSessionPool;
	/**
	 * projectId → 发行版内会话身份。返回 undefined 表示这个项目不路由到 helper
	 * （非 WSL、档案不完整、路径不可转换）：本次调用直接用本机回退。
	 */
	resolveSessionTarget: (projectId: string) => WslHelperSessionTarget | undefined;
	/** 今天的行为（UNC 本机读）。读面在 helper 不可用时用它兜底；写面本轮全部走它。 */
	fallback: WslProjectFileFallback;
	/** composer @ 引用的整树扫描：额外跳过构建产物目录。 */
	skipGeneratedDirs?: boolean;
};

/**
 * 只有「helper 链路没建起来」才回退。`WSL_HELPER_*` 是部署/会话自己的闭集，
 * 加上两个传输层的瞬时码；其余（PATH_NOT_FOUND / NOT_A_FILE / RESULT_TOO_LARGE …）
 * 都是 helper 对这次调用的权威结论，回退会把「文件真的不存在」伪装成「读不到」。
 */
const TRANSIENT_TRANSPORT_CODES = new Set(["REMOTE_CONNECTION_LOST", "REQUEST_TIMEOUT"]);

function isHelperChainUnavailable(code: string): boolean {
	return code.startsWith("WSL_HELPER_") || TRANSIENT_TRANSPORT_CODES.has(code);
}

function childRelative(root: string, name: string): string {
	return root === "" ? name : `${root}/${name}`;
}

function sorted(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.sort((a, b) => {
		if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
		return a.name.localeCompare(b.name);
	});
}

/** 只有目录条目才谈得上「可展开」；文件省略该字段（与本地 listTree 一致）。 */
type EntryMeta = { bytes: number; mtimeMs: number };

export class WslProjectFileBackend implements ProjectFileBackend {
	readonly locationKind = "local" as const;
	private readonly ignored: ReadonlySet<string>;

	constructor(private readonly deps: WslProjectFileBackendDeps) {
		this.ignored = deps.skipGeneratedDirs === true ? new Set([...ALWAYS_IGNORED_NAMES, ...SCAN_ONLY_IGNORED_NAMES]) : ALWAYS_IGNORED_NAMES;
	}

	/** 读面统一入口：helper 可用时走 helper，链路建不起来才退回本机。 */
	private async readThrough<T>(rawTarget: ProjectFileTarget, viaHelper: (reader: RemoteWorkspaceReader) => Promise<T>, viaLocal: () => Promise<T>): Promise<T> {
		const target = parseProjectFileTarget(rawTarget);
		const sessionTarget = this.deps.resolveSessionTarget(target.projectId);
		if (sessionTarget === undefined) return await viaLocal();
		const reader = createRemoteWorkspaceReader({
			port: {
				request: (_hostId, method, params, options) => this.deps.pool.request(sessionTarget, method, params, options),
				cancel: (_hostId, requestId, options) => this.deps.pool.cancel(sessionTarget, requestId, options),
			},
		});
		try {
			return await viaHelper(reader);
		} catch (error) {
			if (!isHelperChainUnavailable(codeOf(error, "PROJECT_FILE_READ_FAILED"))) throw error;
			// 本机回退成功 = 老链路对这类项目本来就能读，不该被新链路拖倒；
			// 本机也失败 = 抛 helper 的错误（它才是对「为什么读不到」有解释力的那个）。
			try {
				return await viaLocal();
			} catch {
				throw error;
			}
		}
	}

	async list(rawTarget: ProjectFileTarget, maxDepth = 0): Promise<FileTreeNode[]> {
		const target = parseProjectFileTarget(rawTarget);
		return await this.readThrough(
			target,
			async (reader) => await this.readTree(reader, target, maxDepth),
			async () => await this.deps.fallback.list(target, maxDepth),
		);
	}

	private async readTree(reader: RemoteWorkspaceReader, target: ProjectFileTarget, maxDepth: number): Promise<FileTreeNode[]> {
		const projectId = target.projectId;
		const readLevel = async (parentRelative: string, depth: number): Promise<FileTreeNode[]> => {
			const listed = await reader.list(WSL_READER_HOST_ID, parentRelative === "" ? "." : parentRelative);
			const entries = listed.entries.filter((entry) => (entry.kind === "file" || entry.kind === "directory") && !this.ignored.has(entry.name));
			const metadata = await this.readMetadata(
				reader,
				parentRelative,
				entries.map((entry) => entry.name),
			);
			const nodes: FileTreeNode[] = [];
			for (const entry of entries) {
				const relativePath = childRelative(parentRelative, entry.name);
				const type = entry.kind === "directory" ? "directory" : "file";
				const nodeTarget: ProjectFileTarget = { projectId, relativePath };
				const meta = metadata.get(entry.name);
				if (type === "directory") {
					// 达到深度上限时不知道子项，省略 children/hasChildren：渲染层按「未加载」处理，
					// 不能把「没查过」写成「没有子项」。
					const children = depth < maxDepth ? await readLevel(relativePath, depth + 1) : undefined;
					nodes.push({
						name: entry.name,
						relativePath,
						target: nodeTarget,
						type,
						...(meta === undefined ? {} : { mtimeMs: meta.mtimeMs, size: 0 }),
						...(children === undefined ? {} : { children, hasChildren: children.length > 0 }),
					});
					continue;
				}
				nodes.push({
					name: entry.name,
					relativePath,
					target: nodeTarget,
					type,
					...(meta === undefined ? {} : { mtimeMs: meta.mtimeMs, size: meta.bytes }),
				});
			}
			return sorted(nodes);
		};
		return await readLevel(target.relativePath, 0);
	}

	/**
	 * 名字 → 本层元数据。失败一律忽略：大小/时间只影响排序，不该让一次能列出来的目录变成错误。
	 * `fs.statMany` 是全有或全无，任一名字在两次往返间消失就会整批失败，所以按帧吞掉。
	 */
	private async readMetadata(reader: RemoteWorkspaceReader, parentRelative: string, names: readonly string[]): Promise<Map<string, EntryMeta>> {
		const metadata = new Map<string, EntryMeta>();
		for (let offset = 0; offset < names.length; offset += STAT_MANY_BATCH) {
			const batch = names.slice(offset, offset + STAT_MANY_BATCH);
			try {
				const answer = await reader.statMany(
					WSL_READER_HOST_ID,
					batch.map((name) => (parentRelative === "" ? name : `${parentRelative}/${name}`)),
				);
				for (const entry of answer.entries) {
					const name = entry.path.slice(entry.path.lastIndexOf("/") + 1);
					if (entry.kind !== "file") continue;
					metadata.set(name, { bytes: entry.bytes, mtimeMs: entry.mtimeMs });
				}
			} catch {
				// 元数据是可选的。
			}
		}
		return metadata;
	}

	async directoryPage(rawTarget: ProjectFileTarget, limit = DIRECTORY_PAGE_LIMIT): Promise<{ entries: ProjectDirectoryEntry[]; truncated: boolean }> {
		const target = parseProjectFileTarget(rawTarget);
		return await this.readThrough(
			target,
			async (reader) => {
				const listed = await reader.list(WSL_READER_HOST_ID, target.relativePath === "" ? "." : target.relativePath);
				const entries: ProjectDirectoryEntry[] = listed.entries
					.filter((entry) => (entry.kind === "file" || entry.kind === "directory") && !this.ignored.has(entry.name))
					.map((entry) => {
						const relativePath = childRelative(target.relativePath, entry.name);
						const type = entry.kind === "directory" ? "directory" : "file";
						return {
							target: { projectId: target.projectId, relativePath },
							relativePath,
							type,
							// helper 的 fs.list 不逐项探测：目录只能是 unknown，不能伪装成「没有子项」。
							hasChildren: type === "directory" ? ("unknown" as const) : false,
						};
					});
				return { entries: entries.slice(0, limit), truncated: entries.length > limit };
			},
			async () => await this.deps.fallback.directoryPage(target, limit),
		);
	}

	async search(rawTarget: ProjectFileTarget, query: string): Promise<FileSearchResult[]> {
		const target = parseProjectFileTarget(rawTarget);
		return await this.readThrough(
			target,
			async () => {
				const sessionTarget = this.deps.resolveSessionTarget(target.projectId);
				// resolveSessionTarget 在上面已确认非 undefined；这里再取一次只为把类型收窄。
				if (sessionTarget === undefined) return [];
				const reader = createRemoteSearchReader({
					port: {
						request: (_hostId, method, params, options) => this.deps.pool.request(sessionTarget, method, params, options),
						cancel: (_hostId, requestId, options) => this.deps.pool.cancel(sessionTarget, requestId, options),
					},
				});
				const result = await reader.search(WSL_READER_HOST_ID, target.relativePath === "" ? "." : target.relativePath, query);
				const matches: FileSearchResult[] = result.entries
					.filter((entry) => entry.kind === "file" || entry.kind === "directory")
					.map((entry) => ({
						name: entry.name,
						relativePath: entry.path,
						target: { projectId: target.projectId, relativePath: entry.path },
						type: entry.kind === "directory" ? ("directory" as const) : ("file" as const),
					}));
				return matches;
			},
			async () => await this.deps.fallback.search(target, query),
		);
	}

	async readContent(rawTarget: ProjectFileTarget, maxBytes?: number): Promise<string> {
		const target = parseProjectFileTarget(rawTarget);
		return await this.readThrough(
			target,
			async (reader) => {
				const described = await reader.stat(WSL_READER_HOST_ID, target.relativePath === "" ? "." : target.relativePath);
				if (described.kind !== "file") throw new Error("NOT_A_FILE");
				this.assertTrustedSize(described.bytes, maxBytes);
				const file = await reader.readFile(WSL_READER_HOST_ID, target.relativePath === "" ? "." : target.relativePath);
				// 与 `readTextFileGuarded` 同一套判定：有损解码与高控制字符内容都不交给编辑器。
				if (!isUtf8(file.content)) throw new Error(`FILE_NOT_TEXT:${file.bytes}`);
				const content = Buffer.from(file.content).toString("utf8");
				if (looksNonText(content)) throw new Error(`FILE_NOT_TEXT:${file.bytes}`);
				return content;
			},
			async () => await this.deps.fallback.readContent(target, maxBytes),
		);
	}

	async readBase64(rawTarget: ProjectFileTarget, maxBytes?: number): Promise<string> {
		const target = parseProjectFileTarget(rawTarget);
		return await this.readThrough(
			target,
			async (reader) => {
				const path = target.relativePath === "" ? "." : target.relativePath;
				const described = await reader.stat(WSL_READER_HOST_ID, path);
				if (described.kind !== "file") throw new Error("NOT_A_FILE");
				this.assertTrustedSize(described.bytes, maxBytes);
				const file = await reader.readFile(WSL_READER_HOST_ID, path);
				return Buffer.from(file.content).toString("base64");
			},
			async () => await this.deps.fallback.readBase64(target, maxBytes),
		);
	}

	async pathsExist(rawTargets: ProjectFileTarget[]): Promise<boolean[]> {
		const targets = rawTargets.map((target) => parseProjectFileTarget(target));
		if (targets.length === 0) return [];
		// 一次调用里所有路径属于同一个项目（IPC 层已按 backend 同源校验）。
		const sessionTarget = this.deps.resolveSessionTarget(targets[0].projectId);
		if (sessionTarget === undefined) return await this.deps.fallback.pathsExist(targets);
		const reader = createRemoteWorkspaceReader({
			port: {
				request: (_hostId, method, params, options) => this.deps.pool.request(sessionTarget, method, params, options),
				cancel: (_hostId, requestId, options) => this.deps.pool.cancel(sessionTarget, requestId, options),
			},
		});
		try {
			const states: boolean[] = [];
			for (let offset = 0; offset < targets.length; offset += STAT_MANY_BATCH) {
				const batch = targets.slice(offset, offset + STAT_MANY_BATCH);
				const paths = batch.map((target) => (target.relativePath === "" ? "." : target.relativePath));
				try {
					const answer = await reader.statMany(WSL_READER_HOST_ID, paths);
					for (const entry of answer.entries) states.push(entry.kind === "file" || entry.kind === "directory");
				} catch (error) {
					// 链路层次的失败交给外层回退；statMany 是全有或全无，其余（含 PATH_NOT_FOUND）逐项 stat。
					if (isHelperChainUnavailable(codeOf(error, "PROJECT_FILE_READ_FAILED"))) throw error;
					for (const path of paths) {
						try {
							const described = await reader.stat(WSL_READER_HOST_ID, path);
							states.push(described.kind === "file" || described.kind === "directory");
						} catch (inner) {
							if (isHelperChainUnavailable(codeOf(inner, "PROJECT_FILE_READ_FAILED"))) throw inner;
							states.push(false);
						}
					}
				}
			}
			return states;
		} catch (error) {
			if (!isHelperChainUnavailable(codeOf(error, "PROJECT_FILE_READ_FAILED"))) throw error;
			try {
				return await this.deps.fallback.pathsExist(targets);
			} catch {
				throw error;
			}
		}
	}

	async stat(rawTarget: ProjectFileTarget): Promise<ProjectFileStatResult> {
		const target = parseProjectFileTarget(rawTarget);
		return await this.readThrough(
			target,
			async (reader) => {
				try {
					const described = await reader.stat(WSL_READER_HOST_ID, target.relativePath === "" ? "." : target.relativePath);
					if (described.kind === "file" || described.kind === "directory") {
						return { availability: "present", exists: true, isDirectory: described.kind === "directory" };
					}
					return { availability: "unavailable", exists: false, isDirectory: false, code: "NOT_A_FILE" };
				} catch (error) {
					const code = codeOf(error, "PROJECT_FILE_READ_FAILED");
					if (code === "PATH_NOT_FOUND") return { availability: "missing", exists: false, isDirectory: false, code };
					// Transient helper failures still need to reach readThrough so the UNC fallback can run.
					if (isHelperChainUnavailable(code)) throw error;
					return { availability: "unavailable", exists: false, isDirectory: false, code };
				}
			},
			async () => await this.deps.fallback.stat(target),
		);
	}

	// ---- 写面：Wave 1b 才搬进 helper（发行版内原子替换）；本轮保持今天的 UNC 本机行为。 ----

	async writeContent(target: ProjectFileTarget, content: string, expectedRevision?: string): Promise<void> {
		await this.deps.fallback.writeContent(target, content, expectedRevision);
	}

	async create(parent: ProjectFileTarget, name: string, type: "file" | "directory"): Promise<ProjectFileTarget> {
		return await this.deps.fallback.create(parent, name, type);
	}

	async delete(target: ProjectFileTarget, recursive?: boolean): Promise<void> {
		await this.deps.fallback.delete(target, recursive);
	}

	async rename(target: ProjectFileTarget, newName: string): Promise<ProjectFileTarget> {
		return await this.deps.fallback.rename(target, newName);
	}

	async copy(sources: ProjectFileTarget[], targetDir: ProjectFileTarget): Promise<ProjectFileTarget[]> {
		return await this.deps.fallback.copy(sources, targetDir);
	}

	async move(sources: ProjectFileTarget[], targetDir: ProjectFileTarget): Promise<ProjectFileTarget[]> {
		return await this.deps.fallback.move(sources, targetDir);
	}

	async moveTo(source: ProjectFileTarget, target: ProjectFileTarget): Promise<ProjectFileTarget> {
		// 与 move 同一件事：WSL 路径由 fallback 在 helper 或 UNC 上用同一判据处理。
		if (typeof this.deps.fallback.moveTo !== "function") throw new Error("UNSUPPORTED_CAPABILITY");
		return await this.deps.fallback.moveTo(source, target);
	}

	private assertTrustedSize(size: number, maxBytes?: number): void {
		if (!Number.isSafeInteger(size) || size < 0 || size > MAX_TRUSTED_STAT_BYTES) throw new Error(`FILE_SIZE_UNREADABLE:${size}`);
		if (typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 && size > maxBytes) throw new Error(`FILE_TOO_LARGE:${size}:${Math.floor(maxBytes)}`);
	}
}
