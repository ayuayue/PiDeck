package main

// 条目表落盘（Wave 2b）测试：复用、尾部增量、损坏/过期回退、目录上限。
//
// 核心手法：「改写源文件内容但保持 size 与 mtime 完全一致」——如果实现真的走了磁盘
// 条目文件，返回值会保留旧内容；一旦偷偷重扫源文件就会被发现（与 TS 侧
// session-summary-cache 的版本键测试同一招）。

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const persistedFixtureBody = `{"id":"s1","type":"session","timestamp":"2026-02-01T00:00:00.000Z"}` + "\n" +
	`{"id":"a1","parentId":"s1","type":"message","message":{"role":"user","content":[{"type":"text","text":"first"}]}}` + "\n" +
	`{"id":"a2","parentId":"a1","type":"message","message":{"role":"assistant","content":[{"type":"text","text":"second"}]}}` + "\n"

func tableIDs(entryTable table) []string {
	ids := make([]string, 0, len(entryTable.Entries))
	for _, entry := range entryTable.Entries {
		ids = append(ids, entry.ID)
	}
	return ids
}

func assertIDs(t *testing.T, entryTable table, want ...string) {
	t.Helper()
	got := tableIDs(entryTable)
	if len(got) != len(want) {
		t.Fatalf("条目数不符：got %v want %v", got, want)
	}
	for index := range want {
		if got[index] != want[index] {
			t.Fatalf("条目顺序不符：got %v want %v", got, want)
		}
	}
}

// 落盘后换一个新进程实例（新 tableCache）读取：拿到的必须是磁盘条目，
// 而不是重扫源文件的结果。
func TestPersistedTableReusedAcrossCacheInstances(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/persist.jsonl")
	fixture.write("sessions/persist.jsonl", persistedFixtureBody)
	tablesDir := filepath.Join(fixture.root, "tables")

	first, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	assertIDs(t, first, "s1", "a1", "a2")

	info, err := os.Stat(source)
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	tableFile := tableFilePath(tablesDir, source)
	if _, err := os.Stat(tableFile); err != nil {
		t.Fatalf("条目文件应已落盘: %v", err)
	}

	// 同长度改写（role user → USER）+ 还原 mtime：条目表里有 role 字段，
	// 只有真的复用了磁盘条目才会仍然读到小写 user（重扫会变成 USER）。
	mutated := strings.ReplaceAll(persistedFixtureBody, `"user"`, `"USER"`)
	if len(mutated) != len(persistedFixtureBody) {
		t.Fatalf("测试前提：改写后长度必须一致，%d vs %d", len(mutated), len(persistedFixtureBody))
	}
	if err := os.WriteFile(source, []byte(mutated), 0o644); err != nil {
		t.Fatalf("改写源文件失败: %v", err)
	}
	if err := os.Chtimes(source, info.ModTime(), info.ModTime()); err != nil {
		t.Fatalf("还原 mtime 失败: %v", err)
	}

	second, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("二次 getIndexTable 失败: %v", err)
	}
	assertIDs(t, second, "s1", "a1", "a2")
	if second.MtimeMs != first.MtimeMs || second.Size != first.Size {
		t.Fatalf("版本键应保持一致: %+v vs %+v", second, first)
	}
	// 条目字段来自磁盘条目文件（未被重扫覆盖）。
	if second.Entries[1].Role == nil || *second.Entries[1].Role != "user" {
		t.Fatalf("应复用磁盘条目里的 role=user，实际 %+v（说明偷偷重扫了源文件）", second.Entries[1].Role)
	}
}

// chainBody 生成一条可追到根的会话链（header + rounds 轮 user/toolResult/assistant）。
// prefix 决定 id 命名空间：整文件重写场景用不同前缀模拟「每条都换了新 id」。
func chainBody(prefix string, rounds int, pad int) string {
	var builder strings.Builder
	builder.WriteString(`{"id":"` + prefix + `s1","type":"session"}` + "\n")
	parent := prefix + "s1"
	for round := 1; round <= rounds; round++ {
		for _, step := range []string{"u", "t", "a"} {
			id := fmt.Sprintf("%s%s%d", prefix, step, round)
			fmt.Fprintf(&builder, `{"id":"%s","parentId":"%s","type":"message","message":{"role":"user","content":[{"type":"text","text":"%s"}]}}`+"\n", id, parent, strings.Repeat("x", pad))
			parent = id
		}
	}
	return builder.String()
}

// activeChain 复刻 TS traceActiveBranch：从末条沿 parentId 回溯，父条目缺失即停。
// 返回回溯到的条目数（活动链长度）。
func activeChain(entryTable table) int {
	byID := make(map[string]displayEntry, len(entryTable.Entries))
	for _, entry := range entryTable.Entries {
		byID[entry.ID] = entry
	}
	length := 0
	seen := make(map[string]bool, len(entryTable.Entries))
	current, ok := byID[entryTable.LastEntryID]
	for ok && !seen[current.ID] {
		seen[current.ID] = true
		length++
		if current.ParentID == nil {
			break
		}
		current, ok = byID[*current.ParentID]
	}
	return length
}

// 整文件重写且整体变长（外部工具重建 / 编辑后重写）：旧条目表的偏移全部失效。
// 若仍按「只是变长」做尾部增量，条目会从错位处开始，parentId 链随即断开——
// 表现就是 issue #392 的「只剩最后几轮、没有『加载更多』」，而且这张错表会按
// size+mtime 一直命中，重启也不自愈。必须退回全量重扫。
func TestPersistedTableRejectsRewrittenPrefixWhileGrowing(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/rewritten.jsonl")
	original := chainBody("a", 40, 0)
	fixture.write("sessions/rewritten.jsonl", original)
	tablesDir := filepath.Join(fixture.root, "tables")

	first, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	if activeChain(first) != len(first.Entries) {
		t.Fatalf("测试前提：首次扫描的活动链应覆盖全部条目，实际 %d/%d", activeChain(first), len(first.Entries))
	}

	// 整文件重写：每条都换新 id，同时整体变长（更长的正文）。
	rewritten := chainBody("b", 40, 400)
	if len(rewritten) <= len(original) {
		t.Fatalf("测试前提：重写后必须比原文件长，%d vs %d", len(rewritten), len(original))
	}
	fixture.write("sessions/rewritten.jsonl", rewritten)

	next, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("重写后 getIndexTable 失败: %v", err)
	}
	info, err := os.Stat(source)
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	fresh, err := scanTable(source, info.Size(), float64(info.ModTime().UnixNano())/1e6)
	if err != nil {
		t.Fatalf("对照全量重扫失败: %v", err)
	}
	if activeChain(next) != len(next.Entries) {
		t.Fatalf("活动链必须覆盖全部条目（否则时间线只剩尾部几轮、且没有『加载更多』），实际 %d/%d", activeChain(next), len(next.Entries))
	}
	if got, want := len(next.Entries), len(fresh.Entries); got != want {
		t.Fatalf("重写后条目数应等于全量重扫 %d，实际 %d（说明复用了失效的旧表）", want, got)
	}
	assertIDs(t, next, tableIDs(fresh)...)
}

// 旧版本写下的条目文件（版本号不符）一律丢弃重扫：升级后用户手里的失效表靠这条自愈。
// 这里故意让 size/mtime 与源文件完全一致（只有版本号不同），否则这道门禁只是被版本键
// 顺手挡住了，删掉版本号判断也测不出来。
func TestPersistedTableRejectsOutdatedVersion(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/version.jsonl")
	fixture.write("sessions/version.jsonl", persistedFixtureBody)
	info, err := os.Stat(source)
	if err != nil {
		t.Fatalf("stat 失败: %v", err)
	}
	tablesDir := filepath.Join(fixture.root, "tables")
	if err := os.MkdirAll(tablesDir, 0o755); err != nil {
		t.Fatalf("mkdir 失败: %v", err)
	}
	header := `{"version":` + strconv.Itoa(tableFileVersion-1) +
		`,"path":` + strconv.Quote(filepath.ToSlash(source)) +
		`,"size":` + strconv.FormatInt(info.Size(), 10) +
		`,"mtimeMs":` + strconv.FormatFloat(float64(info.ModTime().UnixNano())/1e6, 'f', -1, 64) +
		`,"endsWithNewline":true,"lastEntryId":"stale","oversizedLines":0,"entryCount":1}` + "\n"
	staleEntry := `{"id":"stale","type":"message","offset":0,"byteLength":1,"hasMessage":true}` + "\n"
	if err := os.WriteFile(tableFilePath(tablesDir, source), []byte(header+staleEntry), 0o644); err != nil {
		t.Fatalf("写旧版条目文件失败: %v", err)
	}

	rescanned, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("旧版条目文件应被丢弃重扫，实际报错: %v", err)
	}
	assertIDs(t, rescanned, "s1", "a1", "a2")
}

// 超长行（> 64MiB 只存 64KiB 前缀）也要能做边界校验：读前缀 + 正则抢 id，而不是解整行 JSON。
func TestVerifyTableBoundaryHandlesOversizedEntries(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/oversized.jsonl")
	line := `{"id":"big1","parentId":"s1","type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"` + strings.Repeat("z", 128*1024) + `"}]}}`
	fixture.write("sessions/oversized.jsonl", line+"\n")
	sessionSize := int64(len(line) + 1)
	oversized := true
	entry := displayEntry{ID: "big1", Offset: 0, ByteLength: int64(len(line)), Oversized: &oversized}
	if !verifyTableBoundary(source, sessionSize, []displayEntry{entry}) {
		t.Fatalf("超长行只读前缀也应该校验通过")
	}
	wrongID := entry
	wrongID.ID = "other"
	if verifyTableBoundary(source, sessionSize, []displayEntry{wrongID}) {
		t.Fatalf("id 不符必须判定失配")
	}
	misplaced := entry
	misplaced.Offset = 8
	if verifyTableBoundary(source, sessionSize, []displayEntry{misplaced}) {
		t.Fatalf("偏移错位必须判定失配")
	}
}

// 文件只变长（pi 正常追加）且上次停在换行边界：复用旧条目 + 只解析尾部。
func TestPersistedTableAppendsTailIncrementally(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/append.jsonl")
	fixture.write("sessions/append.jsonl", persistedFixtureBody)
	tablesDir := filepath.Join(fixture.root, "tables")

	if _, err := getIndexTable(newTableCache(tablesDir), source); err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}

	appendLine := `{"id":"a3","parentId":"a2","type":"message","message":{"role":"user","content":[{"type":"text","text":"appended"}]}}` + "\n"
	handle, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("打开源文件失败: %v", err)
	}
	if _, err := handle.WriteString(appendLine); err != nil {
		t.Fatalf("追加失败: %v", err)
	}
	handle.Close()

	grown, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("增量读取失败: %v", err)
	}
	assertIDs(t, grown, "s1", "a1", "a2", "a3")
	if !grown.EndsWithNewline {
		t.Fatal("追加完整行后 endsWithNewline 应为 true")
	}
	// 增量路径必须保留旧条目的 offset（复用而不是重扫）：第三条应从旧文件末尾开始。
	if grown.Entries[3].Offset != int64(len(persistedFixtureBody)) {
		t.Fatalf("新条目 offset 应等于旧文件大小 %d，实际 %d", len(persistedFixtureBody), grown.Entries[3].Offset)
	}

	// 增量结果同样落盘：再换实例读到的应是 4 条。
	reloaded, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("重载失败: %v", err)
	}
	assertIDs(t, reloaded, "s1", "a1", "a2", "a3")
}

// 上次停在残行边界（endsWithNewline=false）时不能做增量：残行会被当成整行固化。
func TestPersistedTableRejectsIncrementalWhenTailWasPartial(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/partial.jsonl")
	fixture.write("sessions/partial.jsonl", `{"id":"s1","type":"session"}`+"\n"+`{"id":"a1","parentId":"s1","type":"message"}`)
	tablesDir := filepath.Join(fixture.root, "tables")

	first, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	if first.EndsWithNewline {
		t.Fatal("测试前提：残行结尾应为 false")
	}

	handle, err := os.OpenFile(source, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("打开源文件失败: %v", err)
	}
	if _, err := handle.WriteString("\n" + `{"id":"a2","parentId":"a1","type":"message"}` + "\n"); err != nil {
		t.Fatalf("补全失败: %v", err)
	}
	handle.Close()

	reloaded, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("重扫失败: %v", err)
	}
	// 全量重扫：s1、a1（原残行现在完整了）、a2；不能出现两条 a1。
	assertIDs(t, reloaded, "s1", "a1", "a2")
	if !reloaded.EndsWithNewline {
		t.Fatal("补全换行后 endsWithNewline 应为 true")
	}
}

// 条目文件损坏：丢弃并重扫，绝不把错误抛给宿主（宿主会因此回退 TS，没必要）。
func TestPersistedTableCorruptionFallsBackToScan(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/corrupt.jsonl")
	fixture.write("sessions/corrupt.jsonl", persistedFixtureBody)
	tablesDir := filepath.Join(fixture.root, "tables")

	if _, err := getIndexTable(newTableCache(tablesDir), source); err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	tableFile := tableFilePath(tablesDir, source)
	if err := os.WriteFile(tableFile, []byte("not json at all\n"), 0o644); err != nil {
		t.Fatalf("写坏条目文件失败: %v", err)
	}

	recovered, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("损坏后应回退重扫，实际报错: %v", err)
	}
	assertIDs(t, recovered, "s1", "a1", "a2")

	// 重扫结果会覆盖坏文件：下一个实例能正常命中磁盘。
	again, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("恢复后读取失败: %v", err)
	}
	assertIDs(t, again, "s1", "a1", "a2")
}

// 文件被截短（重写/归档）：版本键不匹配且不可增量 → 全量重扫。
func TestPersistedTableRejectsShrunkSource(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/shrink.jsonl")
	fixture.write("sessions/shrink.jsonl", persistedFixtureBody)
	tablesDir := filepath.Join(fixture.root, "tables")

	if _, err := getIndexTable(newTableCache(tablesDir), source); err != nil {
		t.Fatalf("首次 getIndexTable 失败: %v", err)
	}
	fixture.write("sessions/shrink.jsonl", `{"id":"s1","type":"session"}`+"\n")

	rescanned, err := getIndexTable(newTableCache(tablesDir), source)
	if err != nil {
		t.Fatalf("重扫失败: %v", err)
	}
	assertIDs(t, rescanned, "s1")
}

// 没给目录时退化成纯内存缓存，不创建任何文件。
func TestPersistedTableDisabledWithoutDirectory(t *testing.T) {
	fixture := newFixture(t)
	source := fixture.path("sessions/memory-only.jsonl")
	fixture.write("sessions/memory-only.jsonl", persistedFixtureBody)

	cache := newTableCache("")
	if _, err := getIndexTable(cache, source); err != nil {
		t.Fatalf("内存模式失败: %v", err)
	}
	entries, err := os.ReadDir(fixture.root)
	if err != nil {
		t.Fatalf("readdir 失败: %v", err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), tableFileSuffix) {
			t.Fatalf("内存模式不应产生条目文件: %s", entry.Name())
		}
	}
}

// 目录上限：超过 maxTableFiles 时按修改时间淘汰最旧的，且永不删刚写的那个。
func TestPrunePersistedTablesKeepsNewestAndCurrent(t *testing.T) {
	dir := t.TempDir()
	base := time.Now().Add(-time.Hour)
	paths := make([]string, 0, maxTableFiles+3)
	for index := 0; index <= maxTableFiles+2; index++ {
		path := filepath.Join(dir, strings.Repeat("x", 3)+string(rune('a'+index%26))+string(rune('a'+index/26))+tableFileSuffix)
		if err := os.WriteFile(path, []byte("{}\n"), 0o644); err != nil {
			t.Fatalf("写文件失败: %v", err)
		}
		stamp := base.Add(time.Duration(index) * time.Second)
		if err := os.Chtimes(path, stamp, stamp); err != nil {
			t.Fatalf("设置 mtime 失败: %v", err)
		}
		paths = append(paths, path)
	}

	// 把最旧的那个当 keepPath：它必须活下来，多删掉一个倒数第二旧的。
	keepPath := paths[0]
	prunePersistedTables(dir, keepPath)

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("readdir 失败: %v", err)
	}
	if len(entries) > maxTableFiles {
		t.Fatalf("淘汰后仍超上限：%d > %d", len(entries), maxTableFiles)
	}
	if _, err := os.Stat(keepPath); err != nil {
		t.Fatalf("keepPath 不应被删除: %v", err)
	}
	if _, err := os.Stat(paths[len(paths)-1]); err != nil {
		t.Fatalf("最新的文件不应被删除: %v", err)
	}
}
