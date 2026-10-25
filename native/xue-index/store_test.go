// Store 语义回归测试：与 TS 侧 tests/xuePromptSearch.test.mjs、
// tests/xuePromptOverlay.test.mjs 的断言互为镜像——两侧任何一方语义漂移，
// 另一侧的等价测试会先红。
//
// fixture 在临时目录自建（同 schema + gzip BLOB + 旧版未压缩数据），不依赖
// 真实 resources/xueprompts.db，保证 go test 可离线、确定性运行。
package main

import (
	"bytes"
	"compress/gzip"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
)

func gzipBytes(t *testing.T, text string) []byte {
	t.Helper()
	var buf bytes.Buffer
	writer := gzip.NewWriter(&buf)
	if _, err := writer.Write([]byte(text)); err != nil {
		t.Fatalf("gzip write: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("gzip close: %v", err)
	}
	return buf.Bytes()
}

// createFixtureDb 建一个与生产同 schema 的最小库：
// 分类：编程提示词(biancheng,2)、写作助手(xiezuo,1)、空分类(empty-cat,0)
// 条目（按 category,title 字节序的期望顺序）：
//   writer         写作助手  Git 写作      正文含 "GIT workflow"
//   legacy         写作助手  旧数据        未压缩正文（旧版数据回退路径）
//   fix            编程提示词 修复问题      描述含 "调试并修复问题"
//   skill-discipline 编程提示词 技能纪律    正文含独特关键词 "柑橘忍者"
func createFixtureDb(t *testing.T) string {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "fixture.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	defer db.Close()
	statements := []string{
		`CREATE TABLE xueprompt_categories (
			slug TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			count INTEGER NOT NULL DEFAULT 0
		)`,
		`CREATE TABLE xueprompts (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			slug TEXT UNIQUE NOT NULL,
			url TEXT NOT NULL DEFAULT '',
			title TEXT NOT NULL,
			category TEXT NOT NULL DEFAULT '',
			content BLOB NOT NULL DEFAULT '',
			description BLOB NOT NULL DEFAULT ''
		)`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatalf("create schema: %v", err)
		}
	}
	categories := []struct {
		slug  string
		name  string
		count int
	}{{"xiezuo", "写作助手", 1}, {"biancheng", "编程提示词", 2}, {"empty-cat", "空分类", 0}}
	for _, c := range categories {
		if _, err := db.Exec("INSERT INTO xueprompt_categories (slug, name, count) VALUES (?, ?, ?)", c.slug, c.name, c.count); err != nil {
			t.Fatalf("insert category: %v", err)
		}
	}
	type row struct {
		slug, url, title, category, content, description string
		compress                                         bool
	}
	rows := []row{
		{"fix", "https://example.com/fix", "修复问题", "编程提示词", "帮我定位并修复问题，给出根因分析。", "调试并修复问题的专家", true},
		{"skill-discipline", "https://example.com/sd", "技能纪律", "编程提示词", "柑橘忍者只在正文里出现的独特关键词。", "保持技能边界的守则", true},
		{"writer", "https://example.com/writer", "Git 写作", "写作助手", "GIT workflow 与分支故事。", "用 git 讲故事", true},
		{"legacy", "", "旧数据", "写作助手", "未压缩正文占位词菠萝卜。", "旧版未压缩描述", false},
	}
	for _, r := range rows {
		content := r.content
		description := r.description
		if r.compress {
			content = string(gzipBytes(t, r.content))
			description = string(gzipBytes(t, r.description))
		}
		if _, err := db.Exec("INSERT INTO xueprompts (slug, url, title, category, content, description) VALUES (?, ?, ?, ?, ?, ?)", r.slug, r.url, r.title, r.category, []byte(content), []byte(description)); err != nil {
			t.Fatalf("insert prompt %s: %v", r.slug, err)
		}
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close fixture: %v", err)
	}
	return dbPath
}

func loadFixture(t *testing.T) *Store {
	t.Helper()
	store, err := LoadStore(createFixtureDb(t))
	if err != nil {
		t.Fatalf("LoadStore: %v", err)
	}
	return store
}

func intPtr(v int) *int { return &v }

func strPtr(v string) *string { return &v }

func slugsOf(result *ListResult) []string {
	out := make([]string, 0, len(result.Prompts))
	for _, p := range result.Prompts {
		out = append(out, p.Slug)
	}
	return out
}

func TestListFullNoParamsSortedOrder(t *testing.T) {
	store := loadFixture(t)
	result, err := store.List(ListParams{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	// 全量形态：不带 total/page/pageSize；序 = (category,title) 字节序（写 < 编）
	want := []string{"writer", "legacy", "fix", "skill-discipline"}
	got := slugsOf(result)
	if len(got) != 4 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] || got[3] != want[3] {
		t.Fatalf("全量序 = %v, want %v", got, want)
	}
	if result.Total != 0 || result.Page != 0 || result.PageSize != 0 {
		t.Fatalf("全量形态不应带分页字段: %+v", result)
	}
	if len(result.Categories) != 3 || result.Categories[0].Slug != "biancheng" || result.Categories[1].Slug != "xiezuo" || result.Categories[2].Slug != "empty-cat" {
		t.Fatalf("分类栏应按 count 降序: %+v", result.Categories)
	}
}

func TestSearchHitsGzipDescription(t *testing.T) {
	store := loadFixture(t)
	// 「调试并修复问题」只在 fix 的 description 里
	result, err := store.List(ListParams{Category: "编程提示词", Search: "调试并修复问题", Page: intPtr(1), PageSize: intPtr(20)})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if result.Total != 1 || len(result.Prompts) != 1 || result.Prompts[0].Slug != "fix" {
		t.Fatalf("描述搜索应只命中 fix: total=%d %v", result.Total, slugsOf(result))
	}
}

func TestSearchHitsGzipContent(t *testing.T) {
	store := loadFixture(t)
	result, err := store.List(ListParams{Search: "柑橘忍者"})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if result.Total != 1 || result.Prompts[0].Slug != "skill-discipline" {
		t.Fatalf("正文搜索应只命中 skill-discipline: %v", slugsOf(result))
	}
}

func TestSearchHitsLegacyUncompressedBlob(t *testing.T) {
	store := loadFixture(t)
	result, err := store.List(ListParams{Search: "菠萝卜"})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if result.Total != 1 || result.Prompts[0].Slug != "legacy" {
		t.Fatalf("旧版未压缩正文应可搜索: %v", slugsOf(result))
	}
}

func TestSearchCaseInsensitiveAndPaginationTotal(t *testing.T) {
	store := loadFixture(t)
	lower, err := store.List(ListParams{Search: "git", Page: intPtr(1), PageSize: intPtr(1)})
	if err != nil {
		t.Fatalf("List lower: %v", err)
	}
	upper, err := store.List(ListParams{Search: "GIT", Page: intPtr(1), PageSize: intPtr(1)})
	if err != nil {
		t.Fatalf("List upper: %v", err)
	}
	// git 命中：writer（title/desc/content 三处含 Git/GIT/git）；legacy 不含 → 仅 1 条。
	// TS 侧断言的本质是大小写一致 + 分页回显，具体条数随 fixture 变化。
	if lower.Total != 1 || upper.Total != 1 {
		t.Fatalf("大小写不敏感命中数应一致: lower=%d upper=%d", lower.Total, upper.Total)
	}
	if len(lower.Prompts) != 1 {
		t.Fatalf("pageSize=1 时单页只应有 1 条: %v", slugsOf(lower))
	}
	if lower.Page != 1 || lower.PageSize != 1 {
		t.Fatalf("分页回显错误: %+v", lower)
	}
}

func TestPaginationWithoutSearchUsesCategoryTotal(t *testing.T) {
	store := loadFixture(t)
	result, err := store.List(ListParams{Category: "biancheng", Page: intPtr(1), PageSize: intPtr(1)})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if result.Total != 2 || len(result.Prompts) != 1 || result.Prompts[0].Slug != "fix" {
		t.Fatalf("分类 slug 过滤 + 分页: total=%d %v", result.Total, slugsOf(result))
	}
	// 空分类（count=0）保留在分类栏
	found := false
	for _, c := range result.Categories {
		if c.Slug == "empty-cat" {
			found = true
		}
	}
	if !found {
		t.Fatalf("空分类应保留在分类栏: %+v", result.Categories)
	}
}

func TestPaginationClamp(t *testing.T) {
	store := loadFixture(t)
	result, err := store.List(ListParams{Page: intPtr(0), PageSize: intPtr(500)})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if result.Page != 1 || result.PageSize != 100 {
		t.Fatalf("页码/页大小钳制: page=%d pageSize=%d", result.Page, result.PageSize)
	}
}

func TestGet(t *testing.T) {
	store := loadFixture(t)
	doc := store.Get("fix")
	if doc == nil {
		t.Fatal("Get(fix) 未命中")
	}
	if doc.Title != "修复问题" || doc.Category != "编程提示词" || doc.Content == "" || doc.Description != "调试并修复问题的专家" || doc.URL != "https://example.com/fix" {
		t.Fatalf("Get 返回内容不对: %+v", doc)
	}
	if store.Get("nope") != nil {
		t.Fatal("Get 未命中应返回 nil")
	}
}

func TestOverlayOverrideFallsBackToDbFields(t *testing.T) {
	store := loadFixture(t)
	// 覆盖 fix，无 frontmatter：title/category/description 回退 db，正文用覆盖层
	result, err := store.List(ListParams{
		Page:     intPtr(1),
		PageSize: intPtr(50),
		Overlay:  []OverlayEntry{{Slug: "fix", Content: "覆盖层独有的新正文独角兽"}},
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var hit *PromptItem
	for i := range result.Prompts {
		if result.Prompts[i].Slug == "fix" {
			hit = &result.Prompts[i]
		}
	}
	if hit == nil {
		t.Fatal("覆盖同名条目应存在")
	}
	if hit.Title != "修复问题" || hit.Category != "编程提示词" || hit.Description != "调试并修复问题的专家" {
		t.Fatalf("缺省字段应回退 db: %+v", hit)
	}
	// 覆盖层正文参与搜索；无分页参数→全量形态 Total 恒 0，用条数断言
	searchResult, err := store.List(ListParams{Search: "独角兽", Overlay: []OverlayEntry{{Slug: "fix", Content: "覆盖层独有的新正文独角兽"}}})
	if err != nil {
		t.Fatalf("List search: %v", err)
	}
	if len(searchResult.Prompts) != 1 || searchResult.Prompts[0].Slug != "fix" {
		t.Fatalf("覆盖层正文应可搜索: %v", slugsOf(searchResult))
	}
	// db 原正文关键词「根因分析」被覆盖后不再命中 fix
	overridden, err := store.List(ListParams{Search: "根因分析", Overlay: []OverlayEntry{{Slug: "fix", Content: "覆盖层独有的新正文独角兽"}}})
	if err != nil {
		t.Fatalf("List overridden: %v", err)
	}
	if len(overridden.Prompts) != 0 {
		t.Fatalf("被覆盖的 db 正文不应再参与搜索: %v", slugsOf(overridden))
	}
}

func TestOverlayNewSlugDefaultsAndSearch(t *testing.T) {
	store := loadFixture(t)
	result, err := store.List(ListParams{
		Page:     intPtr(1),
		PageSize: intPtr(20),
		Category: "编程提示词",
		Search:   "全新模板",
		Overlay: []OverlayEntry{
			{Slug: "brand-new", Title: strPtr("全新模板"), Description: strPtr("远端新增的模板"), Content: "# 全新内容"},
		},
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if result.Total != 1 || len(result.Prompts) != 1 || result.Prompts[0].Slug != "brand-new" {
		t.Fatalf("新增 slug 应可被搜索命中: total=%d %v", result.Total, slugsOf(result))
	}
	if result.Prompts[0].Title != "全新模板" || result.Prompts[0].Category != "编程提示词" {
		t.Fatalf("新增条目默认分类应为编程提示词: %+v", result.Prompts[0])
	}
	// 搜索过滤后分类 count 重算：编程提示词 = 命中 1
	for _, c := range result.Categories {
		if c.Name == "编程提示词" && c.Count != 1 {
			t.Fatalf("搜索后分类 count 应按可见条数重算: %+v", c)
		}
	}
}

func TestOverlayNewCategorySlugDerivation(t *testing.T) {
	store := loadFixture(t)
	result, err := store.List(ListParams{
		Page:     intPtr(1),
		PageSize: intPtr(20),
		Overlay: []OverlayEntry{
			{Slug: "categorized", Category: strPtr("写作/助手 V2!"), Content: "正文"},
		},
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	var derived *CategoryItem
	for i := range result.Categories {
		if result.Categories[i].Name == "写作/助手 V2!" {
			derived = &result.Categories[i]
		}
	}
	if derived == nil {
		t.Fatalf("新分类应出现在分类栏: %+v", result.Categories)
	}
	// 与 TS slug 派生规则一致：非 \w/汉字 → '-'，折叠、去首尾、小写
	if derived.Slug != "写作-助手-v2" {
		t.Fatalf("slug 派生不符: %q", derived.Slug)
	}
	if derived.Count != 1 {
		t.Fatalf("新分类 count 应为 1: %+v", derived)
	}
}

func TestOverlayCategoryFilterUsesSlugAndName(t *testing.T) {
	store := loadFixture(t)
	overlay := []OverlayEntry{{Slug: "writer", Content: "覆盖后的正文"}}
	// 分类 slug 过滤：覆盖 writer（属写作助手）后仍按分类保留
	result, err := store.List(ListParams{Category: "xiezuo", Overlay: overlay})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	found := false
	for _, slug := range slugsOf(result) {
		if slug == "writer" {
			found = true
		}
	}
	if !found {
		t.Fatalf("覆盖条目应保留在原分类过滤结果里: %v", slugsOf(result))
	}
	// 新增条目默认分类「编程提示词」，在写作助手过滤下不可见
	newResult, err := store.List(ListParams{
		Category: "xiezuo",
		Overlay:  []OverlayEntry{{Slug: "fresh", Content: "正文"}},
	})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, slug := range slugsOf(newResult) {
		if slug == "fresh" {
			t.Fatal("默认分类为编程提示词的新增条目不应出现在写作助手分类下")
		}
	}
}

func TestOverlayEmptyEqualsPureDb(t *testing.T) {
	store := loadFixture(t)
	withEmptyOverlay, err := store.List(ListParams{Page: intPtr(1), PageSize: intPtr(2)})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	pure, err := store.List(ListParams{Page: intPtr(1), PageSize: intPtr(2)})
	if err != nil {
		t.Fatalf("List pure: %v", err)
	}
	if len(withEmptyOverlay.Prompts) != len(pure.Prompts) || withEmptyOverlay.Total != pure.Total {
		t.Fatalf("空 overlay 应与纯 db 一致: %+v vs %+v", withEmptyOverlay, pure)
	}
}

func TestLoadStorePathWithUriSpecialChars(t *testing.T) {
	// 路径里的 % ? # 在 sqlite URI 文件名里有语法含义（%HH 转义 / 参数分隔），
	// 不转义会打开错文件或直接报错；这里把 fixture 放进带特殊字符的目录验证
	fixture := createFixtureDb(t)
	weirdDir := filepath.Join(t.TempDir(), "prompts%3F#dir")
	if err := os.MkdirAll(weirdDir, 0o755); err != nil {
		t.Fatal(err)
	}
	blob, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	weirdPath := filepath.Join(weirdDir, "fixture.db")
	if err := os.WriteFile(weirdPath, blob, 0o644); err != nil {
		t.Fatal(err)
	}
	store, err := LoadStore(weirdPath)
	if err != nil {
		t.Fatalf("LoadStore(特殊字符路径): %v", err)
	}
	result, err := store.List(ListParams{})
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(result.Prompts) == 0 {
		t.Fatal("特殊字符路径下读到的条目为空")
	}
}

func TestLoadStoreMissingDb(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "absent.db")
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("前置条件失败: %v", err)
	}
	// sql.Open 是惰性的，LoadStore 内的首次 Query 才真正触盘，返回错误而非 panic
	if _, err := LoadStore(missing); err == nil {
		t.Fatal("缺失 db 应回报错误")
	}
}
