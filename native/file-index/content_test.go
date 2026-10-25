package main

import (
	"os"
	"strings"
	"testing"
)

func TestSearchContentFindsLineAndSnippet(t *testing.T) {
	fx := newFixture(t)
	notes := fx.writeFile("docs/notes.md", "第一行：无关内容\n数据库连接池怎么配\n超时重试参数在这里\n数据库 超时 同一行\n")
	fx.boot()

	// 多词 AND：只有第 4 行同时含两个词 → 单条命中，行号与片段准确
	result := fx.content("数据库 超时", 50, 0, 0)
	if len(result.Hits) != 1 {
		t.Fatalf("行内 AND 应只命中同一行，got %+v", result.Hits)
	}
	hit := result.Hits[0]
	if hit.Path != notes || hit.Line != 4 {
		t.Fatalf("命中位置错误：%+v", hit)
	}
	if !strings.Contains(hit.Snippet, "数据库") || !strings.Contains(hit.Snippet, "超时") {
		t.Fatalf("片段应包含两个词元，got %q", hit.Snippet)
	}
	// 单词查询按整句（加成），且大小写不敏感
	if got := fx.content("数据库", 50, 0, 0); len(got.Hits) != 2 || !got.Hits[0].SnippetContains("数据库") {
		t.Fatalf("单词命中应为 2 行且首条相关，got %+v", got.Hits)
	}
}

func TestSearchContentFallsBackToFileLevelMatch(t *testing.T) {
	fx := newFixture(t)
	fx.writeFile("src/pool.go", "// 数据库连接池\n\n// 超时重试在这条注释里\n")
	fx.boot()

	// 两个词分处不同行：行内 AND 不命中，但要有一条文件级兜底（否则整文件搜不到）
	result := fx.content("数据库 超时", 50, 0, 0)
	if len(result.Hits) != 1 {
		t.Fatalf("词元散在多行应回退为文件级命中，got %+v", result.Hits)
	}
	if result.Hits[0].Line != 1 {
		t.Fatalf("兜底命中应锚在首词元所在行，got %d", result.Hits[0].Line)
	}
	// 只有一个词的文件仍然不命中（AND 语义不能被兜底放宽）
	fx.writeFile("src/only.go", "// 只有数据库\n")
	fx.indexer.Index()
	if got := fx.content("数据库 超时", 50, 0, 0); len(got.Hits) != 1 {
		t.Fatalf("缺词的问件不应命中，got %+v", got.Hits)
	}
}

// SnippetContains 是测试辅助：片段里是否含某词（大小写不敏感）。
func (h contentHit) SnippetContains(needle string) bool {
	return strings.Contains(strings.ToLower(h.Snippet), strings.ToLower(needle))
}

func TestSearchContentSkipsBinaryAndOversizeFiles(t *testing.T) {
	fx := newFixture(t)
	fx.writeFile("ok.txt", "关键字 abc\n")
	fx.writeFile("binary.txt", "关键字\x00\x01\x02 abc\n")
	fx.writeFile("big.txt", "关键字 abc\n"+strings.Repeat("x", 4096))
	fx.writeFile("image.png", "关键字 abc\n") // 不在白名单扩展名
	fx.boot()

	result := fx.content("关键字 abc", 50, 1024, 0)
	if len(result.Hits) != 1 || result.Hits[0].Name != "ok.txt" {
		t.Fatalf("只应有 ok.txt 命中，got %+v", result.Hits)
	}
	// 但超限文件单独放行时能命中（证明是尺寸上限拦下的，不是别的逻辑）
	if got := fx.content("关键字 abc", 50, 1<<20, 0); len(got.Hits) != 2 {
		t.Fatalf("放宽单文件上限后应多命中 big.txt，got %+v", got.Hits)
	}
}

func TestSearchContentRespectsScannedByteBudget(t *testing.T) {
	fx := newFixture(t)
	fx.writeFile("a.txt", "关键字 abc\n")
	fx.writeFile("b.txt", "关键字 abc\n")
	fx.boot()

	// 全局预算只够读一个文件：扫到上限即停并标记 truncated
	result := fx.content("关键字 abc", 50, 0, 12)
	if !result.Truncated || result.ScannedFiles != 1 {
		t.Fatalf("字节预算应截断扫描，got scanned=%d truncated=%v", result.ScannedFiles, result.Truncated)
	}
	if len(result.Hits) != 1 {
		t.Fatalf("预算内只应命中一个文件，got %+v", result.Hits)
	}
}

func TestSearchContentIgnoresIgnoredDirs(t *testing.T) {
	fx := newFixture(t)
	fx.writeFile("src/app.ts", "const marker = 1\n")
	fx.writeFile("node_modules/dep/index.js", "const marker = 1\n")
	fx.boot()

	result := fx.content("marker", 50, 0, 0)
	if len(result.Hits) != 1 || result.Hits[0].Name != "app.ts" {
		t.Fatalf("node_modules 不应被内容检索命中，got %+v", result.Hits)
	}
}

func TestSearchContentLimitTruncates(t *testing.T) {
	fx := newFixture(t)
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		fx.writeFile(name, "target line\n")
	}
	fx.boot()

	result := fx.content("target", 2, 0, 0)
	if len(result.Hits) != 2 || !result.Truncated {
		t.Fatalf("limit=2 应截断，got %d truncated=%v", len(result.Hits), result.Truncated)
	}
	if result.MatchedFiles != 3 {
		t.Fatalf("matchedFiles 应统计全部命中文件（未截断），got %d", result.MatchedFiles)
	}
}

func TestSearchContentEmptyQueryReturnsNothing(t *testing.T) {
	fx := newFixture(t)
	fx.writeFile("a.txt", "x\n")
	fx.boot()
	if result := fx.content("   ", 50, 0, 0); len(result.Hits) != 0 || result.ScannedFiles != 0 {
		t.Fatalf("空查询不应扫描，got %+v", result)
	}
}

func TestBuildSnippetTrimsAndMarksTruncation(t *testing.T) {
	long := strings.Repeat("前", 60) + "关键字" + strings.Repeat("后", 200)
	snippet := buildSnippet(long, len(strings.Repeat("前", 60)))
	if !strings.HasPrefix(snippet, "…") || !strings.HasSuffix(snippet, "…") {
		t.Fatalf("两侧被截断都要有省略号，got %q", snippet)
	}
	if !strings.Contains(snippet, "关键字") {
		t.Fatalf("片段必须包含命中词，got %q", snippet)
	}
	// 制表符/多空格折叠成单空格（源码行在结果列表里不该被空白挤爆）
	if got := buildSnippet("a\t\tb   c", 0); got != "a b c" {
		t.Fatalf("空白折叠失败，got %q", got)
	}
}

func TestSearchContentReportsScannedAccounting(t *testing.T) {
	fx := newFixture(t)
	fx.writeFile("a.txt", "hello\n")
	fx.writeFile("b.png", "hello\n")
	fx.boot()

	result := fx.content("hello", 50, 0, 0)
	if result.ScannedFiles != 1 {
		t.Fatalf("只应扫描白名单文件，got %d", result.ScannedFiles)
	}
	if result.ScannedBytes != int64(len("hello\n")) {
		t.Fatalf("扫描字节数应等于实际读取量，got %d", result.ScannedBytes)
	}
	if _, err := os.Stat(fx.root); err != nil {
		t.Fatal(err)
	}
}
