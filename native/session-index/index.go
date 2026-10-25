package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// ── 数据结构 ──────────────────────────────────────────────────────────────
//
// entries：语料中每段正文的元数据（内存常驻）。corpus.bin 只存纯文本字节，
// entry 通过 offset/length 引用；msgId 是消息 id（JSONL 行的 id 字段，宿主
// 用它 jumpToMessage 定位）。fileRef 引用 fileState.fileId（稳定自增 id，
// 不是 slice 下标——删除文件会让下标移位，id 不会）。

type entry struct {
	fileRef int32
	msgId   []byte
	role    byte // 1=user 2=assistant
	tsMs    int64
	offset  int64
	length  int32
}

// role 常量（entry.role）
const (
	roleUser      byte = 1
	roleAssistant byte = 2
)

func roleName(r byte) string {
	if r == roleUser {
		return "user"
	}
	return "assistant"
}

// fileState：单个会话 JSONL 的索引状态。parsedBytes 是「已解析的完整行总
// 字节数」——续读从该偏移开始；未闭合/解析失败的行不计入，下轮重读。
type fileState struct {
	FileId      int32  `json:"fileId"`
	Path        string `json:"path"`
	MtimeNs     int64  `json:"mtimeNs"`
	Size        int64  `json:"size"`
	ParsedBytes int64  `json:"parsedBytes"`
	UpdatedAtMs int64  `json:"updatedAtMs"`
}

type IndexStats struct {
	SessionCount int
	EntryCount   int
	CorpusBytes  int64
	FullRebuild  bool
}

type refreshStats struct {
	ChangedFiles  int    `json:"changedFiles"`
	RemovedFiles  int    `json:"removedFiles"`
	SessionCount  int    `json:"sessionCount"`
	EntryCount    int    `json:"entryCount"`
	CorpusBytes   int64  `json:"corpusBytes"`
	CompactReason string `json:"compactReason,omitempty"`
}

// ── Indexer ───────────────────────────────────────────────────────────────

type Indexer struct {
	roots     []string
	corpusDir string

	mu         sync.RWMutex
	files      []*fileState
	entries    []entry
	nextFileId int32

	// 本次 boot 是否全量重建（快照缺失/损坏）；仅 BootIndex 写、Stats 读。
	fullRebuild bool

	corpusPath string
	statePath  string
	// 语料文件句柄：追加写（写锁）与搜索分片 ReadAt（读锁，io.ReaderAt 并发安全）共用。
	corpusFile *os.File
	corpusSize int64
	deadBytes  int64
}

const (
	stateMagic = "PDSI1\n"
	// 单文件解析上界：超过视为异常文件，跳过不索引。
	maxSessionFileBytes = 512 * 1024 * 1024
	// 单条正文上界：超长 text 块（用户粘贴巨文）截断索引，防一条占几十 MB 语料。
	maxEntryTextBytes = 512 * 1024
	// compact 判据：废弃语料占比或绝对量超阈值时重写 corpus。
	compactDeadRatio = 0.4
	compactDeadAbs   = 64 * 1024 * 1024
)

func OpenIndexer(corpusDir string, roots []string) (*Indexer, error) {
	if len(roots) == 0 {
		return nil, errors.New("no session roots")
	}
	if err := os.MkdirAll(corpusDir, 0o755); err != nil {
		return nil, fmt.Errorf("create corpus dir: %w", err)
	}
	return &Indexer{
		roots:      roots,
		corpusDir:  corpusDir,
		corpusPath: filepath.Join(corpusDir, "corpus.bin"),
		statePath:  filepath.Join(corpusDir, "state.json"),
	}, nil
}

// BootIndex：启动索引。优先加载 state 快照（秒级就绪，逐文件 stat 校验后
// 只重扫变化文件）；快照缺失/损坏则全量重建。
func (ix *Indexer) BootIndex(progress func(done, total int)) error {
	// 快照缺失/损坏 → 清零全量重建，ready 帧据此告知宿主首建耗时来源
	ix.fullRebuild = true
	if err := ix.loadState(); err == nil {
		ix.fullRebuild = false
	} else {
		if !errors.Is(err, os.ErrNotExist) {
			logf("state snapshot unusable (%v), full rebuild", err)
		}
		ix.files, ix.entries, ix.nextFileId = nil, nil, 0
	}
	if err := ix.openCorpusForAppend(); err != nil {
		return err
	}
	if _, err := ix.rescan(progress); err != nil {
		return err
	}
	ix.mu.Lock()
	if err := ix.saveStateLocked(); err != nil {
		// 快照失败不影响查询，只影响下次启动速度
		logf("save state snapshot failed: %v", err)
	}
	ix.mu.Unlock()
	return nil
}

func (ix *Indexer) openCorpusForAppend() error {
	f, err := os.OpenFile(ix.corpusPath, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return fmt.Errorf("open corpus: %w", err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return fmt.Errorf("stat corpus: %w", err)
	}
	ix.corpusFile = f
	ix.corpusSize = info.Size()
	return nil
}

// Close：进程退出前释放句柄（宿主 dispose 时调用；不删文件——语料可复用）。
func (ix *Indexer) Close() {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.corpusFile != nil {
		ix.corpusFile.Close()
		ix.corpusFile = nil
	}
}

// Refresh：增量重扫（宿主在搜索前或定期调用）。
func (ix *Indexer) Refresh(progress func(done, total int)) (refreshStats, error) {
	stats, err := ix.rescan(progress)
	if err != nil {
		return stats, err
	}
	ix.mu.Lock()
	if err := ix.saveStateLocked(); err != nil {
		logf("save state snapshot failed: %v", err)
	}
	ix.mu.Unlock()
	return stats, nil
}

// rescan：walk roots → 对比 fileState → 增量解析/重建/删除。全程持锁（单
// 写者）；搜索走读锁可与索引并行。
func (ix *Indexer) rescan(progress func(done, total int)) (refreshStats, error) {
	ix.mu.Lock()
	defer ix.mu.Unlock()

	var stats refreshStats
	found := ix.walkRoots()
	progress(0, len(found))

	known := make(map[string]*fileState, len(ix.files))
	for _, fs := range ix.files {
		known[fs.Path] = fs
	}

	// 1) 已知文件：删除检测 + 变化重扫
	var kept []*fileState
	seen := make(map[string]bool, len(found))
	for _, fs := range ix.files {
		cur, ok := found[fs.Path]
		if !ok {
			ix.dropFileLocked(fs)
			stats.RemovedFiles++
			continue
		}
		seen[fs.Path] = true
		if cur.mtimeNs != fs.MtimeNs || cur.size != fs.Size {
			if err := ix.reindexFileLocked(fs, cur.mtimeNs, cur.size); err != nil {
				logf("reindex %s failed: %v", fs.Path, err)
			} else {
				stats.ChangedFiles++
			}
		}
		kept = append(kept, fs)
	}
	ix.files = kept

	// 2) 新文件全量解析（解析出至少一条正文才入册）
	for path, cur := range found {
		if seen[path] {
			continue
		}
		ix.nextFileId++
		fs := &fileState{FileId: ix.nextFileId, Path: path, UpdatedAtMs: cur.mtimeNs / 1e6}
		if err := ix.reindexFileLocked(fs, cur.mtimeNs, cur.size); err != nil {
			logf("index %s failed: %v", path, err)
			continue
		}
		if fs.ParsedBytes > 0 && ix.hasEntriesLocked(fs.FileId) {
			ix.files = append(ix.files, fs)
			stats.ChangedFiles++
			progress(stats.ChangedFiles, len(found))
		}
	}

	// 3) compact：废弃语料超阈值时重写 corpus（entries 的 offset 随之重映射）
	if ix.deadBytes > compactDeadAbs && float64(ix.deadBytes) > compactDeadRatio*float64(ix.corpusSize) {
		if err := ix.compactLocked(); err != nil {
			logf("compact failed: %v", err)
		} else {
			stats.CompactReason = "dead-bytes"
		}
	}

	stats.SessionCount = len(ix.files)
	stats.EntryCount = len(ix.entries)
	stats.CorpusBytes = ix.corpusSize
	return stats, nil
}

type fileProbe struct {
	mtimeNs int64
	size    int64
}

// walkRoots：收集 roots 下全部 *.jsonl。跳过点开头目录（.pideck-archive、
// .trash 等归档/回收目录不参与索引，与 SessionScanner 扫描口径一致）。
func (ix *Indexer) walkRoots() map[string]fileProbe {
	found := make(map[string]fileProbe)
	for _, root := range ix.roots {
		filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
			if err != nil {
				return nil // 单目录失败不影响其余
			}
			if d.IsDir() {
				if path != root && strings.HasPrefix(d.Name(), ".") {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(d.Name(), ".jsonl") {
				return nil
			}
			info, statErr := d.Info()
			if statErr != nil || !info.Mode().IsRegular() || info.Size() > maxSessionFileBytes {
				return nil
			}
			found[path] = fileProbe{mtimeNs: info.ModTime().UnixNano(), size: info.Size()}
			return nil
		})
	}
	return found
}

// dropFileLocked：删除文件——过滤其 entries，旧语料字节记废弃（compact 回收）。
func (ix *Indexer) dropFileLocked(fs *fileState) {
	out := ix.entries[:0]
	for _, e := range ix.entries {
		if e.fileRef != fs.FileId {
			out = append(out, e)
		}
	}
	ix.entries = out
	ix.deadBytes += fs.ParsedBytes
}

func (ix *Indexer) hasEntriesLocked(fileId int32) bool {
	for _, e := range ix.entries {
		if e.fileRef == fileId {
			return true
		}
	}
	return false
}

// reindexFileLocked：解析单个会话文件，正文追加进语料。size 增长且 mtime
// 更新 → 从 ParsedBytes 续读（append-only 增量）；否则视为改写/截断，全量
// 重建（先过滤旧 entries、旧语料记废弃）。
func (ix *Indexer) reindexFileLocked(fs *fileState, mtimeNs, size int64) error {
	incremental := fs.ParsedBytes > 0 && size >= fs.ParsedBytes && mtimeNs >= fs.MtimeNs
	startOffset := int64(0)
	if incremental {
		startOffset = fs.ParsedBytes
	} else {
		ix.dropFileLocked(fs)
		fs.ParsedBytes = 0
	}
	fs.MtimeNs = mtimeNs
	fs.Size = size
	fs.UpdatedAtMs = mtimeNs / 1e6

	f, err := os.Open(fs.Path)
	if err != nil {
		return err
	}
	defer f.Close()
	if startOffset > 0 {
		if _, err := f.Seek(startOffset, io.SeekStart); err != nil {
			return err
		}
	}

	reader := bufio.NewReaderSize(f, 256*1024)
	var newEntries []entry
	var latestTs int64
	for {
		line, readErr := reader.ReadBytes('\n')
		complete := readErr == nil
		if errors.Is(readErr, io.EOF) {
			if len(bytes.TrimSpace(line)) == 0 {
				break
			}
			complete = false // EOF 残余：可能未闭合，不计入 parsedBytes
		} else if readErr != nil {
			return readErr
		}
		trimmed := bytes.TrimRight(line, "\r\n")
		if len(bytes.TrimSpace(trimmed)) > 0 {
			for _, m := range parseMessageLine(trimmed) {
				text := m.text
				if len(text) > maxEntryTextBytes {
					text = text[:maxEntryTextBytes]
				}
				offset, werr := ix.appendToCorpusLocked(text)
				if werr != nil {
					return werr
				}
				newEntries = append(newEntries, entry{fileRef: fs.FileId, msgId: m.msgId, role: m.role, tsMs: m.tsMs, offset: offset, length: int32(len(text))})
				if m.tsMs > latestTs {
					latestTs = m.tsMs
				}
			}
		}
		if complete {
			fs.ParsedBytes += int64(len(line))
		} else {
			break
		}
	}
	ix.entries = append(ix.entries, newEntries...)
	if latestTs > fs.UpdatedAtMs {
		fs.UpdatedAtMs = latestTs
	}
	return nil
}

func (ix *Indexer) appendToCorpusLocked(text []byte) (int64, error) {
	offset := ix.corpusSize
	n, err := ix.corpusFile.WriteAt(text, offset)
	if err != nil {
		return 0, err
	}
	ix.corpusSize += int64(n)
	return offset, nil
}

// compactLocked：重写 corpus.bin 剔除废弃字节，重映射 entries 的 offset。
func (ix *Indexer) compactLocked() error {
	old, err := os.ReadFile(ix.corpusPath)
	if err != nil {
		return err
	}
	tmpPath := ix.corpusPath + ".tmp"
	tmp, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	var nextOffset int64
	buf := make([]byte, 0, 1<<20)
	for i := range ix.entries {
		e := &ix.entries[i]
		if e.offset+int64(e.length) > int64(len(old)) {
			tmp.Close()
			os.Remove(tmpPath)
			return fmt.Errorf("corpus shorter than entry offset %d", e.offset)
		}
		buf = append(buf[:0], old[e.offset:e.offset+int64(e.length)]...)
		if _, werr := tmp.Write(buf); werr != nil {
			tmp.Close()
			os.Remove(tmpPath)
			return werr
		}
		e.offset = nextOffset
		nextOffset += int64(e.length)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		os.Remove(tmpPath)
		return err
	}
	tmp.Close()
	ix.corpusFile.Close()
	if err := os.Rename(tmpPath, ix.corpusPath); err != nil {
		return err
	}
	ix.deadBytes = 0
	return ix.openCorpusForAppend()
}

// ── state 快照（state.json：JSON 头 + entries 二进制段 + msgId 池）────────

func (ix *Indexer) saveStateLocked() error {
	tmpPath := ix.statePath + ".tmp"
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	w := bufio.NewWriterSize(f, 1<<20)
	fail := func(err error) error {
		f.Close()
		os.Remove(tmpPath)
		return err
	}
	if _, err := w.WriteString(stateMagic); err != nil {
		return fail(err)
	}
	head, _ := json.Marshal(struct {
		Files      []*fileState `json:"files"`
		NextFileId int32        `json:"nextFileId"`
		CorpusSize int64        `json:"corpusSize"`
		DeadBytes  int64        `json:"deadBytes"`
		EntryCount int          `json:"entryCount"`
	}{Files: ix.files, NextFileId: ix.nextFileId, CorpusSize: ix.corpusSize, DeadBytes: ix.deadBytes, EntryCount: len(ix.entries)})
	if _, err := w.Write(head); err != nil {
		return fail(err)
	}
	if err := w.WriteByte('\n'); err != nil {
		return fail(err)
	}
	// entries 定长二进制记录 + 尾部 msgId 字符串池（NUL 分隔）
	var entBin bytes.Buffer
	entBin.Grow(len(ix.entries) * 40)
	var msgIds bytes.Buffer
	for _, e := range ix.entries {
		idStart := int32(msgIds.Len())
		msgIds.Write(e.msgId)
		msgIds.WriteByte(0)
		binary.Write(&entBin, binary.LittleEndian, e.fileRef)
		binary.Write(&entBin, binary.LittleEndian, idStart)
		binary.Write(&entBin, binary.LittleEndian, int32(len(e.msgId)))
		entBin.WriteByte(e.role)
		binary.Write(&entBin, binary.LittleEndian, e.tsMs)
		binary.Write(&entBin, binary.LittleEndian, e.offset)
		binary.Write(&entBin, binary.LittleEndian, e.length)
	}
	if _, err := w.Write(entBin.Bytes()); err != nil {
		return fail(err)
	}
	if _, err := w.Write(msgIds.Bytes()); err != nil {
		return fail(err)
	}
	if err := w.Flush(); err != nil {
		return fail(err)
	}
	if err := f.Sync(); err != nil {
		return fail(err)
	}
	f.Close()
	return os.Rename(tmpPath, ix.statePath)
}

// state 二进制记录定长：fileRef(4) + idStart(4) + idLen(4) + role(1) + ts(8) + offset(8) + length(4)
const stateRecSize = 4 + 4 + 4 + 1 + 8 + 8 + 4

func (ix *Indexer) loadState() error {
	raw, err := os.ReadFile(ix.statePath)
	if err != nil {
		return err
	}
	if !bytes.HasPrefix(raw, []byte(stateMagic)) {
		return errors.New("bad state magic")
	}
	body := raw[len(stateMagic):]
	nl := bytes.IndexByte(body, '\n')
	if nl < 0 {
		return errors.New("bad state head")
	}
	var head struct {
		Files      []*fileState `json:"files"`
		NextFileId int32        `json:"nextFileId"`
		CorpusSize int64        `json:"corpusSize"`
		DeadBytes  int64        `json:"deadBytes"`
		EntryCount int          `json:"entryCount"`
	}
	if err := json.Unmarshal(body[:nl], &head); err != nil {
		return err
	}
	blob := body[nl+1:]
	// 语料与快照必须同代。压缩先改名 corpus.bin、后改名 state.json，进程若在
	// 两次改名之间被杀（boot 超时/dispose/roots 变化都可能落在压缩期），就会留下
	// 「旧 state + 新（更小的）语料」：entry 的 offset 指向错位字节甚至越界，而
	// 文件的 size/mtime 未变 → 增量重扫修不回来（错位文本/命中静默丢失）。
	// 所以语料小于快照即判定快照不可用，让 BootIndex 全量重建。
	// （语料大于快照属正常：上次被杀时写入了未记入快照的尾部，按废弃字节计入）
	corpusInfo, statErr := os.Stat(ix.corpusPath)
	if statErr != nil {
		return fmt.Errorf("state corpus unavailable: %w", statErr)
	}
	if corpusInfo.Size() < head.CorpusSize {
		return fmt.Errorf("state corpus size mismatch: state=%d corpus=%d", head.CorpusSize, corpusInfo.Size())
	}
	need := head.EntryCount * stateRecSize
	if len(blob) < need {
		return fmt.Errorf("state truncated: entries need %d bytes, have %d", need, len(blob))
	}
	entries := make([]entry, 0, head.EntryCount)
	entBin, idPool := blob[:need], blob[need:]
	for i := 0; i < head.EntryCount; i++ {
		r := entBin[i*stateRecSize:]
		fileRef := int32(binary.LittleEndian.Uint32(r[0:]))
		idStart := int32(binary.LittleEndian.Uint32(r[4:]))
		idLen := int32(binary.LittleEndian.Uint32(r[8:]))
		role := r[12]
		tsMs := int64(binary.LittleEndian.Uint64(r[13:]))
		offset := int64(binary.LittleEndian.Uint64(r[21:]))
		length := int32(binary.LittleEndian.Uint32(r[29:]))
		if idStart < 0 || idLen < 0 || int(idStart+idLen) > len(idPool) {
			return errors.New("state truncated: msgId pool")
		}
		msgId := make([]byte, idLen)
		copy(msgId, idPool[idStart:idStart+idLen])
		entries = append(entries, entry{fileRef: fileRef, msgId: msgId, role: role, tsMs: tsMs, offset: offset, length: length})
	}
	ix.files = head.Files
	ix.entries = entries
	ix.nextFileId = head.NextFileId
	ix.corpusSize = head.CorpusSize
	ix.deadBytes = head.DeadBytes
	// 快照之后写入的尾部字节（上次被杀）没被 entry 引用，记作废弃字节，压缩时回收
	if tail := corpusInfo.Size() - head.CorpusSize; tail > 0 {
		ix.deadBytes += tail
	}
	return nil
}

func (ix *Indexer) Stats() IndexStats {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return IndexStats{SessionCount: len(ix.files), EntryCount: len(ix.entries), CorpusBytes: ix.corpusSize, FullRebuild: ix.fullRebuild}
}

// ── JSONL 行解析 ──────────────────────────────────────────────────────────
//
// 只提取 message 行的 user/assistant text 块；session/model_change 等其他行
// 跳过。content 兼容 string 与 [{type:"text",text}] 两种形态。

type rawMessage struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
}

type rawLine struct {
	Type      string      `json:"type"`
	ID        string      `json:"id"`
	Timestamp string      `json:"timestamp"`
	Message   *rawMessage `json:"message"`
}

type parsedText struct {
	msgId []byte
	role  byte
	tsMs  int64
	text  []byte
}

func parseTimestampMs(s string) int64 {
	if s == "" {
		return 0
	}
	if t, err := time.Parse(time.RFC3339Nano, s); err == nil {
		return t.UnixMilli()
	}
	return 0
}

func parseMessageLine(line []byte) []parsedText {
	var rl rawLine
	if err := json.Unmarshal(line, &rl); err != nil {
		return nil
	}
	if rl.Type != "message" || rl.Message == nil {
		return nil
	}
	var role byte
	switch rl.Message.Role {
	case "user":
		role = roleUser
	case "assistant":
		role = roleAssistant
	default:
		return nil
	}
	var texts [][]byte
	content := rl.Message.Content
	if len(content) > 0 && content[0] == '"' {
		var s string
		if err := json.Unmarshal(content, &s); err == nil && s != "" {
			texts = append(texts, []byte(s))
		}
	} else if len(content) > 0 && content[0] == '[' {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if err := json.Unmarshal(content, &blocks); err == nil {
			for _, b := range blocks {
				if b.Type == "text" && b.Text != "" {
					texts = append(texts, []byte(b.Text))
				}
			}
		}
	}
	if len(texts) == 0 {
		return nil
	}
	msgId := []byte(rl.ID)
	tsMs := parseTimestampMs(rl.Timestamp)
	out := make([]parsedText, 0, len(texts))
	for _, t := range texts {
		out = append(out, parsedText{msgId: msgId, role: role, tsMs: tsMs, text: t})
	}
	return out
}

// sortEntriesByOffset：搜索分片要求 entries 按语料 offset 有序（增量追加
// 天然有序；重建/删除会破坏全局序——分片前排一次保稳）。
func sortEntriesByOffset(entries []entry) {
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].offset < entries[j].offset })
}
