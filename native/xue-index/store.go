// Store：xueprompts.db 的内存检索层，语义与 TS 侧 XuePromptManager 的
// sql.js 实现逐位对齐（tests/xuePromptSearch.test.mjs 的行为是验收基准）。
//
// 对齐要点（改任何一处前先读 XuePromptManager.ts 对应注释）：
//   - 排序：SQLite BINARY collation = UTF-8 字节序；Go 的 string 比较即字节序。
//     扫描序（rowid）+ 稳定排序 = SQLite 排序器的实际输出（并列键保持扫描序）。
//   - BLOB 解压：gzip 失败回退原字节按 UTF-8 读（兼容旧版未压缩数据）。
//   - category 过滤：按分类名或分类 slug（slug 经 xueprompt_categories 映射到名）。
//   - overlay 合并：覆盖层条目优先，title/category/description 缺省回退 db 同名条目，
//     db 无同名条目时用默认值（title=slug、category=编程提示词、description=空）。
//   - 分类栏 count：按合并+过滤+搜索后的可见条数重算；未出现的分类保留 db count。
package main

import (
	"compress/gzip"
	"database/sql"
	"fmt"
	"io"
	"path/filepath"
	"sort"
	"strings"

	_ "modernc.org/sqlite"
)

// PromptItem 与 shared/types 的 YaoPromptItem 字段一一对应（宿主直接消费）。
type PromptItem struct {
	Slug        string   `json:"slug"`
	Title       string   `json:"title"`
	Category    string   `json:"category"`
	Subcategory string   `json:"subcategory"`
	Tags        []string `json:"tags"`
	Description string   `json:"description"`
	Path        string   `json:"path"`
}

// CategoryItem 与 YaoPromptCategory 对应（slug/name/count）。
type CategoryItem struct {
	Slug  string `json:"slug"`
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// ListResult 与 YaoPromptListResult 对应，repoPath 由宿主侧补（它才知道路径语义）。
type ListResult struct {
	Categories []CategoryItem `json:"categories"`
	Prompts    []PromptItem   `json:"prompts"`
	Total      int            `json:"total,omitempty"`
	Page       int            `json:"page,omitempty"`
	PageSize   int            `json:"pageSize,omitempty"`
}

// DetailDoc：get 指令返回的单条明文（宿主 detail 拼装 frontmatter 用）。
type DetailDoc struct {
	Slug        string `json:"slug"`
	URL         string `json:"url"`
	Title       string `json:"title"`
	Category    string `json:"category"`
	Content     string `json:"content"`
	Description string `json:"description"`
}

// OverlayEntry：宿主解析覆盖层 md 后随每次 list 请求下发（无状态，避免失效时序）。
// Title/Category/Description 用指针区分「未提供（回退 db）」与「显式空串」，
// 对齐 TS 的 `op.title ?? base` 语义（?? 只对 null/undefined 回退）。
type OverlayEntry struct {
	Slug        string  `json:"slug"`
	Title       *string `json:"title,omitempty"`
	Category    *string `json:"category,omitempty"`
	Description *string `json:"description,omitempty"`
	Content     string  `json:"content"`
}

// ListParams：宿主 list 指令参数（页码/页大小的钳制规则与 TS 一致）。
type ListParams struct {
	Category string         `json:"category"`
	Search   string         `json:"search"`
	Page     *int           `json:"page"`
	PageSize *int           `json:"pageSize"`
	Overlay  []OverlayEntry `json:"overlay"`
}

type doc struct {
	detail DetailDoc
	// 检索用小写副本（JS toLowerCase 的中文/ASCII 行为对本语料等价）
	lowerTitle string
	lowerDesc  string
	lowerText  string
}

type categoryRow struct {
	item  CategoryItem
	rowID int64
}

type Store struct {
	docs   []doc // 按 (category, title) 字节序稳定排序后的全量条目
	bySlug map[string]*doc
	// db 原始分类（rowid 序），overlay 路径下作为 mergeCategories 的底表
	dbCategories []categoryRow
}

// blobToString：gzip 解压，失败回退原字节 UTF-8（与 TS blobToString 同规则）。
func blobToString(blob []byte) string {
	if len(blob) == 0 {
		return ""
	}
	reader, err := gzip.NewReader(strings.NewReader(string(blob)))
	if err != nil {
		return string(blob)
	}
	decoded, readErr := io.ReadAll(reader)
	if readErr != nil {
		return string(blob)
	}
	return string(decoded)
}

// escapeSqliteUriPath：把路径里对 sqlite URI 文件名有语法意义的字符转成 %HH。
// sqlite 打开 URI 时对 path 段做百分号解码，所以 % ? # 必须转义；其余字符
// （含 Windows 盘符冒号、空格、非 ASCII）原样保留——不做整体 url.PathEscape，
// 免得把本来就合法的路径写成另一种形态。宿主路径来自 userData，通常不含这些
// 字符，但任意合法路径都要能打开。
func escapeSqliteUriPath(path string) string {
	return strings.NewReplacer("%", "%25", "?", "%3F", "#", "%23").Replace(path)
}

// LoadStore 打开（只读）xueprompts.db，解压全部 BLOB 并建内存索引。
func LoadStore(dbPath string) (*Store, error) {
	abs, err := filepath.Abs(dbPath)
	if err != nil {
		return nil, err
	}
	// ro 防误写；宿主保证文件存在（打包随应用/开发仓内固定路径）
	db, err := sql.Open("sqlite", "file:"+escapeSqliteUriPath(filepath.ToSlash(abs))+"?mode=ro")
	if err != nil {
		return nil, err
	}
	defer db.Close()

	store := &Store{bySlug: make(map[string]*doc)}

	catRows, err := db.Query("SELECT rowid, slug, name, count FROM xueprompt_categories")
	if err != nil {
		return nil, fmt.Errorf("query categories: %w", err)
	}
	for catRows.Next() {
		var row categoryRow
		if err := catRows.Scan(&row.rowID, &row.item.Slug, &row.item.Name, &row.item.Count); err != nil {
			catRows.Close()
			return nil, fmt.Errorf("scan category: %w", err)
		}
		store.dbCategories = append(store.dbCategories, row)
	}
	catRows.Close()
	if err := catRows.Err(); err != nil {
		return nil, fmt.Errorf("iterate categories: %w", err)
	}
	// 与 SQL `ORDER BY count DESC` 对齐：稳定排序（并列保持 rowid 扫描序）
	sortedCats := append([]categoryRow(nil), store.dbCategories...)
	sort.SliceStable(sortedCats, func(i, j int) bool { return sortedCats[i].item.Count > sortedCats[j].item.Count })

	rows, err := db.Query("SELECT slug, url, title, category, content, description FROM xueprompts")
	if err != nil {
		return nil, fmt.Errorf("query prompts: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var slug, url, title, category string
		var contentBlob, descBlob []byte
		if err := rows.Scan(&slug, &url, &title, &category, &contentBlob, &descBlob); err != nil {
			return nil, fmt.Errorf("scan prompt: %w", err)
		}
		content := blobToString(contentBlob)
		description := blobToString(descBlob)
		store.docs = append(store.docs, doc{
			detail: DetailDoc{Slug: slug, URL: url, Title: title, Category: category, Content: content, Description: description},
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate prompts: %w", err)
	}
	// SQL `ORDER BY category, title`：Go string 比较即 UTF-8 字节序，与 SQLite
	// BINARY collation 一致；rows.Next() 的扫描序即 rowid 序（稳定排序的输入序）。
	sort.SliceStable(store.docs, func(i, j int) bool {
		if c := strings.Compare(store.docs[i].detail.Category, store.docs[j].detail.Category); c != 0 {
			return c < 0
		}
		return strings.Compare(store.docs[i].detail.Title, store.docs[j].detail.Title) < 0
	})
	// 排序完成后再取地址建映射 & 预计算小写副本
	for i := range store.docs {
		d := &store.docs[i]
		d.lowerTitle = strings.ToLower(d.detail.Title)
		d.lowerDesc = strings.ToLower(d.detail.Description)
		d.lowerText = strings.ToLower(d.detail.Content)
		store.bySlug[d.detail.Slug] = d
	}
	return store, nil
}

// Count 返回条目总数（ready 帧上报用）。
func (s *Store) Count() int { return len(s.docs) }

// Get 按 slug 取单条明文；未命中返回 nil。
func (s *Store) Get(slug string) *DetailDoc {
	if d := s.bySlug[slug]; d != nil {
		return &d.detail
	}
	return nil
}

// sortedCategories 返回 db 分类（count 降序、并列保持 rowid 序）。
func (s *Store) sortedCategories() []CategoryItem {
	result := make([]CategoryItem, 0, len(s.dbCategories))
	sorted := append([]categoryRow(nil), s.dbCategories...)
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].item.Count > sorted[j].item.Count })
	for _, row := range sorted {
		result = append(result, row.item)
	}
	return result
}

// matchCategory：db 条目的 category 过滤（分类名或分类 slug 宽容匹配，与 TS
// `category = ? OR category = (SELECT name ... WHERE slug = ?)` 等价）。
func (s *Store) matchCategory(category, filter string) bool {
	if category == filter {
		return true
	}
	for _, row := range s.dbCategories {
		if row.item.Slug == filter && row.item.Name == category {
			return true
		}
	}
	return false
}

func clampPagination(page, pageSize int) (int, int) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 1
	}
	if pageSize > 100 {
		pageSize = 100
	}
	return page, pageSize
}

// List：检索主入口。无 overlay 走纯 db 路径（对应 TS listFromDbOnly），
// 有 overlay 走合并路径（对应 TS list 的 overlay 分支）；两路的过滤/排序/分页
// 语义分别对齐 TS 实现。
func (s *Store) List(params ListParams) (*ListResult, error) {
	if len(params.Overlay) == 0 {
		return s.listFromDbOnly(params), nil
	}
	return s.listWithOverlay(params), nil
}

func itemOf(d *doc) PromptItem {
	return PromptItem{
		Slug: d.detail.Slug, Title: d.detail.Title, Category: d.detail.Category,
		Subcategory: "", Tags: []string{}, Description: d.detail.Description, Path: d.detail.Slug,
	}
}

func (s *Store) listFromDbOnly(params ListParams) *ListResult {
	categories := s.sortedCategories()
	needle := strings.ToLower(strings.TrimSpace(params.Search))

	// 纯全量（无分页参数）：返回全部条目，不带 total/page/pageSize（向后兼容形态）
	if params.Category == "" && needle == "" && params.Page == nil && params.PageSize == nil {
		prompts := make([]PromptItem, 0, len(s.docs))
		for i := range s.docs {
			prompts = append(prompts, itemOf(&s.docs[i]))
		}
		return &ListResult{Categories: categories, Prompts: prompts}
	}

	// category 粗筛 → 应用层明文匹配（title/description/content 任一命中）
	filtered := make([]*doc, 0, len(s.docs))
	for i := range s.docs {
		d := &s.docs[i]
		if params.Category != "" && !s.matchCategory(d.detail.Category, params.Category) {
			continue
		}
		filtered = append(filtered, d)
	}
	if needle != "" {
		matched := filtered[:0]
		for _, d := range filtered {
			if strings.Contains(d.lowerTitle, needle) || strings.Contains(d.lowerDesc, needle) || strings.Contains(d.lowerText, needle) {
				matched = append(matched, d)
			}
		}
		filtered = matched
	}

	page, pageSize := clampPagination(
		decodeInt(params.Page, 1),
		decodeInt(params.PageSize, 20),
	)
	total := len(filtered)
	offset := (page - 1) * pageSize
	end := offset + pageSize
	if end > total {
		end = total
	}
	prompts := make([]PromptItem, 0, max(end-offset, 0))
	for _, d := range filtered[offset:end] {
		prompts = append(prompts, itemOf(d))
	}
	return &ListResult{Categories: categories, Prompts: prompts, Total: total, Page: page, PageSize: pageSize}
}

// mergedEntry：overlay 与 db 合并后的条目（搜索走 title/description/生效正文）。
type mergedEntry struct {
	item       PromptItem
	overlayHit bool
	// 生效正文的小写副本（overlay 条目=覆盖层正文；db 条目=库内解压正文）
	lowerActiveText string
	lowerTitle      string
	lowerDesc       string
}

func decodeInt(value *int, fallback int) int {
	if value == nil {
		return fallback
	}
	return *value
}

func (s *Store) listWithOverlay(params ListParams) *ListResult {
	dbCategories := s.sortedCategories()
	needle := strings.ToLower(strings.TrimSpace(params.Search))

	// 第一步：db 条目按 category 粗筛（与 TS 在 SQL WHERE 里做的一致）
	filtered := make([]*doc, 0, len(s.docs))
	for i := range s.docs {
		d := &s.docs[i]
		if params.Category != "" && !s.matchCategory(d.detail.Category, params.Category) {
			continue
		}
		filtered = append(filtered, d)
	}

	// 第二步：合并 overlay——覆盖同名条目（保持 db 位置），新条目追加在后。
	// 与 TS Map 的行为一致：Map.set 已有 key 不改变插入位置，排序并列时次序稳定。
	entries := make([]mergedEntry, 0, len(filtered)+len(params.Overlay))
	overlayBySlug := make(map[string]OverlayEntry, len(params.Overlay))
	for _, op := range params.Overlay {
		overlayBySlug[op.Slug] = op
	}
	for _, d := range filtered {
		op, hit := overlayBySlug[d.detail.Slug]
		if !hit {
			entries = append(entries, mergedEntry{
				item: itemOf(d), lowerActiveText: d.lowerText, lowerTitle: d.lowerTitle, lowerDesc: d.lowerDesc,
			})
			continue
		}
		title := coalesce(op.Title, d.detail.Title)
		category := coalesce(op.Category, d.detail.Category)
		description := coalesce(op.Description, d.detail.Description)
		item := PromptItem{Slug: d.detail.Slug, Title: title, Category: category, Subcategory: "", Tags: []string{}, Description: description, Path: d.detail.Slug}
		lowerOverlay := strings.ToLower(op.Content)
		entries = append(entries, mergedEntry{
			item: item, overlayHit: true,
			lowerActiveText: lowerOverlay,
			lowerTitle:      strings.ToLower(title),
			lowerDesc:       strings.ToLower(description),
		})
	}
	// db 无同名条目的覆盖层模板：默认值兜底（title=slug、category=编程提示词）。
	// 判定基准是「过滤后的 db 条目集」而非全库：与 TS 一致——被 category 过滤掉的
	// db 同名条目不再作为兜底 base，覆盖层条目按新条目追加并落默认分类。
	filteredSlugs := make(map[string]bool, len(filtered))
	for _, d := range filtered {
		filteredSlugs[d.detail.Slug] = true
	}
	for _, op := range params.Overlay {
		if filteredSlugs[op.Slug] {
			continue // 已在上面覆盖 db 条目
		}
		title := coalesce(op.Title, op.Slug)
		category := coalesce(op.Category, "编程提示词")
		description := coalesce(op.Description, "")
		item := PromptItem{Slug: op.Slug, Title: title, Category: category, Subcategory: "", Tags: []string{}, Description: description, Path: op.Slug}
		entries = append(entries, mergedEntry{
			item: item, overlayHit: true,
			lowerActiveText: strings.ToLower(op.Content),
			lowerTitle:      strings.ToLower(title),
			lowerDesc:       strings.ToLower(description),
		})
	}

	// 第三步：应用层 category 复滤（overlay 新条目不经过 SQL，靠这一层兜住）
	if params.Category != "" {
		categoryName := params.Category
		for _, c := range dbCategories {
			if c.Slug == params.Category {
				categoryName = c.Name
				break
			}
		}
		kept := entries[:0]
		for _, e := range entries {
			if e.item.Category == categoryName || e.item.Category == params.Category {
				kept = append(kept, e)
			}
		}
		entries = kept
	}

	// 第四步：明文搜索（title/description/生效正文）
	if needle != "" {
		matched := entries[:0]
		for _, e := range entries {
			if strings.Contains(e.lowerTitle, needle) || strings.Contains(e.lowerDesc, needle) || strings.Contains(e.lowerActiveText, needle) {
				matched = append(matched, e)
			}
		}
		entries = matched
	}

	// 第五步：排序（category, title 字节序，稳定）——覆盖层改分类/标题后次序随之更新
	sort.SliceStable(entries, func(i, j int) bool {
		if c := strings.Compare(entries[i].item.Category, entries[j].item.Category); c != 0 {
			return c < 0
		}
		return strings.Compare(entries[i].item.Title, entries[j].item.Title) < 0
	})

	// 第六步：分类栏合并（count 按「合并+过滤+搜索后」的可见条数重算）
	mergedCategories := mergeCategories(dbCategories, entries)

	// 无分页参数：全量形态（与 TS `if (!opts)` 分支一致）
	if params.Page == nil && params.PageSize == nil {
		prompts := make([]PromptItem, 0, len(entries))
		for _, e := range entries {
			prompts = append(prompts, e.item)
		}
		return &ListResult{Categories: mergedCategories, Prompts: prompts}
	}

	page, pageSize := clampPagination(decodeInt(params.Page, 1), decodeInt(params.PageSize, 20))
	total := len(entries)
	offset := (page - 1) * pageSize
	end := offset + pageSize
	if end > total {
		end = total
	}
	prompts := make([]PromptItem, 0, max(end-offset, 0))
	for _, e := range entries[offset:end] {
		prompts = append(prompts, e.item)
	}
	return &ListResult{Categories: mergedCategories, Prompts: prompts, Total: total, Page: page, PageSize: pageSize}
}

func coalesce(value *string, fallback string) string {
	if value != nil {
		return *value
	}
	return fallback
}

// mergeCategories：db 分类保留全部（count 换成可见条数，没出现的保留 db count），
// 覆盖层引入的新分类追加并按名称派生 slug（与 TS mergeCategories 同规则），
// 整体按 count 降序稳定排序（并列时 db 分类在前、新分类按首次出现序）。
func mergeCategories(dbCategories []CategoryItem, entries []mergedEntry) []CategoryItem {
	countBy := make(map[string]int)
	var order []string
	for _, e := range entries {
		name := e.item.Category
		if _, exists := countBy[name]; !exists {
			order = append(order, name)
		}
		countBy[name]++
	}
	result := make([]CategoryItem, 0, len(dbCategories)+len(order))
	existing := make(map[string]bool, len(dbCategories))
	for _, c := range dbCategories {
		existing[c.Name] = true
		if count, ok := countBy[c.Name]; ok {
			result = append(result, CategoryItem{Slug: c.Slug, Name: c.Name, Count: count})
		} else {
			result = append(result, c)
		}
	}
	for _, name := range order {
		if existing[name] {
			continue
		}
		result = append(result, CategoryItem{Slug: categorySlugOf(name), Name: name, Count: countBy[name]})
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Count > result[j].Count })
	return result
}

// categorySlugOf：与 TS 的 slug 派生规则一致——
// 非 [A-Za-z0-9_ 汉字] 字符替换为 '-'，折叠连续 '-'，去首尾 '-'，小写。
func categorySlugOf(name string) string {
	var builder strings.Builder
	for _, r := range name {
		if isWordRune(r) || (r >= 0x4e00 && r <= 0x9fff) {
			builder.WriteRune(r)
		} else {
			builder.WriteByte('-')
		}
	}
	slug := builder.String()
	for strings.Contains(slug, "--") {
		slug = strings.ReplaceAll(slug, "--", "-")
	}
	slug = strings.Trim(slug, "-")
	return strings.ToLower(slug)
}

// isWordRune：JS \w = [A-Za-z0-9_]。
func isWordRune(r rune) bool {
	return (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_'
}
