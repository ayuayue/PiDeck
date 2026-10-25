package main

import (
	"bytes"
	"runtime"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"
)

// ── 搜索：语料分片 + 并发 ReadAt 扫描 ─────────────────────────────────────
//
// 不建倒排索引（全量倒排 >1GB 堆内存，否决）——查询时把 entries 按语料
// offset 排序后均分为 N 片，每 worker 用 ReadAt 只读自己片的字节范围再
// bytes.Contains（页缓存命中时为 memcpy 速度；冷读走磁盘顺序 IO）。大小写
// 处理：query 纯 CJK/无 ASCII 字母时直接原文 contains（快路径，中文用户
// 常态）；含 ASCII 字母则每 entry ASCII-lower 到线程本地 buffer 再匹配。

type searchMatch struct {
	MessageId   string `json:"messageId"`
	Role        string `json:"role"`
	TimestampMs int64  `json:"timestampMs"`
	Snippet     string `json:"snippet"`
}

type searchSessionHits struct {
	FilePath    string        `json:"filePath"`
	UpdatedAtMs int64         `json:"updatedAtMs"`
	Matches     []searchMatch `json:"matches"`
	// 命中总数（未截断；matches 只保留评分最高的 perSession 条）
	HitCount int `json:"hitCount"`
	// 会话内最高命中评分：仅用于排序，不进线格式
	Score int `json:"-"`
}

type searchResult struct {
	Sessions         []searchSessionHits `json:"sessions"`
	TotalHitSessions int                 `json:"totalHitSessions"`
	Truncated        bool                `json:"truncated"`
}

const (
	snippetBeforeRunes = 48
	snippetAfterRunes  = 96
	snippetMaxBytes    = 512
)

// ── 查询词元与命中评分 ──────────────────────────────────────────────
//
// 用户常常记不全一句话（「只记得几个词」）：单词保持原样的子串语义，多词按 AND
// 处理——每个词都要出现，顺序无关、允许跨行/跨段落（正文里的换行不影响词元匹配，
// 只有 snippet 展示层把换行折叠成空格）。评分只用于同一查询内的排序：会话内先给
// 最相关的几条、会话之间按最高分排。
const (
	// 整句（原始查询去首尾空白）连续命中：搜一整句时，真正相关的是原句出现处
	scorePhraseBonus = 1000
	// 词元跨度（首词起点→末词终点，字节）越小越相关，最多 +200，每 24 字节扣 1 分
	scoreSpanBonus = 200
	scoreSpanDecay = 24
	// 词元数超过它就把整个查询当一句：贴一整句话进来时「连续出现」才是用户意图，
	// 同时避免病态长查询对每个 entry 做 N 次扫描（26 词以上视为整句）
	maxQueryTerms = 16
)

type hit struct {
	entryIdx        int
	hitOffsetInText int
	score           int
}

// splitQueryTerms：按空白拆词（strings.Fields 覆盖普通空格/制表/换行/全角空格）。
// 空查询返回 nil（调用方已挡空查询，这里只作兜底）。
func splitQueryTerms(query string) []string {
	return strings.Fields(query)
}

// matchTerms 在（已按需折叠大小写的）正文里做多词 AND 匹配。
//
// terms / phrase 必须与正文同源（都折叠或都不折叠）。term 取各自**首次**出现位置，
// 跨度取「首词起点→末词终点」——这是包含全部词元的窗口的近似（精确最小窗口要
// 枚举排列，收益不值），用于区分「几个词凑在一起」和「散落在消息两端」。
// 返回 snippet 锚点（整句命中用整句起点，否则用最早出现的词元）、评分、是否命中。
func matchTerms(hay []byte, terms [][]byte, phrase []byte) (at, score int, ok bool) {
	if len(terms) == 0 {
		return 0, 0, false
	}
	first, last := -1, -1
	for _, term := range terms {
		idx := bytes.Index(hay, term)
		if idx < 0 {
			return 0, 0, false
		}
		if first < 0 || idx < first {
			first = idx
		}
		if end := idx + len(term); end > last {
			last = end
		}
	}
	at = first
	score = scoreSpanBonus - (last-first)/scoreSpanDecay
	if score < 0 {
		score = 0
	}
	if len(phrase) > 0 {
		if p := bytes.Index(hay, phrase); p >= 0 {
			at = p
			score += scorePhraseBonus
		}
	}
	return at, score, true
}

// Search 跨会话检索（跨会话搜索面板）。
func (ix *Indexer) Search(query string, limit, perSession int) searchResult {
	return ix.search(query, limit, perSession, "")
}

// SearchInSession 只在一个会话文件里检索（会话内查找：Ctrl+Shift+F / 头部放大镜）。
//
// 与跨会话搜索共享全部匹配与评分逻辑，差异只有两点：
//   - 只扫目标文件的语料段（entries 先按 fileRef 过滤，不再读整库）；
//   - 命中按**文档顺序**（tsMs 升序）返回，因为会话内查找是「上一条/下一条」导航，
//     用户预期是时间线顺序而不是相关度顺序。
func (ix *Indexer) SearchInSession(query, sessionPath string, limit int) searchResult {
	if sessionPath == "" {
		return searchResult{Sessions: []searchSessionHits{}}
	}
	return ix.search(query, limit, limit, sessionPath)
}

func (ix *Indexer) search(query string, limit, perSession int, onlyPath string) searchResult {
	// 词元化：单词查询就是原来的子串匹配（评分恒定，于是排序退化为时间序）；
	// 多词要求全部出现，顺序无关、可跨行
	wordList := splitQueryTerms(query)
	if len(wordList) > maxQueryTerms {
		wordList = []string{strings.TrimSpace(query)}
	}
	if len(wordList) == 0 {
		return searchResult{Sessions: []searchSessionHits{}}
	}
	phraseText := strings.TrimSpace(query)
	asciiFold := containsASCIILetter([]byte(query))
	terms := make([][]byte, 0, len(wordList))
	for _, word := range wordList {
		terms = append(terms, []byte(word))
	}
	var phrase []byte
	// 单词查询没有「整句」与「词元」的区别，整句加分无意义（所有命中都一样）
	if len(wordList) > 1 {
		phrase = []byte(phraseText)
	}
	if asciiFold {
		lowered := make([][]byte, 0, len(terms))
		for _, term := range terms {
			lowered = append(lowered, asciiLowerTo(nil, term))
		}
		terms = lowered
		if phrase != nil {
			phrase = asciiLowerTo(nil, phrase)
		}
	}

	// 全程读锁：rescan/compact（写锁）等本搜索结束；corpusFile 的 ReadAt 与
	// 追加写并发安全（写侧只在写锁内推进 corpusSize，读侧只碰已发布 entry）。
	ix.mu.RLock()
	defer ix.mu.RUnlock()

	if ix.corpusFile == nil || len(ix.entries) == 0 {
		return searchResult{Sessions: []searchSessionHits{}}
	}
	entries := make([]entry, len(ix.entries))
	copy(entries, ix.entries)
	if onlyPath != "" {
		// 目标文件可能因大小写/分隔符差异与索引键不同（Windows 路径一律小写入索引），
		// 因此按小写比较；找不到就是没命中（未索引的会话不报错）。
		target := strings.ToLower(onlyPath)
		var fileID int32 = -1
		for _, fs := range ix.files {
			if strings.ToLower(fs.Path) == target {
				fileID = fs.FileId
				break
			}
		}
		if fileID < 0 {
			return searchResult{Sessions: []searchSessionHits{}}
		}
		filtered := entries[:0]
		for _, e := range entries {
			if e.fileRef == fileID {
				filtered = append(filtered, e)
			}
		}
		entries = filtered
		if len(entries) == 0 {
			return searchResult{Sessions: []searchSessionHits{}}
		}
	}
	sortEntriesByOffset(entries)
	corpus := ix.corpusFile

	// 均分 entries（offset 有序 → 每片对应连续语料段，worker 只 ReadAt 自己的段）
	workers := parallelWorkers()
	if workers > len(entries) {
		workers = len(entries)
	}
	if workers < 1 {
		workers = 1
	}
	chunk := (len(entries) + workers - 1) / workers
	type chunkHits struct {
		hits []hit
		text []byte // 片缓冲复用给 snippet 构建，避免二次读
	}
	results := make([]chunkHits, workers)
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		start, end := w*chunk, (w+1)*chunk
		if end > len(entries) {
			end = len(entries)
		}
		if start >= end {
			continue
		}
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			first := entries[start]
			last := entries[end-1]
			segStart := first.offset
			segLen := last.offset + int64(last.length) - segStart
			if segLen <= 0 {
				return
			}
			buf := make([]byte, segLen)
			if _, err := corpus.ReadAt(buf, segStart); err != nil {
				logf("read corpus segment failed: %v", err)
				return
			}
			var lowerBuf []byte
			var found []hit
			for i := start; i < end; i++ {
				e := &entries[i]
				text := buf[e.offset-segStart : e.offset-segStart+int64(e.length)]
				hay := text
				if asciiFold {
					lowerBuf = asciiLowerTo(lowerBuf[:0], text)
					hay = lowerBuf
				}
				at, score, matched := matchTerms(hay, terms, phrase)
				if matched {
					found = append(found, hit{entryIdx: i, hitOffsetInText: at, score: score})
				}
			}
			results[w] = chunkHits{hits: found, text: buf}
		}(w)
	}
	wg.Wait()

	// 片内命中收集；snippet 从片缓冲取（offset 归一化到 entry 内）
	type resolvedHit struct {
		e     *entry
		text  []byte // entry 正文（来自片缓冲）
		at    int
		score int
	}
	var all []resolvedHit
	for w := 0; w < workers; w++ {
		ch := results[w]
		for _, h := range ch.hits {
			e := &entries[h.entryIdx]
			segStart := entries[w*chunk].offset
			text := ch.text[e.offset-segStart : e.offset-segStart+int64(e.length)]
			all = append(all, resolvedHit{e: e, text: text, at: h.hitOffsetInText, score: h.score})
		}
	}

	// 聚合到会话：先按评分挑最相关的几条（snippet 只为入选项构建，避免为成千上万条
	// 命中都分配字符串），再按「最高分 → 最近活跃 → 路径」排会话。
	type sessionAgg struct {
		fs   *fileState
		hits []resolvedHit
	}
	fileById := make(map[int32]*fileState, len(ix.files))
	for _, fs := range ix.files {
		fileById[fs.FileId] = fs
	}
	aggByFile := make(map[int32]*sessionAgg)
	var order []int32
	for _, rh := range all {
		agg := aggByFile[rh.e.fileRef]
		if agg == nil {
			fs := fileById[rh.e.fileRef]
			if fs == nil {
				continue
			}
			agg = &sessionAgg{fs: fs}
			aggByFile[rh.e.fileRef] = agg
			order = append(order, rh.e.fileRef)
		}
		agg.hits = append(agg.hits, rh)
	}
	sessions := make([]searchSessionHits, 0, len(order))
	for _, fileRef := range order {
		agg := aggByFile[fileRef]
		sort.SliceStable(agg.hits, func(i, j int) bool {
			// 会话内查找按时间线顺序（导航语义）；跨会话仍按相关度挑最相关的几条
			if onlyPath != "" {
				return agg.hits[i].e.tsMs < agg.hits[j].e.tsMs
			}
			if agg.hits[i].score != agg.hits[j].score {
				return agg.hits[i].score > agg.hits[j].score
			}
			return agg.hits[i].e.tsMs < agg.hits[j].e.tsMs
		})
		keep := perSession
		if keep > len(agg.hits) {
			keep = len(agg.hits)
		}
		matches := make([]searchMatch, 0, keep)
		for _, rh := range agg.hits[:keep] {
			matches = append(matches, searchMatch{
				MessageId:   string(rh.e.msgId),
				Role:        roleName(rh.e.role),
				TimestampMs: rh.e.tsMs,
				Snippet:     buildSnippet(rh.text, rh.at),
			})
		}
		sessions = append(sessions, searchSessionHits{FilePath: agg.fs.Path, UpdatedAtMs: agg.fs.UpdatedAtMs, Matches: matches, HitCount: len(agg.hits), Score: agg.hits[0].score})
	}
	// 最相关的会话优先（同分比最近活跃，再按路径稳定排序）
	sort.SliceStable(sessions, func(i, j int) bool {
		if sessions[i].Score != sessions[j].Score {
			return sessions[i].Score > sessions[j].Score
		}
		if sessions[i].UpdatedAtMs != sessions[j].UpdatedAtMs {
			return sessions[i].UpdatedAtMs > sessions[j].UpdatedAtMs
		}
		return sessions[i].FilePath < sessions[j].FilePath
	})
	total := len(sessions)
	// 会话内查找的「截断」指命中条数被 perSession 截断（会话数恒为 1），
	// 跨会话仍是「会话数超过 limit」。
	if onlyPath != "" {
		truncated := total > 0 && sessions[0].HitCount > perSession
		return searchResult{Sessions: sessions, TotalHitSessions: total, Truncated: truncated}
	}
	truncated := total > limit
	if truncated {
		sessions = sessions[:limit]
	}
	return searchResult{Sessions: sessions, TotalHitSessions: total, Truncated: truncated}
}

// buildSnippet：命中处前 snippetBeforeRunes / 后 snippetAfterRunes 个 rune，
// clamp 到 entry 边界；换行折叠为空格（snippet 单行展示）。返回合法 UTF-8。
func buildSnippet(text []byte, at int) string {
	start := at - snippetMaxBytes
	if start < 0 {
		start = 0
	}
	end := at + snippetMaxBytes
	if end > len(text) {
		end = len(text)
	}
	for start > 0 && at-start < snippetMaxBytes && !isRuneStart(text[start]) {
		start--
	}
	for end < len(text) && end-at < snippetMaxBytes && !isRuneStart(text[end]) {
		end++
	}
	start = retreatRunes(text, start, at, snippetBeforeRunes)
	end = advanceRunes(text, end, at, snippetAfterRunes)

	raw := text[start:end]
	out := make([]byte, 0, len(raw))
	for i := 0; i < len(raw); {
		r, size := utf8.DecodeRune(raw[i:])
		if r == '\n' || r == '\r' || r == '\t' {
			out = append(out, ' ')
			i += size
			continue
		}
		out = append(out, raw[i:i+size]...)
		i += size
	}
	return string(out)
}

func isRuneStart(b byte) bool { return b&0xC0 != 0x80 }

func retreatRunes(text []byte, start, at, maxRunes int) int {
	count := 0
	for start > 0 && count < maxRunes {
		start--
		if isRuneStart(text[start]) {
			count++
		}
	}
	return start
}

func advanceRunes(text []byte, end, at, maxRunes int) int {
	count := 0
	for end < len(text) && count < maxRunes {
		_, size := utf8.DecodeRune(text[end:])
		if size == 0 {
			break
		}
		end += size
		count++
	}
	return end
}

func containsASCIILetter(q []byte) bool {
	for _, b := range q {
		if (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') {
			return true
		}
	}
	return false
}

// asciiLowerTo：只折叠 ASCII A-Z（中文等非 ASCII 字节不动，保语义）。
func asciiLowerTo(dst, src []byte) []byte {
	if cap(dst) < len(src) {
		dst = make([]byte, len(src))
	}
	dst = dst[:len(src)]
	for i, b := range src {
		if b >= 'A' && b <= 'Z' {
			dst[i] = b + 32
		} else {
			dst[i] = b
		}
	}
	return dst
}

func parallelWorkers() int {
	n := runtime.NumCPU()
	if n > 8 {
		n = 8
	}
	return n
}
