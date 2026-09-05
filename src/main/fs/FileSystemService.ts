import { readdir, rename as fsRename, mkdir, writeFile, stat } from "node:fs/promises";
import { join, relative, dirname, resolve, sep } from "node:path";
import { trashPath } from "./trash";
import { parseWslUncPath } from "../wsl/WslPaths";
import type { FileTreeNode } from "../../shared/types";
import {
  DEFAULT_FILE_TREE_MAX_DEPTH,
  FILE_TREE_ABSOLUTE_MAX_DEPTH,
  FILE_TREE_MAX_DIRECTORY_ENTRIES,
} from "../../shared/fileTree";

// target 是 Maven/Gradle 构建产物目录，与 build/dist 同类；不忽略会让 composer @
// 整树搜索深挖进 target/（含大量 class 文件），既拖慢又污染引用候选。
const ignoredNames = new Set([
  ".git", "node_modules", "dist", "build", "target", ".next", "coverage", ".venv", "__pycache__",
]);

/** 路径必须落在项目根内（resolve 后比较，防 ../ 逃逸）。 */
export function isPathInsideProject(root: string, target: string): boolean {
  const rootWsl = parseWslUncPath(root);
  const targetWsl = parseWslUncPath(target);
  if (rootWsl || targetWsl) {
    if (!rootWsl || !targetWsl) return false;
    if (rootWsl.distro.toLowerCase() !== targetWsl.distro.toLowerCase()) return false;
    // UNC host/distro 属于 Windows 命名，Linux 文件段仍区分大小写，不能整体 lower-case。
    return targetWsl.linuxPath === rootWsl.linuxPath
      || targetWsl.linuxPath.startsWith(`${rootWsl.linuxPath.replace(/\/$/, "")}/`);
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
  async listTree(
    root: string,
    maxDepth = DEFAULT_FILE_TREE_MAX_DEPTH,
    directory?: string,
  ): Promise<FileTreeNode[]> {
    const current = directory ? resolve(directory) : resolve(root);
    if (!isPathInsideProject(root, current)) {
      throw new Error(`Invalid path: "${directory}" escapes project directory`);
    }
    const depthLimit = Math.max(0, Math.min(maxDepth, FILE_TREE_ABSOLUTE_MAX_DEPTH));
    return this.readDirectory(root, current, 0, depthLimit);
  }

  private async readDirectory(root: string, current: string, depth: number, maxDepth: number): Promise<FileTreeNode[]> {
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
    const nodes: FileTreeNode[] = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (ignoredNames.has(entry.name)) continue;

      const absolutePath = join(current, entry.name);
      const relativePath = relative(root, absolutePath).replace(/\\/g, "/");
      const meta = stats[i];
      const sharedMeta = meta
        ? { mtimeMs: meta.mtimeMs, ctimeMs: meta.ctimeMs, size: meta.isDirectory() ? 0 : meta.size }
        : undefined;

      if (entry.isDirectory()) {
        // 达到深度上限时不再递归，只看一层是否还有可见子项，避免抽屉一次拉整棵仓库。
        const canRecurse = depth < maxDepth;
        const children = canRecurse
          ? await this.readDirectory(root, absolutePath, depth + 1, maxDepth)
          : undefined;
        nodes.push({
          name: entry.name,
          path: absolutePath,
          relativePath,
          type: "directory",
          ...sharedMeta,
          // 未递归时 children 为 undefined，省略该字段；已递归的空目录是 []。
          // 渲染层用「有没有 children 数组」区分未加载 vs 已加载空目录。
          ...(children ? { children } : {}),
          hasChildren: canRecurse
            ? (children?.length ?? 0) > 0
            : await this.directoryHasVisibleChildren(absolutePath),
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
  private async directoryHasVisibleChildren(directory: string): Promise<boolean> {
    try {
      const entries = await readdir(directory, { withFileTypes: true });
      return entries.some((entry) => !ignoredNames.has(entry.name) && (entry.isDirectory() || entry.isFile()));
    } catch {
      return false;
    }
  }

  /** 删除文件或空目录；非空目录需要递归删除 */
  async delete(targetPath: string, recursive = false): Promise<void> {
    // 统一走系统回收站：文件抽屉的删除是用户主动操作，必须可恢复；
    // 回收站不可用时 trashPath 直接抛错（拒绝静默硬删），错误由 IPC 层呈现给用户。
    await trashPath(targetPath, { source: "files:delete" });
  }

  /** 重命名文件或目录 */
  async rename(targetPath: string, newName: string): Promise<string> {
    const parent = dirname(targetPath);
    const newPath = join(parent, newName);
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
