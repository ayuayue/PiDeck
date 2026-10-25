package main

// 条目表缓存（Wave 2 + 2b）：`get-index` 的重复读取命中内存，避免同一会话反复逐行解析；
// 退出后仍可从磁盘条目文件复用（见 tablepersist.go，Wave 2b）。
//
// 内存有界是硬要求（主进程与 sidecar 都是长命进程）：
//   - 命中上限 maxCachedTables 个文件；
//   - 估算上限 maxCachedTableBytes，超出时按 LRU 淘汰。
//
// 版本判定与 TS 侧缓存同口径：size 与 mtimeMs 都相等才复用；任一变化即重扫。

import (
	"os"
	"sync"
)

const (
	// maxCachedTables 同时缓存的会话文件数（含最近打开过的历史会话）。
	maxCachedTables = 16
	// maxCachedTableBytes 缓存估算字节上限（每条约 320B 估算，见 entryCostEstimate）。
	maxCachedTableBytes = 256 * 1024 * 1024
	// entryCostEstimate 单条目估算开销：字段名 + 典型字符串长度，用于上限保护。
	entryCostEstimate = 320
)

type cachedTable struct {
	table table
	order uint64
	cost  int
}

type tableCache struct {
	mu      sync.Mutex
	entries map[string]cachedTable
	// dir 条目文件的落盘目录（Wave 2b）；空串 = 只做内存缓存（tests 与降级路径）。
	dir     string
	clock   uint64
	cost    int
	hits    int
	misses  int
	evicted int
}

func newTableCache(dir string) *tableCache {
	return &tableCache{entries: make(map[string]cachedTable), dir: dir}
}

// get 命中且版本一致时返回表（同时刷新 LRU 次序）。
func (cache *tableCache) get(path string, size int64, mtimeMs float64) (table, bool) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	cached, ok := cache.entries[path]
	if !ok || cached.table.Size != size || cached.table.MtimeMs != mtimeMs {
		cache.misses++
		return table{}, false
	}
	cache.hits++
	cache.clock++
	cached.order = cache.clock
	cache.entries[path] = cached
	return cached.table, true
}

// put 写入并执行 LRU/容量淘汰。
func (cache *tableCache) put(entry table) {
	cost := len(entry.Entries) * entryCostEstimate
	cache.mu.Lock()
	defer cache.mu.Unlock()
	if previous, ok := cache.entries[entry.Path]; ok {
		cache.cost -= previous.cost
	}
	cache.clock++
	cache.entries[entry.Path] = cachedTable{table: entry, order: cache.clock, cost: cost}
	cache.cost += cost

	for len(cache.entries) > maxCachedTables || cache.cost > maxCachedTableBytes {
		oldestPath := ""
		var oldestOrder uint64
		for path, cached := range cache.entries {
			if oldestPath == "" || cached.order < oldestOrder {
				oldestPath = path
				oldestOrder = cached.order
			}
		}
		if oldestPath == "" {
			break
		}
		cache.cost -= cache.entries[oldestPath].cost
		delete(cache.entries, oldestPath)
		cache.evicted++
	}
}

func (cache *tableCache) statsSnapshot() (hits int, misses int, evicted int) {
	cache.mu.Lock()
	defer cache.mu.Unlock()
	return cache.hits, cache.misses, cache.evicted
}

// getIndexTable 取一个会话文件的条目表：内存 → 磁盘条目文件 → 全量扫描，逐级回退。
//
// 磁盘命中是 Wave 2b 的核心：重启后首次打开大会话不再重扫源文件（详见 tablepersist.go）。
// 失败（文件不可读/stat 失败）由调用方转成错误帧；宿主侧对此一律回退 TS 建表。
func getIndexTable(cache *tableCache, path string) (table, error) {
	info, err := os.Stat(path)
	if err != nil {
		return table{}, err
	}
	size := info.Size()
	mtimeMs := float64(info.ModTime().UnixNano()) / 1e6
	if cached, ok := cache.get(path, size, mtimeMs); ok {
		return cached, nil
	}

	// 磁盘条目文件：版本键一致直接用；只是变长且上次停在换行边界时尾部增量。
	// 两种命中都要先回读字节边界核对 id：版本键看不出「整份重写后恰好变长」，
	// 错位的旧表会让活动链截断（issue #392，见 verifyTableBoundary）。
	persisted, hit, appendable := readPersistedTable(cache.dir, path, size, mtimeMs)
	if (hit || appendable) && !verifyTableBoundary(path, size, persisted.Entries) {
		logf("get-index %s persisted table out of sync with file, full rescan", path)
		hit, appendable = false, false
	}
	if hit {
		logf("get-index %s table=disk entries=%d", path, len(persisted.Entries))
		cache.put(persisted)
		return persisted, nil
	} else if appendable {
		tail, err := scanTableFrom(path, size, mtimeMs, persisted.Size, persisted.Entries, persisted.LastEntryID, persisted.OversizedLines)
		if err == nil {
			logf("get-index %s table=disk+tail entries=%d (reused=%d)", path, len(tail.Entries), len(persisted.Entries))
			cache.put(tail)
			persistTable(cache.dir, tail)
			return tail, nil
		}
		logf("get-index %s tail scan failed (%v), full rescan", path, err)
	}

	scanned, err := scanTable(path, size, mtimeMs)
	if err != nil {
		return table{}, err
	}
	cache.put(scanned)
	persistTable(cache.dir, scanned)
	return scanned, nil
}

// persistTable 写盘失败只 log：条目表是加速器，写不进去不影响本次查询。
func persistTable(dir string, entryTable table) {
	if err := writePersistedTable(dir, entryTable); err != nil {
		logf("persist table failed for %s: %v", entryTable.Path, err)
	}
}
