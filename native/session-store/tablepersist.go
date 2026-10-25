package main

// 条目表的磁盘持久化（Wave 2b）。
//
// 为什么必须落盘：实测（docs/session-data-plane-plan.md §8.10）Go 冷解析比 TS 慢 2–3×
// （31.1MiB 会话：Go 343ms vs TS 116ms，`encoding/json` 逐行解码输给 V8），sidecar 唯一
// 赢的是「条目已在内存」的 0ms；而内存缓存随进程退出丢失，`state.bin` 又只存文件级记账。
// 于是重启后首次打开大会话仍然要重扫——收益门禁因此未过，Wave 2 只能默认关。
// 把条目表落到磁盘，重启后首次 `get-index` 变成「读几百 KB ~ 几 MB 的条目文件」，
// 这才真的比 TS 快，Wave 2b 的判据就是实测这把差距（见 §8.11）。
//
// 设计取舍：
//   - **独立目录、独立文件**（`<userData>/session-store/tables/<sha1(path)>.table`），
//     不塞进 `state.bin`：state.bin 每次脏了就整体重写，而条目表可能几十 MB，
//     混在一起会让「只改一个文件」变成「重写全部条目」。
//   - **格式是「一行 header JSON + 每行一个条目 JSON」**：不用二进制定长记录，
//     因为 displayEntry 有十几个可选字段，二进制编码的代码量与漂移风险都高；
//     条目 JSON 体积约为源会话行的 1/5（不含 toolResult/thinking），读取成本足够低。
//   - **版本键与内存缓存同口径**：`size` + `mtimeMs` 都相等才复用；文件只变长且上次
//     扫描以换行结尾时走**尾部增量**（复用已读到的条目，只解析新增行）。
//     版本键看不出「文件被整份重写后恰好变长」，所以复用前还要用
//     `verifyTableBoundary` 回读首/末条目的字节位置核对 id（见该函数注释）。
//   - 一切失败都只 log：条目表是加速器，读到损坏/过期就重扫，绝不让会话打不开。
//   - 目录有上限（文件数 + 总字节），超了按最旧淘汰，避免 userData 无限长。

import (
	"bufio"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const (
	// tableFileVersion 条目文件格式版本：改结构/字段语义就递增，旧文件直接丢弃重扫。
	// v2：复用前新增字节边界校验（issue #392）。v1 条目文件可能已经与源文件脱节
	// （整份重写后恰好变长 → 尾部增量错位 → 活动链从错位处截断，只剩尾部几轮），
	// 递增版本号把用户手里这类失效文件一次性丢弃、按需重建。
	// v3：条目新增 user 消息 preview（导轨标题）；旧表没有该字段，必须重扫一次。
	tableFileVersion = 3
	// tableFileSuffix 条目文件后缀（`<sha1>.table`）。
	tableFileSuffix = ".table"
	// maxTableFiles 磁盘上最多保留的条目文件数（含最近打开过的历史会话）。
	maxTableFiles = 256
	// maxTableDirBytes 条目文件目录总字节上限（超了按最旧淘汰）。
	maxTableDirBytes = 512 * 1024 * 1024
	// maxPersistTableBytes 单个条目文件上限：超过就不落盘（只有极大会话会到），
	// 避免把 30MB+ 的条目表写盘换一点启动收益。
	maxPersistTableBytes = 32 * 1024 * 1024
)

// persistedTableHeader 条目文件第一行：既有版本键，也有重建所需的元数据。
type persistedTableHeader struct {
	Version         int     `json:"version"`
	Path            string  `json:"path"`
	Size            int64   `json:"size"`
	MtimeMs         float64 `json:"mtimeMs"`
	EndsWithNewline bool    `json:"endsWithNewline"`
	LastEntryID     string  `json:"lastEntryId,omitempty"`
	OversizedLines  int     `json:"oversizedLines"`
	EntryCount      int     `json:"entryCount"`
}

// tableFilePath 会话文件 → 条目文件名：路径哈希，避免非法字符与超长路径，
// 大小写归一化（Windows 同一文件可能以不同大小写出现）。
func tableFilePath(dir string, sessionPath string) string {
	sum := sha1.Sum([]byte(strings.ToLower(filepath.ToSlash(sessionPath))))
	return filepath.Join(dir, hex.EncodeToString(sum[:])+tableFileSuffix)
}

// readPersistedTable 读条目文件；任何不一致（版本/路径/大小/时间对不上、内容损坏）
// 都返回 ok=false 让调用方重扫，不返回错误——损坏不是异常，只是缓存不可用。
//
// 第二个返回值 appendable：文件只是变长了、且上次扫描停在换行边界，可以只解析尾部。
func readPersistedTable(dir string, sessionPath string, size int64, mtimeMs float64) (table, bool, bool) {
	if dir == "" {
		return table{}, false, false
	}
	filePath := tableFilePath(dir, sessionPath)
	handle, err := os.Open(filePath)
	if err != nil {
		return table{}, false, false
	}
	defer handle.Close()

	reader := bufio.NewReaderSize(handle, 256*1024)
	headerLine, err := reader.ReadBytes('\n')
	if err != nil {
		return table{}, false, false
	}
	var header persistedTableHeader
	if err := json.Unmarshal(headerLine, &header); err != nil || header.Version != tableFileVersion || header.Path != sessionPath {
		return table{}, false, false
	}
	// 大小/时间完全一致：磁盘里的条目就是当前文件的条目，直接用。
	if header.Size == size && header.MtimeMs == mtimeMs {
		entries, err := readEntryLines(reader, header.EntryCount)
		if err != nil {
			return table{}, false, false
		}
		return table{Path: sessionPath, Size: size, MtimeMs: mtimeMs, EndsWithNewline: header.EndsWithNewline, LastEntryID: header.LastEntryID, Entries: entries, OversizedLines: header.OversizedLines}, true, false
	}
	// 文件只变长且上次停在换行边界：复用旧条目，尾部增量。
	if header.Size < size && header.EndsWithNewline {
		entries, err := readEntryLines(reader, header.EntryCount)
		if err != nil {
			return table{}, false, false
		}
		return table{Path: sessionPath, Size: header.Size, MtimeMs: header.MtimeMs, EndsWithNewline: header.EndsWithNewline, LastEntryID: header.LastEntryID, Entries: entries, OversizedLines: header.OversizedLines}, false, true
	}
	return table{}, false, false
}

// verifyTableBoundary 校验条目表记下的字节偏移是否仍与源文件对齐。
//
// 版本键只有 size + mtimeMs，看不出「文件被整份重写、恰好更长」：编辑消息、压缩重写、
// 外部工具重建/导入、归档后换回另一份同名会话都会造成这种重写，而重写后条目 id 往往
// 全换。此时尾部增量会从旧 size 处接着解析，条目从错位点起与文件完全脱节，活动链
// （TS traceActiveBranch 从末条沿 parentId 回溯）就在断点处截断——用户看到的就是
// issue #392 的「只剩最后几轮、也没有『加载更多』」，且这张错表按 size+mtime 永久命中，
// 重启不自愈（删表才恢复）。
//
// 这里用与 TS 侧 appendIndexFromTail 同一招兜底：按表里的 offset/byteLength 读回源文件，
// 比对解析出的 id；不符就让调用方丢弃命中、整份重扫并覆盖落盘。
func verifyTableBoundary(path string, sessionSize int64, entries []displayEntry) bool {
	if len(entries) == 0 {
		return true
	}
	handle, err := os.Open(path)
	if err != nil {
		return false
	}
	defer handle.Close()
	// 首条盯住会话 header（标题重写/`/reload` 重写首行会改变后续偏移），
	// 末条盯住最常见的「改尾部 / 尾部错位」；len==1 时两者重合。
	probes := []displayEntry{entries[0]}
	if len(entries) > 1 {
		probes = append(probes, entries[len(entries)-1])
	}
	for _, probe := range probes {
		if !probeMatchesSource(handle, sessionSize, probe) {
			return false
		}
	}
	return true
}

// probeMatchesSource 读回单条条目所在字节段：普通行整行 JSON 解出 id；超长行只读
// 64KiB 前缀（落盘条目本身也只留了前缀，见 appendLineSegment/parseOversizedEntry）。
func probeMatchesSource(handle *os.File, sessionSize int64, probe displayEntry) bool {
	if probe.Offset < 0 || probe.ByteLength <= 0 || probe.Offset > sessionSize-probe.ByteLength {
		return false
	}
	oversized := probe.Oversized != nil && *probe.Oversized
	length := probe.ByteLength
	if oversized && length > oversizedPrefixBytes {
		length = oversizedPrefixBytes
	}
	buffer := make([]byte, length)
	read, err := handle.ReadAt(buffer, probe.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return false
	}
	if int64(read) != length {
		return false
	}
	if oversized {
		entry, ok := parseOversizedEntry(string(buffer), probe.Offset, probe.ByteLength)
		return ok && entry.ID == probe.ID
	}
	var parsed struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(buffer, &parsed); err != nil {
		return false
	}
	return parsed.ID == probe.ID
}

func readEntryLines(reader *bufio.Reader, expected int) ([]displayEntry, error) {
	entries := make([]displayEntry, 0, expected)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			var entry displayEntry
			if unmarshalErr := json.Unmarshal(line, &entry); unmarshalErr != nil {
				return nil, unmarshalErr
			}
			entries = append(entries, entry)
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return nil, err
		}
	}
	if expected > 0 && len(entries) != expected {
		return nil, errors.New("entry count mismatch")
	}
	return entries, nil
}

// writePersistedTable 原子写条目文件（tmp → rename），随后按上限淘汰旧文件。
// 失败只返回错误给调用方 log，不影响本次查询结果。
func writePersistedTable(dir string, entryTable table) error {
	if dir == "" || len(entryTable.Entries) == 0 {
		return nil
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	filePath := tableFilePath(dir, entryTable.Path)
	tmpPath := filePath + ".tmp"
	handle, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	writer := bufio.NewWriterSize(handle, 256*1024)
	counter := &countingWriter{writer: writer}
	encoder := json.NewEncoder(counter)
	header := persistedTableHeader{
		Version:         tableFileVersion,
		Path:            entryTable.Path,
		Size:            entryTable.Size,
		MtimeMs:         entryTable.MtimeMs,
		EndsWithNewline: entryTable.EndsWithNewline,
		LastEntryID:     entryTable.LastEntryID,
		OversizedLines:  entryTable.OversizedLines,
		EntryCount:      len(entryTable.Entries),
	}
	if err := encoder.Encode(header); err != nil {
		handle.Close()
		os.Remove(tmpPath)
		return err
	}
	for index := range entryTable.Entries {
		if err := encoder.Encode(entryTable.Entries[index]); err != nil {
			handle.Close()
			os.Remove(tmpPath)
			return err
		}
		// 条目 JSON 通常 150–400B；超过单文件上限就放弃落盘（删除半成品）。
		if index%64 == 0 && counter.total > maxPersistTableBytes {
			handle.Close()
			os.Remove(tmpPath)
			return nil
		}
	}
	if err := writer.Flush(); err != nil {
		handle.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := handle.Sync(); err != nil {
		handle.Close()
		os.Remove(tmpPath)
		return err
	}
	if err := handle.Close(); err != nil {
		os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, filePath); err != nil {
		os.Remove(tmpPath)
		return err
	}
	prunePersistedTables(dir, filePath)
	return nil
}

// countingWriter 统计已编码字节数：bufio 不暴露累计计数，而条目表可能几十 MB，
// 需要在写满上限前放弃（不是精确记账，只用于阈值判断）。
type countingWriter struct {
	writer io.Writer
	total  int64
}

func (counter *countingWriter) Write(payload []byte) (int, error) {
	written, err := counter.writer.Write(payload)
	counter.total += int64(written)
	return written, err
}

// prunePersistedTables 目录上限：文件数 > maxTableFiles 或总字节 > maxTableDirBytes 时，
// 按修改时间从旧到新删除（keepPath 永不删）。惰性执行、失败静默。
func prunePersistedTables(dir string, keepPath string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type candidate struct {
		path    string
		size    int64
		modTime int64
	}
	candidates := make([]candidate, 0, len(entries))
	var total int64
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), tableFileSuffix) {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			continue
		}
		full := filepath.Join(dir, entry.Name())
		size := info.Size()
		total += size
		candidates = append(candidates, candidate{path: full, size: size, modTime: info.ModTime().UnixNano()})
	}
	if len(candidates) <= maxTableFiles && total <= maxTableDirBytes {
		return
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].modTime < candidates[j].modTime })
	remaining := len(candidates)
	for _, item := range candidates {
		if remaining <= maxTableFiles && total <= maxTableDirBytes {
			return
		}
		if item.path == keepPath {
			continue
		}
		if err := os.Remove(item.path); err != nil {
			continue
		}
		total -= item.size
		remaining--
	}
}
