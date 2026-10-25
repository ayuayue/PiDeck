package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// ── 测试工具：临时会话目录构造 ────────────────────────────────────────────

type fixture struct {
	t       *testing.T
	root    string // 会话扫描根（构造的临时 sessions 目录）
	corpus  string
	seq     int
	indexer *Indexer
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	fx := &fixture{t: t, root: filepath.Join(t.TempDir(), "sessions"), corpus: filepath.Join(t.TempDir(), "corpus")}
	if err := os.MkdirAll(fx.root, 0o755); err != nil {
		t.Fatal(err)
	}
	return fx
}

func (fx *fixture) boot() {
	fx.t.Helper()
	if fx.indexer != nil {
		fx.indexer.Close()
	}
	ix, err := OpenIndexer(fx.corpus, []string{fx.root})
	if err != nil {
		fx.t.Fatal(err)
	}
	if err := ix.BootIndex(func(done, total int) {}); err != nil {
		fx.t.Fatal(err)
	}
	fx.indexer = ix
	// Windows：句柄不关会让 t.TempDir 清理失败，必须兑底
	fx.t.Cleanup(func() { ix.Close() })
}

// writeSession：写一个会话文件（dir 可省略），返回路径。lines 是完整 JSONL 行。
func (fx *fixture) writeSession(dir string, lines ...string) string {
	fx.t.Helper()
	if dir == "" {
		dir = "--t--default"
	}
	full := filepath.Join(fx.root, dir)
	if err := os.MkdirAll(full, 0o755); err != nil {
		fx.t.Fatal(err)
	}
	fx.seq++
	path := filepath.Join(full, fmt.Sprintf("20260101_0000%02d_s%d.jsonl", fx.seq, fx.seq))
	body := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		fx.t.Fatal(err)
	}
	return path
}

func (fx *fixture) appendLine(path, line string) {
	fx.t.Helper()
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		fx.t.Fatal(err)
	}
	defer f.Close()
	if _, err := f.WriteString(line + "\n"); err != nil {
		fx.t.Fatal(err)
	}
}

func userMsg(id, text string) string {
	return fmt.Sprintf(`{"type":"message","id":%q,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":%s}}`, id, quoteJSON(text))
}

func assistantMsg(id, text string) string {
	return fmt.Sprintf(`{"type":"message","id":%q,"timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":%s}]}}`, id, quoteJSON(text))
}

func quoteJSON(s string) string {
	// 场景数据无控制字符，直接引用 Go 字符串字面量拼 JSON
	return `"` + strings.ReplaceAll(s, `"`, `\"`) + `"`
}

// ── 索引行为 ──────────────────────────────────────────────────────────────

func TestIndexOnlyTextBlocks(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "用户正文alpha"), assistantMsg("a1", "助手回复beta"))
	fx.writeSession("", `{"type":"model_change","model":"gpt"}`,
		userMsg("u2", "第二段"),
		`{"type":"message","id":"t1","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"user","content":[{"type":"toolResult","output":"tool输出不应入语料"}]}}`)
	fx.boot()
	stats := fx.indexer.Stats()
	if stats.SessionCount != 2 || stats.EntryCount != 3 {
		t.Fatalf("sessionCount=%d entryCount=%d, want 2/3（toolResult 不进语料）", stats.SessionCount, stats.EntryCount)
	}
}

func TestContentStringAndArray(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "字符串形态"))
	fx.writeSession("", assistantMsg("a1", "数组形态"))
	fx.boot()
	for _, q := range []string{"字符串形态", "数组形态"} {
		r := fx.indexer.Search(q, 10, 3)
		if r.TotalHitSessions != 1 {
			t.Fatalf("query %q: totalHitSessions=%d, want 1", q, r.TotalHitSessions)
		}
	}
}

func TestIncrementalAppendOnFreshProcess(t *testing.T) {
	fx := newFixture(t)
	path := fx.writeSession("", userMsg("u1", "第一段"), assistantMsg("a1", "第一回复"))
	fx.boot()
	if got := fx.indexer.Stats().EntryCount; got != 2 {
		t.Fatalf("entryCount=%d, want 2", got)
	}
	// 追加新消息 → 新进程 boot（宿主每次 spawn 是新进程，走 loadState+增量续读）
	fx.appendLine(path, userMsg("u2", "追加的MarkerInc段落"))
	fx.boot()
	stats := fx.indexer.Stats()
	if stats.EntryCount != 3 {
		t.Fatalf("entryCount=%d, want 3（追加续读不重建）", stats.EntryCount)
	}
	if r := fx.indexer.Search("MarkerInc", 10, 3); r.TotalHitSessions != 1 {
		t.Fatalf("appended text not searchable: %+v", r)
	}
}

func TestRewriteFileDropsOldEntries(t *testing.T) {
	fx := newFixture(t)
	path := fx.writeSession("", userMsg("u1", "旧内容OldUnique"), assistantMsg("a1", "旧回复"))
	fx.boot()
	// 整文件改写（size 缩小 → 全量重建路径）
	os.WriteFile(path, []byte(userMsg("u1", "新内容NewUnique")+"\n"), 0o644)
	fx.boot()
	r := fx.indexer.Search("OldUnique", 10, 3)
	if r.TotalHitSessions != 0 {
		t.Fatalf("rewritten old text still searchable: %+v", r)
	}
	if r := fx.indexer.Search("NewUnique", 10, 3); r.TotalHitSessions != 1 {
		t.Fatalf("rewritten new text missing: %+v", r)
	}
}

func TestDeleteFileRemovesEntries(t *testing.T) {
	fx := newFixture(t)
	a := fx.writeSession("--t--a", userMsg("u1", "会话A内容DelMark"))
	fx.writeSession("--t--b", userMsg("u2", "会话B内容"))
	fx.boot()
	os.Remove(a)
	fx.boot()
	stats := fx.indexer.Stats()
	if stats.SessionCount != 1 {
		t.Fatalf("sessionCount=%d, want 1", stats.SessionCount)
	}
	if r := fx.indexer.Search("DelMark", 10, 3); r.TotalHitSessions != 0 {
		t.Fatalf("deleted file still searchable: %+v", r)
	}
}

func TestDotDirectoriesSkipped(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "正常目录"))
	fx.writeSession(".pideck-archive", userMsg("u2", "归档目录ArchiveMark"))
	fx.writeSession(".trash", userMsg("u3", "回收站TrashMark"))
	fx.boot()
	stats := fx.indexer.Stats()
	if stats.SessionCount != 1 {
		t.Fatalf("sessionCount=%d, want 1（点开头目录跳过）", stats.SessionCount)
	}
	if r := fx.indexer.Search("ArchiveMark", 10, 3); r.TotalHitSessions != 0 {
		t.Fatalf("archive dir indexed: %+v", r)
	}
}

func TestStateSnapshotRoundtrip(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "快照往返RoundMark"), assistantMsg("a1", "回复"))
	fx.boot()
	first := fx.indexer.Stats()
	// 二次 boot：loadState 路径（快照存在），无变化则 entryCount 一致
	fx.boot()
	second := fx.indexer.Stats()
	if first.EntryCount != second.EntryCount || first.SessionCount != second.SessionCount {
		t.Fatalf("snapshot roundtrip mismatch: %+v vs %+v", first, second)
	}
	if r := fx.indexer.Search("RoundMark", 10, 3); r.TotalHitSessions != 1 {
		t.Fatalf("search after snapshot reload failed: %+v", r)
	}
}

func TestCorruptStateFallsBackToFullRebuild(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "损坏快照RebuildMark"))
	fx.boot()
	fx.indexer.Close()
	// 写坏 state 快照 → 下次 boot 全量重建，不致命
	if err := os.WriteFile(filepath.Join(fx.corpus, "state.json"), []byte("PDSI1\ngarbage"), 0o644); err != nil {
		t.Fatal(err)
	}
	fx.boot()
	stats := fx.indexer.Stats()
	if stats.SessionCount != 1 || stats.EntryCount != 1 {
		t.Fatalf("full rebuild failed: %+v", stats)
	}
	if r := fx.indexer.Search("RebuildMark", 10, 3); r.TotalHitSessions != 1 {
		t.Fatalf("search after rebuild failed: %+v", r)
	}
}

func TestStateCorpusSizeMismatchFallsBackToFullRebuild(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "压缩未入快照MismatchMark"))
	fx.boot()
	fx.indexer.Close()
	// 压缩先改 corpus.bin、后改 state.json；两次改名之间被杀 = 旧 state + 新（更小）语料。
	// 这里用截断模拟：快照里的 offset 不再成立，必须丢弃快照全量重建，否则错位/丢命中。
	corpusPath := filepath.Join(fx.corpus, "corpus.bin")
	if err := os.WriteFile(corpusPath, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	fx.boot()
	stats := fx.indexer.Stats()
	if !stats.FullRebuild {
		t.Fatalf("stale corpus smaller than snapshot must trigger full rebuild: %+v", stats)
	}
	if stats.SessionCount != 1 || stats.EntryCount != 1 {
		t.Fatalf("rebuild after size mismatch failed: %+v", stats)
	}
	if r := fx.indexer.Search("MismatchMark", 10, 3); r.TotalHitSessions != 1 {
		t.Fatalf("search after rebuild failed: %+v", r)
	}
}

func TestStateCorpusTailWithoutSnapshotStaysIncremental(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "追加尾部TailMark"))
	fx.boot()
	fx.indexer.Close()
	// 语料大于快照：上次被杀时写了未入快照的尾部。entries 依然成立，应走增量（
	// 否则每次被打断都要全量重建），多出的字节计入废弃字节。
	corpusPath := filepath.Join(fx.corpus, "corpus.bin")
	f, err := os.OpenFile(corpusPath, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString("dead-tail-bytes"); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	fx.boot()
	stats := fx.indexer.Stats()
	if stats.FullRebuild {
		t.Fatalf("corpus tail must not force a full rebuild: %+v", stats)
	}
	if stats.EntryCount != 1 {
		t.Fatalf("snapshot entries lost: %+v", stats)
	}
	if r := fx.indexer.Search("TailMark", 10, 3); r.TotalHitSessions != 1 {
		t.Fatalf("search after tail append failed: %+v", r)
	}
}

func TestCompactRemapsOffsets(t *testing.T) {
	fx := newFixture(t)
	a := fx.writeSession("--t--a", userMsg("u1", "compact废弃段KeepMark"))
	fx.writeSession("--t--b", userMsg("u2", "compact保留段DropMark"))
	fx.boot()
	os.Remove(a)
	// rescan 让删除生效（dropFileLocked 只在 rescan 里调），再手动 compact
	// （不解死字节阈值——验证的是 offset 重映射后搜索仍正确）
	if _, err := fx.indexer.Refresh(func(done, total int) {}); err != nil {
		t.Fatal(err)
	}
	fx.indexer.mu.Lock()
	err := fx.indexer.compactLocked()
	fx.indexer.mu.Unlock()
	if err != nil {
		t.Fatalf("compact: %v", err)
	}
	if r := fx.indexer.Search("KeepMark", 10, 3); r.TotalHitSessions != 0 {
		t.Fatalf("deleted text still searchable after compact: %+v", r)
	}
	if r := fx.indexer.Search("DropMark", 10, 3); r.TotalHitSessions != 1 {
		t.Fatalf("surviving text lost after compact: %+v", r)
	}
	// compact 后再走一次 saveState/loadState 往返，验证重映射后的快照可用
	fx.indexer.mu.Lock()
	if err := fx.indexer.saveStateLocked(); err != nil {
		t.Fatal(err)
	}
	fx.indexer.mu.Unlock()
	fx.boot()
	if r := fx.indexer.Search("DropMark", 10, 3); r.TotalHitSessions != 1 {
		t.Fatalf("search after post-compact snapshot reload failed: %+v", r)
	}
}

func TestEmptyCorpusSearch(t *testing.T) {
	fx := newFixture(t)
	fx.boot()
	r := fx.indexer.Search("任何词", 10, 3)
	if r.TotalHitSessions != 0 || len(r.Sessions) != 0 {
		t.Fatalf("empty corpus search: %+v", r)
	}
}

// ── 搜索语义 ──────────────────────────────────────────────────────────────

func TestSearchCaseFold(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "fix ZebraCrossing error"))
	fx.writeSession("", assistantMsg("a1", "ZEBRACROSSING uppercase form"))
	fx.boot()
	r := fx.indexer.Search("zebracrossing", 10, 3)
	if r.TotalHitSessions != 2 {
		t.Fatalf("ascii fold: totalHitSessions=%d, want 2", r.TotalHitSessions)
	}
}

func TestSearchCJKFastPath(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "中文快路径命中中文"))
	fx.writeSession("", userMsg("u2", "无关内容"))
	fx.boot()
	r := fx.indexer.Search("中文", 10, 3)
	if r.TotalHitSessions != 1 {
		t.Fatalf("cjk search: %+v", r)
	}
}

func TestSearchPerSessionAndLimit(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("--t--a", userMsg("u1", "命中一"), userMsg("u2", "命中二"), userMsg("u3", "命中三"), userMsg("u4", "命中四"))
	fx.writeSession("--t--b", userMsg("v1", "命中五"))
	fx.boot()
	r := fx.indexer.Search("命中", 10, 2)
	if len(r.Sessions) != 2 {
		t.Fatalf("sessions=%d, want 2", len(r.Sessions))
	}
	for _, s := range r.Sessions {
		if len(s.Matches) > 2 {
			t.Fatalf("perSession cap violated: %d matches", len(s.Matches))
		}
	}
	r = fx.indexer.Search("命中", 1, 2)
	if !r.Truncated || len(r.Sessions) != 1 || r.TotalHitSessions != 2 {
		t.Fatalf("limit truncation: sessions=%d total=%d truncated=%v", len(r.Sessions), r.TotalHitSessions, r.Truncated)
	}
}

func TestSearchOrdersByRecency(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("--t--older", userMsg("u1", "排序Older"))
	fx.writeSession("--t--newer", userMsg("u2", "排序Newer"))
	// 把 newer 的 mtime 拨到未来
	newerPath := filepath.Join(fx.root, "--t--newer")
	entries, _ := os.ReadDir(newerPath)
	for _, e := range entries {
		next := time.Now().Add(2 * time.Hour)
		os.Chtimes(filepath.Join(newerPath, e.Name()), next, next)
	}
	fx.boot()
	r := fx.indexer.Search("排序", 10, 3)
	if len(r.Sessions) != 2 || !strings.Contains(r.Sessions[0].FilePath, "--t--newer") {
		t.Fatalf("recency order wrong: %+v", r.Sessions)
	}
}

func TestSearchResultFields(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("", userMsg("u1", "字段检查FieldMark"), assistantMsg("a1", "字段检查回复"))
	fx.boot()
	r := fx.indexer.Search("FieldMark", 10, 3)
	if len(r.Sessions) != 1 || len(r.Sessions[0].Matches) != 1 {
		t.Fatalf("unexpected shape: %+v", r)
	}
	m := r.Sessions[0].Matches[0]
	if m.MessageId != "u1" || m.Role != "user" || m.TimestampMs == 0 || !strings.Contains(m.Snippet, "FieldMark") {
		t.Fatalf("match fields: %+v", m)
	}
}

func TestSnippetFoldsNewlines(t *testing.T) {
	out := buildSnippet([]byte("第一行\n第二行\t带制表符\r\n命中词尾部"), 0)
	if strings.ContainsAny(out, "\n\r\t") {
		t.Fatalf("snippet keeps control chars: %q", out)
	}
}

func TestSnippetRuneBoundary(t *testing.T) {
	// 全中文长文本，命中点靠近尾部——snippet 起止必须落在 rune 边界
	text := strings.Repeat("中", 300) + "TailMark"
	at := len(text) - len("TailMark")
	out := buildSnippet([]byte(text), at)
	if !strings.Contains(out, "TailMark") {
		t.Fatalf("snippet lost hit: %q", out)
	}
	for _, r := range out {
		if r == utf8.RuneError {
			t.Fatalf("snippet has invalid utf8: %q", out)
		}
	}
}

func TestAsciiLowerTo(t *testing.T) {
	out := asciiLowerTo(nil, []byte("ABC中文DEF"))
	if string(out) != "abc中文def" {
		t.Fatalf("asciiLowerTo: %q", out)
	}
}
