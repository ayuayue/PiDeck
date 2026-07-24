/**
 * Session 摘要缓存：内存 + 磁盘双层。
 *
 * - 命中条件：文件路径 + 版本（mtimeMs + size）
 * - 运行期内用 Map 加速周期扫描
 * - 重启后从 userData 磁盘缓存恢复，避免全量重读 JSONL
 * - 写盘采用 debounce + 原子 rename，失败静默（缓存失效只是慢，不能影响主流程）
 */

import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface SessionFileVersion {
  mtimeMs: number;
  size: number;
}

interface CacheEntry<V> {
  version: SessionFileVersion;
  value: V;
}

interface DiskCacheFile<V> {
  /** schema 版本，不兼容时整表丢弃 */
  version: number;
  entries: Record<string, CacheEntry<V>>;
}

const DISK_SCHEMA_VERSION = 1;
const SAVE_DEBOUNCE_MS = 800;

export class SessionSummaryCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly filePath: string;
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private loadPromise: Promise<void> | null = null;
  private loaded = false;
  private saving: Promise<void> | null = null;

  constructor(fileName = "session-summary-cache.json") {
    this.filePath = join(app.getPath("userData"), fileName);
  }

  /** 启动时加载磁盘缓存；可重复调用，只执行一次 */
  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadFromDisk()
      .catch(() => {
        // 损坏/缺失都当冷启动，不阻塞扫描
      })
      .finally(() => {
        this.loaded = true;
      });
    return this.loadPromise;
  }

  get(filePath: string, version: SessionFileVersion): V | undefined {
    const entry = this.store.get(filePath);
    if (!entry) return undefined;
    if (
      entry.version.mtimeMs !== version.mtimeMs ||
      entry.version.size !== version.size
    ) {
      this.store.delete(filePath);
      this.markDirty();
      return undefined;
    }
    return entry.value;
  }

  set(filePath: string, version: SessionFileVersion, value: V): void {
    const prev = this.store.get(filePath);
    // 内容与版本都相同则跳过，减少无意义写盘
    if (
      prev &&
      prev.version.mtimeMs === version.mtimeMs &&
      prev.version.size === version.size &&
      prev.value === value
    ) {
      return;
    }
    this.store.set(filePath, { version, value });
    this.markDirty();
  }

  /**
   * 只修剪“当前环境”下已消失的条目。
   * - local：只动 Windows 路径缓存，保留 WSL 路径
   * - wsl：只动 Linux 路径缓存，保留 Windows 路径
   * 这样切换 WSL/本地时不会互相踩盘。
   */
  prune(keepPaths: Iterable<string>, mode: "local" | "wsl" = "local"): void {
    const keep = new Set(keepPaths);
    let removed = false;
    for (const key of this.store.keys()) {
      const isWslPath = key.startsWith("/") && !/^[A-Za-z]:/.test(key);
      if (mode === "local" && isWslPath) continue;
      if (mode === "wsl" && !isWslPath) continue;
      if (!keep.has(key)) {
        this.store.delete(key);
        removed = true;
      }
    }
    if (removed) this.markDirty();
  }

  /**
   * 清空内存缓存。
   * persist=true 时同步写空盘；WSL 切换等场景应传 false，避免误删另一环境磁盘缓存。
   */
  clear(options?: { persist?: boolean }): void {
    if (this.store.size === 0) return;
    this.store.clear();
    if (options?.persist) this.markDirty();
  }

  /** 丢弃内存态并允许重新从磁盘加载（用于环境切换后恢复对应环境缓存）。 */
  async reloadFromDisk(): Promise<void> {
    this.store.clear();
    this.loaded = false;
    this.loadPromise = null;
    await this.ensureLoaded();
  }

  /** 立即刷盘（应用退出前可调用） */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    await this.saveToDisk();
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveToDisk();
    }, SAVE_DEBOUNCE_MS);
    // 防止 Node 因 timer 挂起进程；Electron 主进程通常不需要，但更安全
    this.saveTimer.unref?.();
  }

  private async loadFromDisk(): Promise<void> {
    const raw = await readFile(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as DiskCacheFile<V>;
    if (!parsed || parsed.version !== DISK_SCHEMA_VERSION || !parsed.entries) {
      return;
    }
    for (const [path, entry] of Object.entries(parsed.entries)) {
      if (
        !entry ||
        typeof entry !== "object" ||
        !entry.version ||
        typeof entry.version.mtimeMs !== "number" ||
        typeof entry.version.size !== "number"
      ) {
        continue;
      }
      this.store.set(path, entry);
    }
  }

  private async saveToDisk(): Promise<void> {
    if (!this.dirty) return;
    // 串行化写盘，避免并发 rename 踩踏
    if (this.saving) {
      await this.saving;
      if (!this.dirty) return;
    }
    this.saving = this.writeAtomic().finally(() => {
      this.saving = null;
    });
    await this.saving;
  }

  private async writeAtomic(): Promise<void> {
    try {
      const entries: Record<string, CacheEntry<V>> = {};
      for (const [path, entry] of this.store) {
        entries[path] = entry;
      }
      const payload: DiskCacheFile<V> = {
        version: DISK_SCHEMA_VERSION,
        entries,
      };
      const dir = dirname(this.filePath);
      await mkdir(dir, { recursive: true });
      const tmpPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(tmpPath, JSON.stringify(payload), "utf8");
      await rename(tmpPath, this.filePath);
      this.dirty = false;
    } catch {
      // 写盘失败保留 dirty，下次 set/flush 再试
    }
  }
}
