// pideck-file-index 的索引与检索核心：项目根的文件清单 + 模糊名字匹配 + 有界内容扫描。
//
// 为什么存在（对应「⑤ 工作区文件索引 + 内容搜索」）：现有文件搜索
// （src/main/fs/FileSystemService.ts::searchNames）是主进程里的实时 BFS——
// 8s 总超时、200 条上限、单目录超过 5000 项跳过该层，而且只匹配条目自己的名字
// （路径中任意一段命中不了）。大仓库里「越搜越慢」和「搜不到」都来自这些上限。
//
// 本进程把各项目根的清单常驻内存（名字查询毫秒级、无条数上限瓶颈），内容检索
// 在索引之上做有界实时扫描：只读文本类扩展名、单文件大小上限、全局扫描字节上限。
// 宿主侧任何失败都降级回原 BFS（fail-open，与 session-index / xue-index 同哲学）。
package main

import (
	"bufio"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	// 索引条目上限：40 万条已远超正常仓库规模（剔除忽略目录后），
	// 触顶即截断而不是把内存吃满。
	maxIndexEntries = 400_000
	// 目录递归深度上限：防 symlink 环/超深目录树（正常仓库 <20 层）。
	maxIndexDepth = 32
	// 单目录子项上限：与 FileSystemService.FILE_SEARCH_MAX_DIRECTORY_ENTRIES 同口径，
	// 超过只跳过这一层（不是放弃整次扫描），避免 node_modules 级巨型目录拖垮索引。
	maxDirEntries = 5000

	// 内容检索默认上限（宿主可覆盖）：单文件 1MiB、全局累计读取 64MiB。
	defaultContentFileBytes = 1 << 20
	defaultScannedBytes     = 64 << 20
	// 二进制探测窗口与单文件命中上限
	contentBinaryProbeBytes  = 8192
	contentMaxMatchesPerFile = 3
	// 片段窗口：以首个词元为锚点，左 24 / 右 160 rune
	snippetBeforeRunes = 24
	snippetAfterRunes  = 160
)

// ignoredNames 必须与 src/main/fs/FileSystemService.ts 的 ignoredNames 逐项一致：
// 索引路径与 BFS 兜底路径的可见文件集不同会让「同一次搜索偶发少结果」。
var ignoredNames = map[string]bool{
	".git":         true,
	"node_modules": true,
	"dist":         true,
	"build":        true,
	"target":       true,
	".next":        true,
	"coverage":     true,
	".venv":        true,
	"__pycache__":  true,
}

type fileEntry struct {
	AbsPath string
	RelPath string
	Name    string
	// FoldedName 在索引期算好：名字命中是绝大多数查询的终点点，
	// 每次查询对 40 万条现场折叠会白白分配几十 MB。
	FoldedName string
	// PinyinInitials/PinyinFull 同样在索引期算好（仅含汉字的条目非空）：
	// 首字母串按「每字一组候选首字母、NUL 分隔」（重 → "zct"），全拼取默认读音。
	PinyinInitials string
	PinyinFull     string
	IsDir          bool
}

type indexStats struct {
	Roots     int   `json:"rootCount"`
	Files     int   `json:"fileCount"`
	Dirs      int   `json:"dirCount"`
	IndexMs   int64 `json:"indexMs"`
	Truncated bool  `json:"truncated"`
}

type nameHit struct {
	Path         string `json:"path"`
	RelativePath string `json:"relativePath"`
	Name         string `json:"name"`
	Type         string `json:"type"`
	Score        int    `json:"score"`
}

type nameResult struct {
	Hits      []nameHit `json:"hits"`
	Indexed   int       `json:"indexed"`
	Truncated bool      `json:"truncated"`
}

type contentHit struct {
	Path         string `json:"path"`
	RelativePath string `json:"relativePath"`
	Name         string `json:"name"`
	Line         int    `json:"line"`
	Column       int    `json:"column"`
	Snippet      string `json:"snippet"`
	Score        int    `json:"score"`
}

type contentResult struct {
	Hits         []contentHit `json:"hits"`
	MatchedFiles int          `json:"matchedFiles"`
	ScannedFiles int          `json:"scannedFiles"`
	ScannedBytes int64        `json:"scannedBytes"`
	Truncated    bool         `json:"truncated"`
}

// Indexer 是常驻进程内唯一的状态容器：roots 固定（变更由宿主重启进程解决，
// 与 SessionIndexService 的 rootsKey 换进程同语义）。
type Indexer struct {
	mu      sync.RWMutex
	roots   []string
	entries []fileEntry
	stats   indexStats
}

// OpenIndexer 只接受真实存在的目录根：不可用的根直接剔除（WSL/网络盘由宿主
// 侧提前过滤），一个都不剩则报错退出，宿主降级回 BFS。
func OpenIndexer(roots []string) (*Indexer, error) {
	clean := make([]string, 0, len(roots))
	seen := make(map[string]bool, len(roots))
	for _, root := range roots {
		abs, err := filepath.Abs(strings.TrimSpace(root))
		if err != nil || abs == "" {
			continue
		}
		abs = filepath.Clean(abs)
		if seen[abs] {
			continue
		}
		info, err := os.Stat(abs)
		if err != nil || !info.IsDir() {
			continue
		}
		seen[abs] = true
		clean = append(clean, abs)
	}
	if len(clean) == 0 {
		return nil, os.ErrNotExist
	}
	return &Indexer{roots: clean}, nil
}

// Index 全量重扫（boot 与 refresh 共用）。不做增量：文件清单的增量判定需要
// 逐目录比对 mtime，而 NTFS 在深层新建文件时不会更新祖先目录 mtime——
// 靠 mtime 剪枝会漏新文件，对被搜索结果可信度是硬伤；Go 侧 readdir 走一轮
// 数万文件的成本在百毫秒级，直接全量更可靠。
func (ix *Indexer) Index() indexStats {
	started := time.Now()
	entries := make([]fileEntry, 0, 8192)
	truncated := false
	for _, root := range ix.roots {
		ix.walkRoot(root, &entries, &truncated)
		if len(entries) >= maxIndexEntries {
			truncated = true
			break
		}
	}
	entries = dedupeEntries(entries)
	files, dirs := 0, 0
	for _, entry := range entries {
		if entry.IsDir {
			dirs++
		} else {
			files++
		}
	}
	stats := indexStats{Roots: len(ix.roots), Files: files, Dirs: dirs, IndexMs: time.Since(started).Milliseconds(), Truncated: truncated}
	ix.mu.Lock()
	ix.entries = entries
	ix.stats = stats
	ix.mu.Unlock()
	return stats
}

func (ix *Indexer) Stats() indexStats {
	ix.mu.RLock()
	defer ix.mu.RUnlock()
	return ix.stats
}

// walkRoot 深度优先（显式栈，避免深目录递归爆栈）。同 BFS 兜底路径的语义：
// 忽略目录整棵跳过、非常规文件（symlink/设备）跳过、单目录过大只跳过该层。
func (ix *Indexer) walkRoot(root string, out *[]fileEntry, truncated *bool) {
	type frame struct {
		dir   string
		depth int
	}
	stack := []frame{{dir: root, depth: 0}}
	for len(stack) > 0 {
		current := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		children, err := os.ReadDir(current.dir)
		if err != nil {
			continue
		}
		if len(children) > maxDirEntries {
			continue
		}
		for _, child := range children {
			if len(*out) >= maxIndexEntries {
				*truncated = true
				return
			}
			name := child.Name()
			if ignoredNames[name] {
				continue
			}
			isDir := child.IsDir()
			if !isDir && !child.Type().IsRegular() {
				continue
			}
			absPath := filepath.Join(current.dir, name)
			relPath, relErr := filepath.Rel(root, absPath)
			if relErr != nil {
				continue
			}
			initials, full := pinyinKeys(name)
			*out = append(*out, fileEntry{
				AbsPath:        absPath,
				RelPath:        filepath.ToSlash(relPath),
				Name:           name,
				FoldedName:     foldASCII(name),
				PinyinInitials: initials,
				PinyinFull:     full,
				IsDir:          isDir,
			})
			if isDir && current.depth < maxIndexDepth {
				stack = append(stack, frame{dir: absPath, depth: current.depth + 1})
			}
		}
	}
}

// dedupeEntries：项目根互相嵌套时（/repo 与 /repo/sub 同时是项目）同一文件
// 会以不同 RelPath 出现两次，结果列表里重复行会让人误以为存在两个文件。
func dedupeEntries(entries []fileEntry) []fileEntry {
	if len(entries) < 2 {
		return entries
	}
	seen := make(map[string]int, len(entries))
	out := entries[:0]
	for _, entry := range entries {
		key := strings.ToLower(entry.AbsPath)
		if idx, ok := seen[key]; ok {
			// 保留相对路径更短的那条（更接近用户认知的项目根）
			if len(entry.RelPath) < len(out[idx].RelPath) {
				out[idx] = entry
			}
			continue
		}
		seen[key] = len(out)
		out = append(out, entry)
	}
	return out
}

// SearchNames 模糊名字检索：名字精确 > 名字包含 > 拼音（首字母/全拼）>
// 名字子序列 > 路径包含 > 路径子序列。
// 这与旧 BFS 的「名字包含」是超集（原来漏掉的路径段命中现在能搜到），
// 同时保留大小写不敏感语义（ASCII 折叠，与 session-index 同口径）。中文名字
// 额外支持拼音与首字母（"ylcx" → 用量查询.md），详见 pinyin.go 的语义说明。
func (ix *Indexer) SearchNames(query string, limit int) nameResult {
	needle := foldASCII(strings.TrimSpace(query))
	if needle == "" {
		return nameResult{}
	}
	// 拼音通道只对纯字母查询启用：含中文/点/下划线的查询交给名字与路径匹配。
	pinyinQuery := isPinyinQuery(needle)
	ix.mu.RLock()
	entries := ix.entries
	ix.mu.RUnlock()

	hits := make([]nameHit, 0, 64)
	for _, entry := range entries {
		score, ok := fuzzyScore(entry.FoldedName, entry.RelPath, needle, entry.IsDir)
		if pinyinQuery && entry.PinyinInitials != "" {
			// 与名字/路径命中取高者：路径命中（≤400）会被拼音名字命中（≥560）抬上来，
			// 真名字命中（≥600）仍然优先。
			if pinyinScore, hit := pinyinNameScore(entry.PinyinInitials, entry.PinyinFull, needle); hit && (!ok || pinyinScore > score) {
				score, ok = pinyinScore, true
			}
		}
		if !ok {
			continue
		}
		hits = append(hits, nameHit{
			Path:         entry.AbsPath,
			RelativePath: entry.RelPath,
			Name:         entry.Name,
			Type:         entryType(entry.IsDir),
			Score:        score,
		})
	}
	sortNameHits(hits)
	truncated := limit > 0 && len(hits) > limit
	if truncated {
		hits = hits[:limit]
	}
	return nameResult{Hits: hits, Indexed: len(entries), Truncated: truncated}
}

// sortNameHits：同分按路径更短优先（浅层文件更像用户要找的），再按字典序；
// 目录在同分时排后面（同名时用户通常找文件）。
func sortNameHits(hits []nameHit) {
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		leftDir := hits[i].Type == "directory"
		rightDir := hits[j].Type == "directory"
		if leftDir != rightDir {
			return !leftDir
		}
		if len(hits[i].RelativePath) != len(hits[j].RelativePath) {
			return len(hits[i].RelativePath) < len(hits[j].RelativePath)
		}
		return hits[i].RelativePath < hits[j].RelativePath
	})
}

func entryType(isDir bool) string {
	if isDir {
		return "directory"
	}
	return "file"
}

// SearchContent 内容检索：按行做多词 AND 匹配（与 session-index 的多词语义一致：
// 顺序无关、允许一句里跨词，但单行内判定——跨行不匹配是刻意取舍，行号/片段才准确）。
//
// 有界性（防止把整个仓库读进内存）：
//   - 只扫文本类扩展名/文件名白名单；
//   - 单文件 ≤ maxFileBytes（默认 1MiB），超过整文件跳过（截断读会给错片段）；
//   - 全局累计读取 ≤ maxScannedBytes（默认 64MiB），触顶即停并标记 truncated；
//   - 单文件最多 3 条命中，结果总数由 limit 截断。
func (ix *Indexer) SearchContent(query string, limit int, maxFileBytes, maxScannedBytes int64) contentResult {
	prepared := prepareQuery(query)
	if len(prepared.terms) == 0 {
		return contentResult{}
	}
	if maxFileBytes <= 0 {
		maxFileBytes = defaultContentFileBytes
	}
	if maxScannedBytes <= 0 {
		maxScannedBytes = defaultScannedBytes
	}
	ix.mu.RLock()
	entries := ix.entries
	ix.mu.RUnlock()

	result := contentResult{Hits: make([]contentHit, 0, 32)}
	matched := make(map[string]bool, 32)
	for _, entry := range entries {
		if entry.IsDir || !isTextCandidate(entry.Name) {
			continue
		}
		if result.ScannedBytes >= maxScannedBytes {
			result.Truncated = true
			break
		}
		info, err := os.Stat(entry.AbsPath)
		if err != nil || info.Size() <= 0 || info.Size() > maxFileBytes {
			continue
		}
		file, err := os.Open(entry.AbsPath)
		if err != nil {
			continue
		}
		hitCount := scanFileLines(file, entry, prepared, &result)
		_ = file.Close()
		result.ScannedFiles++
		result.ScannedBytes += info.Size()
		if hitCount > 0 {
			matched[entry.AbsPath] = true
		}
	}
	result.MatchedFiles = len(matched)
	sortContentHits(result.Hits)
	if limit > 0 && len(result.Hits) > limit {
		result.Hits = result.Hits[:limit]
		result.Truncated = true
	}
	return result
}

// scanFileLines 逐行扫描：一次性 stat 后已知大小上限，这里只需流式读。
// 二进制探测（首 8KiB 含 NUL）放在读到内容之后做，避免为一个判断多读一遍文件。
//
// 两段语义：行内 AND 命中（精确的行号/片段）优先；若没有任何一行同时含全部词元
// 但整个文件里词元都出现过（「记不全一句话」时词常散在多行），补一条低分的
// 文件级命中并锚在首词元所在行——否则多词查询会整文件搜不到。
func scanFileLines(file *os.File, entry fileEntry, prepared contentQuery, result *contentResult) int {
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), contentMaxLineBytes)
	lineNo := 0
	hits := 0
	probed := false
	seen := make([]bool, len(prepared.terms))
	fallbackLine := 0
	fallbackColumn := 0
	fallbackText := ""
	for scanner.Scan() {
		lineNo++
		raw := scanner.Bytes()
		if !probed {
			probed = true
			if bytesContainNUL(raw) {
				return 0
			}
		}
		line := string(raw)
		column, score, ok := prepared.matchLine(line)
		if !ok {
			if firstColumn, hasFirst := prepared.markTermsInLine(line, seen); hasFirst && fallbackLine == 0 {
				fallbackLine = lineNo
				fallbackColumn = firstColumn
				fallbackText = line
			}
			continue
		}
		hits++
		result.Hits = append(result.Hits, contentHit{
			Path:         entry.AbsPath,
			RelativePath: entry.RelPath,
			Name:         entry.Name,
			Line:         lineNo,
			Column:       column + 1,
			Snippet:      buildSnippet(line, column),
			Score:        score,
		})
		if hits >= contentMaxMatchesPerFile {
			break
		}
	}
	if hits == 0 && fallbackLine > 0 && allTermsSeen(seen) {
		result.Hits = append(result.Hits, contentHit{
			Path:         entry.AbsPath,
			RelativePath: entry.RelPath,
			Name:         entry.Name,
			Line:         fallbackLine,
			Column:       fallbackColumn + 1,
			Snippet:      buildSnippet(fallbackText, fallbackColumn),
			Score:        contentFileFallbackScore,
		})
		return 1
	}
	return hits
}

func allTermsSeen(seen []bool) bool {
	for _, ok := range seen {
		if !ok {
			return false
		}
	}
	return true
}

// sortContentHits：文件按最高分行内评分排（同一文件的几条相邻），再按路径。
func sortContentHits(hits []contentHit) {
	sort.SliceStable(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		if hits[i].Path != hits[j].Path {
			return hits[i].Path < hits[j].Path
		}
		return hits[i].Line < hits[j].Line
	})
}

// buildSnippet 以首个词元的起点为中心取片段（左侧 24 个 rune、右侧 160）。
// 折叠空白：源码行里的制表/多空格在结果列表里会把片段挤没。
func buildSnippet(line string, column int) string {
	if column < 0 {
		column = 0
	}
	if column > len(line) {
		column = len(line)
	}
	start := column
	for count := 0; start > 0 && count < snippetBeforeRunes; count++ {
		_, size := utf8.DecodeLastRuneInString(line[:start])
		start -= size
	}
	end := column
	for count := 0; end < len(line) && count < snippetAfterRunes; count++ {
		_, size := utf8.DecodeRuneInString(line[end:])
		end += size
	}
	snippet := strings.Join(strings.Fields(line[start:end]), " ")
	if start > 0 {
		snippet = "…" + snippet
	}
	if end < len(line) {
		snippet += "…"
	}
	return snippet
}

func bytesContainNUL(chunk []byte) bool {
	probe := chunk
	if len(probe) > contentBinaryProbeBytes {
		probe = probe[:contentBinaryProbeBytes]
	}
	for _, b := range probe {
		if b == 0 {
			return true
		}
	}
	return false
}

// isTextCandidate：扩展名白名单 + 少数无扩展名的常见文本文件。
func isTextCandidate(name string) bool {
	lower := foldASCII(name)
	if textExtensions[filepath.Ext(lower)] {
		return true
	}
	return textFileNames[lower]
}

// ContentMaxLineBytes 由 scanFileLines 用于 scanner 缓冲：单行超过 1MiB 的文件
// （压缩后的一行 JSON/打包产物）内容检索直接放弃，避免为一行分配巨量内存。
const contentMaxLineBytes = 1 << 20
