/**
 * Session 摘要缓存：按文件路径 + 版本（mtime+size）判定是否命中，
 * 避免周期扫描时反复读取和解析未变化的 JSONL 文件。
 */

export interface SessionFileVersion {
  mtimeMs: number;
  size: number;
}

interface CacheEntry<V> {
  version: SessionFileVersion;
  value: V;
}

export class SessionSummaryCache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();

  get(filePath: string, version: SessionFileVersion): V | undefined {
    const entry = this.store.get(filePath);
    if (!entry) return undefined;
    if (entry.version.mtimeMs !== version.mtimeMs || entry.version.size !== version.size) {
      this.store.delete(filePath);
      return undefined;
    }
    return entry.value;
  }

  set(filePath: string, version: SessionFileVersion, value: V): void {
    this.store.set(filePath, { version, value });
  }

  clear(): void {
    this.store.clear();
  }
}
