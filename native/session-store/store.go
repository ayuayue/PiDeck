package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// 快照格式版本：字段语义变化时递增，旧快照一律丢弃重建（不迁移、不报错）。
const snapshotFormatVersion = 1

// 会话目录里不做索引的子目录：成品归档与子代理产物都不是可读会话。
// 与 TS 侧扫描口径保持一致（见 src/main/sessions/SessionScanner.ts）。
var ignoredDirNames = map[string]bool{
	".pideck-archive":    true,
	"subagent-artifacts": true,
}

// fileState 是单个会话文件的持久化状态。
//
// Size 是「已提交字节数」，恒落在完整行边界上：文件写到一半时它停在最后一条
// 完整行的末尾，下一轮从该位置继续读，天然支持 pi 边写边追加。
//
// EntryCount 是 Wave 1 的内部口径（「带字符串 id 的完整行数」）；去重/分支/
// 超长行降级的精确口径属 Wave 2 建表，届时递增 snapshotFormatVersion。
type fileState struct {
	Path            string `json:"path"`
	Size            int64  `json:"size"`
	MtimeMs         int64  `json:"mtimeMs"`
	EntryCount      int    `json:"entryCount"`
	HasCompaction   bool   `json:"hasCompaction"`
	EndsWithNewline bool   `json:"endsWithNewline"`
}

type snapshot struct {
	FormatVersion int         `json:"formatVersion"`
	Files         []fileState `json:"files"`
}

// listStats 是 list-files / refresh 的回包，也是 Wave 2 门禁要看的口径：
// 第二次读取应当 reused≈文件数 且 full=0，追加内容后 incremental=1。
type listStats struct {
	Files       []fileState `json:"files"`
	Reused      int         `json:"reused"`
	Incremental int         `json:"incremental"`
	Full        int         `json:"full"`
	Pruned      int         `json:"pruned"`
	IndexMs     int64       `json:"indexMs"`
}

type Store struct {
	mu        sync.Mutex
	statePath string
	files     map[string]fileState
}

// OpenStore 读取快照；文件不存在、损坏或版本不符都视为空状态（静默重建）。
func OpenStore(statePath string) *Store {
	store := &Store{statePath: statePath, files: make(map[string]fileState)}
	raw, err := os.ReadFile(statePath)
	if err != nil {
		if !os.IsNotExist(err) {
			logf("state snapshot unreadable, starting empty: %v", err)
		}
		return store
	}
	var loaded snapshot
	if err := json.Unmarshal(raw, &loaded); err != nil || loaded.FormatVersion != snapshotFormatVersion {
		logf("state snapshot unusable, starting empty: version=%d err=%v", loaded.FormatVersion, err)
		return store
	}
	for _, file := range loaded.Files {
		if file.Path == "" {
			continue
		}
		store.files[file.Path] = file
	}
	return store
}

// ListFiles 扫描 roots 下的会话文件：未变的复用快照、追加的只读尾段、变短的重扫。
func (s *Store) ListFiles(roots []string) (listStats, error) {
	startedAt := time.Now()
	s.mu.Lock()
	defer s.mu.Unlock()

	paths, err := collectSessionFiles(roots)
	if err != nil {
		return listStats{}, err
	}

	stats := listStats{Files: make([]fileState, 0, len(paths))}
	seen := make(map[string]bool, len(paths))
	dirty := false

	for _, path := range paths {
		info, statErr := os.Stat(path)
		if statErr != nil || !info.Mode().IsRegular() {
			continue
		}
		state, kind, scanErr := s.stateFor(path, info)
		if scanErr != nil {
			logf("scan failed, skipping file: path=%s err=%v", path, scanErr)
			continue
		}
		seen[path] = true
		s.files[path] = state
		stats.Files = append(stats.Files, state)
		switch kind {
		case scanReused:
			stats.Reused++
		case scanIncremental:
			stats.Incremental++
		case scanFull:
			stats.Full++
		}
		if kind != scanReused {
			dirty = true
		}
	}

	// 被删除/移出 roots 的记录不再保留，避免快照无限增长。
	for path := range s.files {
		if !seen[path] {
			delete(s.files, path)
			stats.Pruned++
			dirty = true
		}
	}
	sort.Slice(stats.Files, func(i, j int) bool { return stats.Files[i].Path < stats.Files[j].Path })

	if dirty {
		if err := s.saveLocked(); err != nil {
			// 快照写失败不影响本次结果：数据在内存里是对的，下一轮再写。
			logf("state snapshot write failed: %v", err)
		}
	}
	stats.IndexMs = time.Since(startedAt).Milliseconds()
	return stats, nil
}

type scanKind int

const (
	scanReused scanKind = iota
	scanIncremental
	scanFull
)

func (s *Store) stateFor(path string, info os.FileInfo) (fileState, scanKind, error) {
	size := info.Size()
	mtimeMs := info.ModTime().UnixMilli()
	prev, hasPrev := s.files[path]

	if hasPrev && prev.Size == size && prev.MtimeMs == mtimeMs {
		return prev, scanReused, nil
	}
	if hasPrev && size > prev.Size && prev.Size > 0 && prev.EndsWithNewline {
		delta, err := scanRange(path, prev.Size)
		if err == nil {
			next := prev
			next.Size = delta.CommittedSize
			next.MtimeMs = mtimeMs
			next.EntryCount += delta.EntryCount
			next.HasCompaction = prev.HasCompaction || delta.HasCompaction
			next.EndsWithNewline = delta.EndsWithNewline
			return next, scanIncremental, nil
		}
		logf("incremental scan failed, falling back to full rescan: path=%s err=%v", path, err)
	}

	full, err := scanRange(path, 0)
	if err != nil {
		return fileState{}, scanFull, err
	}
	return fileState{
		Path:            path,
		Size:            full.CommittedSize,
		MtimeMs:         mtimeMs,
		EntryCount:      full.EntryCount,
		HasCompaction:   full.HasCompaction,
		EndsWithNewline: full.EndsWithNewline,
	}, scanFull, nil
}

// saveLocked 原子落盘：先写 .tmp 再改名，进程被杀不会留下半截快照。
func (s *Store) saveLocked() error {
	files := make([]fileState, 0, len(s.files))
	for _, file := range s.files {
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })

	payload, err := json.Marshal(snapshot{FormatVersion: snapshotFormatVersion, Files: files})
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.statePath), 0o755); err != nil {
		return err
	}
	tmpPath := s.statePath + ".tmp"
	if err := os.WriteFile(tmpPath, payload, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmpPath, s.statePath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// SnapshotSize 供 ready 帧/诊断使用。
func (s *Store) SnapshotSize() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.files)
}

// collectSessionFiles 收集 roots 下的 *.jsonl，跳过非会话子目录，路径去重后排序。
func collectSessionFiles(roots []string) ([]string, error) {
	seen := make(map[string]bool)
	var paths []string

	var walk func(dir string, depth int)
	walk = func(dir string, depth int) {
		if depth > 32 {
			return
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() {
				if ignoredDirNames[name] {
					continue
				}
				walk(filepath.Join(dir, name), depth+1)
				continue
			}
			if !entry.Type().IsRegular() || !strings.EqualFold(filepath.Ext(name), ".jsonl") {
				continue
			}
			path := filepath.Join(dir, name)
			key := strings.ToLower(path)
			if seen[key] {
				continue
			}
			seen[key] = true
			paths = append(paths, path)
		}
	}

	for _, root := range roots {
		cleaned := filepath.Clean(root)
		if cleaned == "" {
			continue
		}
		info, err := os.Stat(cleaned)
		if err != nil || !info.IsDir() {
			continue
		}
		walk(cleaned, 0)
	}
	sort.Strings(paths)
	return paths, nil
}

func formatStats(stats listStats) string {
	return fmt.Sprintf("files=%d reused=%d incremental=%d full=%d pruned=%d indexMs=%d",
		len(stats.Files), stats.Reused, stats.Incremental, stats.Full, stats.Pruned, stats.IndexMs)
}
