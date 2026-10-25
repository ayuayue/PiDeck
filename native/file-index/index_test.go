package main

import (
	"os"
	"path/filepath"
	"testing"
)

type fixture struct {
	t       *testing.T
	root    string
	indexer *Indexer
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	return &fixture{t: t, root: t.TempDir()}
}

// writeFile 建目录 + 写文件，返回绝对路径。
func (f *fixture) writeFile(rel, content string) string {
	f.t.Helper()
	abs := filepath.Join(f.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
		f.t.Fatal(err)
	}
	return abs
}

// boot 用固定根集合建立索引（模拟 sidecar boot 阶段）。
func (f *fixture) boot(extraRoots ...string) {
	f.t.Helper()
	roots := append([]string{f.root}, extraRoots...)
	indexer, err := OpenIndexer(roots)
	if err != nil {
		f.t.Fatalf("OpenIndexer: %v", err)
	}
	indexer.Index()
	f.indexer = indexer
}

func (f *fixture) names(query string, limit int) nameResult {
	return f.indexer.SearchNames(query, limit)
}

func (f *fixture) content(query string, limit int, maxFileBytes, maxScannedBytes int64) contentResult {
	return f.indexer.SearchContent(query, limit, maxFileBytes, maxScannedBytes)
}

// firstPath 取首个命中的绝对路径（测试断言用；无命中即失败）。
func (f *fixture) firstPath(result nameResult) string {
	f.t.Helper()
	if len(result.Hits) == 0 {
		f.t.Fatalf("expected at least one hit")
	}
	return result.Hits[0].Path
}

func TestSearchNamesPrefersNameThenPath(t *testing.T) {
	fx := newFixture(t)
	mainGo := fx.writeFile("src/main/main.go", "package main\n")
	fx.writeFile("src/main/parser.go", "package main\n")
	surface := fx.writeFile("src/renderer/WorkspaceSurface.tsx", "export {}\n")
	fx.writeFile("README.md", "# hi\n")
	fx.boot()

	if got := fx.firstPath(fx.names("main.go", 50)); got != mainGo {
		t.Fatalf("精确文件名应排第一，got %s", got)
	}
	// 子序列（fzf 式）：wsurf → WorkspaceSurface.tsx
	if got := fx.firstPath(fx.names("wsurf", 50)); got != surface {
		t.Fatalf("名字子序列应命中，got %s", got)
	}
	// 路径段命中：旧 BFS 只匹配条目名，这里必须能搜到该文件
	// （目录 src/renderer 名字恰好等于查询词，它命中属正常；关键是文件也在结果里）
	if hits := fx.names("renderer", 50); !containsHitName(hits.Hits, "WorkspaceSurface.tsx") {
		t.Fatalf("路径段命中缺失，got %+v", hits.Hits)
	}
	// 大小写不敏感
	if hits := fx.names("SURFACE", 50); len(hits.Hits) != 1 {
		t.Fatalf("大小写不敏感失败，got %+v", hits.Hits)
	}
	if hits := fx.names("no-such-name", 50); len(hits.Hits) != 0 {
		t.Fatalf("不应命中，got %+v", hits.Hits)
	}
}

func TestSearchNamesRankingNameBeatsPath(t *testing.T) {
	nameScore, ok := fuzzyScore("main.go", "src/main.go", "main", false)
	if !ok {
		t.Fatal("name hit expected")
	}
	pathScore, ok := fuzzyScore("parser.ts", "src/main/parser.ts", "main", false)
	if !ok {
		t.Fatal("path hit expected")
	}
	if nameScore <= pathScore {
		t.Fatalf("名字命中(%d)必须高于路径命中(%d)", nameScore, pathScore)
	}
}

func TestIndexSkipsIgnoredAndNonRegularEntries(t *testing.T) {
	fx := newFixture(t)
	fx.writeFile("src/app.ts", "ok\n")
	fx.writeFile("node_modules/pkg/index.js", "x\n")
	fx.writeFile(".git/config", "x\n")
	fx.writeFile("dist/bundle.js", "x\n")
	if err := os.Symlink(filepath.Join(fx.root, "src", "app.ts"), filepath.Join(fx.root, "link.ts")); err != nil {
		t.Logf("symlink 不可用，跳过该断言：%v", err)
	}
	fx.boot()

	if hits := fx.names("index.js", 50); len(hits.Hits) != 0 {
		t.Fatalf("node_modules 必须被忽略，got %+v", hits.Hits)
	}
	if hits := fx.names("config", 50); len(hits.Hits) != 0 {
		t.Fatalf(".git 必须被忽略，got %+v", hits.Hits)
	}
	if hits := fx.names("bundle", 50); len(hits.Hits) != 0 {
		t.Fatalf("dist 必须被忽略，got %+v", hits.Hits)
	}
	if hits := fx.names("link.ts", 50); len(hits.Hits) != 0 {
		t.Fatalf("symlink 不应入索引，got %+v", hits.Hits)
	}
	stats := fx.indexer.Stats()
	if stats.Files != 1 || stats.Dirs != 1 {
		t.Fatalf("只应有 1 文件 + 1 目录，got files=%d dirs=%d", stats.Files, stats.Dirs)
	}
}

// containsHitName 是测试辅助：结果集里是否存在某个文件名的命中。
func containsHitName(hits []nameHit, name string) bool {
	for _, hit := range hits {
		if hit.Name == name {
			return true
		}
	}
	return false
}

func TestSearchNamesLimitMarksTruncated(t *testing.T) {
	fx := newFixture(t)
	for i := 0; i < 10; i++ {
		fx.writeFile(filepath.ToSlash(filepath.Join("many", "file"+string(rune('a'+i))+".txt")), "x\n")
	}
	fx.boot()

	result := fx.names("file", 3)
	if len(result.Hits) != 3 || !result.Truncated {
		t.Fatalf("limit=3 应截断并标记，got %d truncated=%v", len(result.Hits), result.Truncated)
	}
}

func TestNestedRootsDoNotDuplicateEntries(t *testing.T) {
	fx := newFixture(t)
	inner := filepath.Join(fx.root, "sub")
	fx.writeFile("sub/deep/note.md", "x\n")
	fx.boot(inner)

	result := fx.names("note.md", 50)
	if len(result.Hits) != 1 {
		t.Fatalf("嵌套根不应产生重复条目，got %+v", result.Hits)
	}
}

func TestRefreshPicksUpAddedAndRemovedFiles(t *testing.T) {
	fx := newFixture(t)
	added := fx.writeFile("src/old.ts", "x\n")
	fx.boot()
	if len(fx.names("old.ts", 50).Hits) != 1 {
		t.Fatal("初始索引应包含 old.ts")
	}

	newFile := fx.writeFile("src/new.ts", "x\n")
	fx.indexer.Index()
	if len(fx.names("new.ts", 50).Hits) != 1 {
		t.Fatal("refresh 后应包含新文件")
	}

	if err := os.Remove(added); err != nil {
		t.Fatal(err)
	}
	fx.indexer.Index()
	if len(fx.names("old.ts", 50).Hits) != 0 {
		t.Fatal("refresh 后应移除已删除文件")
	}
	if got := fx.firstPath(fx.names("new.ts", 50)); got != newFile {
		t.Fatalf("新文件路径应保持一致，got %s", got)
	}
}

func TestOpenIndexerRejectsUnusableRoots(t *testing.T) {
	if _, err := OpenIndexer([]string{filepath.Join(t.TempDir(), "missing")}); err == nil {
		t.Fatal("不存在的根必须报错（宿主据此降级）")
	}
	if _, err := OpenIndexer(nil); err == nil {
		t.Fatal("空根集合必须报错")
	}
}
