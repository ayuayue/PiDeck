import { readdir, rename as fsRename, mkdir, writeFile, stat } from "node:fs/promises";
import { join, relative, dirname, resolve, sep, basename } from "node:path";
import { trashPath } from "./trash";
import { parseWslUncPath } from "../wsl/WslPaths";
import type { FileSearchResult, FileTreeNode } from "../../shared/types";
import { DEFAULT_FILE_TREE_MAX_DEPTH, FILE_TREE_ABSOLUTE_MAX_DEPTH, FILE_TREE_MAX_DIRECTORY_ENTRIES, FILE_SEARCH_MAX_RESULTS, FILE_SEARCH_TIMEOUT_MS, FILE_SEARCH_MAX_DIRECTORY_ENTRIES } from "../../shared/fileTree";

// 忽略规则分两档（历史上只有一份，把构建产物一起藏了）：
// - ALWAYS：VCS 元数据与依赖目录，体量巨大且没有浏览价值，任何场景都不展示；
// - SCAN_ONLY：构建/缓存产物。只在 composer @ 引用的整树扫描里跳过（深挖 target/ 的 class 文件
//   既拖慢又污染候选）；文件抽屉是「浏览工作区」的入口，藏起来会让用户找不到自己生成的文件，
//   也没有任何开关能打开，所以浏览/文件名搜索必须展示它们。
const ALWAYS_IGNORED_NAMES = new Set([".git", "node_modules"]);
const SCAN_ONLY_IGNORED_NAMES = new Set(["dist", "build", "target", ".next", "coverage", ".venv", "__pycache__"]);
const SCAN_IGNORED_NAMES = new Set([...ALWAYS_IGNORED_NAMES, ...SCAN_ONLY_IGNORED_NAMES]);

export interface FileTreeListOptions {
	/** composer @ 引用的整树扫描：额外跳过 build/dist/target 等产物目录。抽屉浏览不传。 */
	skipGeneratedDirs?: boolean;
}

/** 路径必须落在项目根内（resolve 后比较，防 ../ 逃逸）。 */
export function isPathInsideProject(root: string, target: string): boolean {
	const rootWsl = parseWslUncPath(root);
	const targetWsl = parseWslUncPath(target);
	if (rootWsl || targetWsl) {
		if (!rootWsl || !targetWsl) return false;
		if (rootWsl.distro.toLowerCase() !== targetWsl.distro.toLowerCase()) return false;
		// UNC host/distro 属于 Windows 命名，Linux 文件段仍区分大小写，不能整体 lower-case。
		return targetWsl.linuxPath === rootWsl.linuxPath || targetWsl.linuxPath.startsWith(`${rootWsl.linuxPath.replace(/\/$/, "")}/`);
	}
	const normalizeForCompare = (value: string) => {
		const resolved = resolve(value);
		return process.platform === "win32" ? resolved.toLowerCase() : resolved;
	};
	const rootResolved = normalizeForCompare(root);
	const targetResolved = normalizeForCompare(target);
	if (targetResolved === rootResolved) return true;
	const rootPrefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
	return targetResolved.startsWith(rootPrefix);
}

export class FileSystemService {
	/**
	 * 列出项目文件树。
	 * maxDepth=0：只读当前目录一层，子目录 children=[] 且 hasChildren 标记是否可再展开。
	 * maxDepth>0：继续向下递归，供 composer @ 引用一次性拿到有限深度清单。
	 */
	async listTree(root: string, maxDepth = DEFAULT_FILE_TREE_MAX_DEPTH, directory?: string, options?: FileTreeListOptions): Promise<FileTreeNode[]> {
		const current = directory ? resolve(directory) : resolve(root);
		if (!isPathInsideProject(root, current)) {
			throw new Error(`Invalid path: "${directory}" escapes project directory`);
		}
		const depthLimit = Math.max(0, Math.min(maxDepth, FILE_TREE_ABSOLUTE_MAX_DEPTH));
		const ignored = options?.skipGeneratedDirs ? SCAN_IGNORED_NAMES : ALWAYS_IGNORED_NAMES;
		return this.readDirectory(root, current, 0, depthLimit, ignored);
	}

	private async readDirectory(root: string, current: string, depth: number, maxDepth: number, ignored: Set<string>): Promise<FileTreeNode[]> {
		const entries = await readdir(current, { withFileTypes: true });
		// 单层过大时拒绝构造整层节点：否则 IPC + React 树会把渲染进程打崩。
		if (entries.length > FILE_TREE_MAX_DIRECTORY_ENTRIES) {
			throw new Error(`FILE_TREE_DIRECTORY_TOO_LARGE:${entries.length}:${FILE_TREE_MAX_DIRECTORY_ENTRIES}`);
		}
		// 并行 stat：为排序（名称/更新时间/创建时间/大小）附加元数据。
		// 目录 stat.size 无意义，恒置 0；目录仍保留时间戳用于“按更新时间/创建时间”排序。
		const stats = await Promise.all(
			entries.map(async (entry) => {
				try {
					return await stat(join(current, entry.name));
				} catch {
					// 竞态删除/无权限：回退空 stat，节点仍以名称排序兜底
					return null;
				}
			}),
		);
		// 预取「未递归目录」的可展开探测（2027-02 性能审计，并行化）：原先在下面循环里
		// 逐目录 await directoryHasVisibleChildren（各一次 readdir），几百个子目录的层级
		// 在 HDD/杀毒实时扫描/网络盘上 = 数百次串行往返（单次展开数百 ms~秒级）。
		// 探测之间无依赖，与 stats 同批并发；循环里的读取只是拿已就绪的结果。
		const expandableByPath = new Map<string, boolean>();
		if (depth >= maxDepth) {
			const probes = await Promise.all(entries.filter((entry) => !ignored.has(entry.name) && entry.isDirectory()).map((entry) => this.directoryHasVisibleChildren(join(current, entry.name), ignored)));
			let probeIndex = 0;
			for (const entry of entries) {
				if (ignored.has(entry.name) || !entry.isDirectory()) continue;
				expandableByPath.set(join(current, entry.name), probes[probeIndex] ?? false);
				probeIndex += 1;
			}
		}
		const nodes: FileTreeNode[] = [];

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (ignored.has(entry.name)) continue;

			const absolutePath = join(current, entry.name);
			const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
			const meta = stats[i];
			const sharedMeta = meta ? { mtimeMs: meta.mtimeMs, ctimeMs: meta.ctimeMs, size: meta.isDirectory() ? 0 : meta.size } : undefined;

			if (entry.isDirectory()) {
				// 达到深度上限时不再递归，只看一层是否还有可见子项，避免抽屉一次拉整棵仓库。
				const canRecurse = depth < maxDepth;
				const children = canRecurse ? await this.readDirectory(root, absolutePath, depth + 1, maxDepth, ignored) : undefined;
				nodes.push({
					name: entry.name,
					path: absolutePath,
					relativePath,
					type: "directory",
					...sharedMeta,
					// 未递归时 children 为 undefined，省略该字段；已递归的空目录是 []。
					// 渲染层用「有没有 children 数组」区分未加载 vs 已加载空目录。
					...(children ? { children } : {}),
					hasChildren: canRecurse ? (children?.length ?? 0) > 0 : (expandableByPath.get(absolutePath) ?? false),
				});
			} else if (entry.isFile()) {
				nodes.push({
					name: entry.name,
					path: absolutePath,
					relativePath,
					type: "file",
					...sharedMeta,
				});
			}
		}

		// 默认按名称（目录优先）排序；维度切换排序由渲染层 fileTreeSort 承担
		return nodes.sort((a, b) => {
			if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
			return a.name.localeCompare(b.name);
		});
	}

	/** 浅层 listing 用：目录是否还有未被忽略的子项，决定是否显示展开箭头。 */
	private async directoryHasVisibleChildren(directory: string, ignored: Set<string>): Promise<boolean> {
		try {
			const entries = await readdir(directory, { withFileTypes: true });
			return entries.some((entry) => !ignored.has(entry.name) && (entry.isDirectory() || entry.isFile()));
		} catch {
			return false;
		}
	}

	/**
	 * 工作区文件名搜索（issue #215）：全盘 BFS 扫描，返回扁平命中列表，不构树。
	 * 与 listTree 的差异（为什么不能复用 readDirectory）：
	 * - 搜索必须穿透到任意深度，不能受懒加载深度/单层上限约束——大目录跳过而不是拒收；
	 * - 需要可中断：达到结果上限或超时立即返回已收集部分，用户拿到的是「够用的结果」
	 *   而不是报错（对超大 monorepo 尤其重要）。
	 * 查询按小写子串匹配；空查询由 IPC 层拦截，这里不再校验。
	 * 忽略规则与文件抽屉的文件树同档（只看 ALWAYS）：树里能看到的文件必须搜得到。
	 * 构建产物目录（build/dist/target…）排在第二轮扫：可见也可搜，但大仓库里 target/
	 * 的 class 文件会瞬间吃掉结果上限，先扫源码目录更符合「找文件」的预期。
	 */
	async searchNames(root: string, query: string): Promise<FileSearchResult[]> {
		const normalizedQuery = query.trim().toLowerCase();
		// 空查询兑底：includes("") 恒真，不清掉会返回全盘前 N 条；IPC 层已拦，这里防御直接调用方
		if (normalizedQuery.length === 0) return [];
		const rootResolved = resolve(root);
		// BFS 队列：先宽后深，优先命中浅层文件；目录命中也收集（跳转到目录/在文件夹中显示都有用）。
		const queue: string[] = [rootResolved];
		// 构建产物目录的子孙延后扫：见方法注释的重测顺序说明
		const deferredDirs: string[] = [];
		const results: FileSearchResult[] = [];
		// Date.now 只用来卡总耗时；单次 readdir 不单独限时（单目录失败即跳过）。
		const deadline = Date.now() + FILE_SEARCH_TIMEOUT_MS;
		while (queue.length > 0 && results.length < FILE_SEARCH_MAX_RESULTS && Date.now() < deadline) {
			const current = queue.shift()!;
			let entries;
			try {
				entries = await readdir(current, { withFileTypes: true });
			} catch {
				// 无权限/竞态删除：跳过该目录继续扫，不能让一个坏目录中断整次搜索
				continue;
			}
			// 超大目录只放弃这一层，不放弃整次搜索；listTree 的整层拒绝语义在这里反而会导致大仓库搜不到东西。
			if (entries.length > FILE_SEARCH_MAX_DIRECTORY_ENTRIES) continue;
			const pendingDirs: string[] = [];
			for (const entry of entries) {
				if (results.length >= FILE_SEARCH_MAX_RESULTS) break;
				const name = entry.name;
				if (ALWAYS_IGNORED_NAMES.has(name)) continue;
				if (!name.toLowerCase().includes(normalizedQuery)) {
					// 未命中也要入队目录继续下钻：搜索目标是「路径任意位置包含查询词的文件」
					if (entry.isDirectory()) (SCAN_ONLY_IGNORED_NAMES.has(name) ? deferredDirs : pendingDirs).push(join(current, name));
					continue;
				}
				const absolutePath = join(current, name);
				const type = entry.isDirectory() ? "directory" : "file";
				// symlink 等非常规类型直接跳过：Dirent 对符号链接的 isDirectory/isFile 均为 false，
				// 跳过既避免把链接当文件误报，也防 symlink 环导致 BFS 永不终止。
				if (type === "file" && !entry.isFile()) continue;
				results.push({
					name,
					path: absolutePath,
					relativePath: relative(rootResolved, absolutePath).replace(/\\/g, "/"),
					type,
				});
				if (entry.isDirectory()) (SCAN_ONLY_IGNORED_NAMES.has(name) ? deferredDirs : pendingDirs).push(absolutePath);
			}
			// 目录统一排在文件后入队：同层先收完文件再下钻，浅层文件命中优先于深层目录
			queue.push(...pendingDirs);
			// 源码目录全部扫完（队列空）才进入构建产物，避免 target/ 抢先占满结果上限
			if (queue.length === 0 && deferredDirs.length > 0) queue.push(...deferredDirs.splice(0, deferredDirs.length));
		}
		return results;
	}

	/** 删除文件或空目录；非空目录需要递归删除 */
	async delete(targetPath: string, recursive = false): Promise<void> {
		// 统一走系统回收站：文件抽屉的删除是用户主动操作，必须可恢复；
		// 回收站不可用时 trashPath 直接抛错（拒绝静默硬删），错误由 IPC 层呈现给用户。
		await trashPath(targetPath, { source: "files:delete" });
	}

	/** 重命名文件或目录 */
	async rename(targetPath: string, newName: string): Promise<string> {
		// P0 security：newName 必须是纯文件名——含分隔符或「..」组件会把 rename 变成
		// 跨目录 move 原语（join 不解析 ..，fsRename 由操作系统解析后可越出父目录）。
		// 与 create 的防护同源（AGENTS 路径安全：拼接前逃逸检查，渲染层输入一律不可信）。
		if (typeof newName !== "string" || newName.length === 0 || newName.length > 255 || newName !== basename(newName) || newName === "." || newName === ".." || /[\\/]/.test(newName) || /[\u0000-\u001f]/.test(newName)) {
			throw new Error(`Invalid file name: "${newName}"`);
		}
		const parent = dirname(targetPath);
		const newPath = join(parent, newName);
		// 结构断言：重命名不得越出原父目录（与 isPathInsideProject 防逃逸同源，双保险）
		if (!isPathInsideProject(parent, newPath)) {
			throw new Error(`Invalid file name: rename escapes parent directory`);
		}
		await fsRename(targetPath, newPath);
		return newPath;
	}

	/** 创建文件或目录，返回完整路径 */
	async create(parentDir: string, name: string, type: "file" | "directory"): Promise<string> {
		const fullPath = join(parentDir, name);
		// P0 security: prevent path traversal via ../ in name
		if (name.includes("..") || !fullPath.startsWith(parentDir)) {
			throw new Error(`Invalid path: "${name}" escapes parent directory`);
		}
		if (type === "directory") {
			await mkdir(fullPath, { recursive: true });
		} else {
			await writeFile(fullPath, "", "utf8");
		}
		return fullPath;
	}
}
