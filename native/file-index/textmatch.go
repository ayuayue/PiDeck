// 内容检索的查询预处理与行匹配。语义与 native/session-index 的多词 AND 保持
// 一致（每个词都要出现、顺序无关、整句连续命中加成），差别只在匹配粒度：
// 会话索引以「一条消息」为单位，文件内容以「一行」为单位——行号与片段才准确。
// 两处实现刻意分开：一个模块一件事，跨模块共用会逼着两个 sidecar 一起升级。
package main

import "strings"

const (
	// 词元上限：超过按整句处理（与宿主侧/会话索引同口径）
	maxQueryTerms = 16
	// 行内评分：整句连续命中加成（与 session-index 的 scorePhraseBonus 同值）
	contentPhraseBonus = 1000
	// 行首命中基准分；越靠后越低
	contentLineBase = 500
	// 词元分散在多行时的文件级兜底命中评分：低于任何行内命中，仅保证能搜到
	contentFileFallbackScore = 150
	// 行内词元最大跨度（字节）：越紧凑越相关，超出不再加成
	contentSpanWindow = 200
)

// contentQuery 是预处理后的查询：terms 为 AND 词元（可选 ASCII 折叠），
// phrase 仅在「单关键词或词元过多」时非空（整句语义）。
type contentQuery struct {
	terms  [][]byte
	phrase []byte
	fold   bool
}

// prepareQuery 与 session-index 的 matchTerms 前置逻辑同口径：
// 单词查询按整句（加成），多词按 AND；含 ASCII 字母则整体折叠大小写。
func prepareQuery(query string) contentQuery {
	trimmed := strings.TrimSpace(query)
	words := splitQueryTerms(trimmed)
	prepared := contentQuery{}
	if len(words) == 0 {
		return prepared
	}
	prepared.terms = make([][]byte, 0, len(words))
	for _, word := range words {
		prepared.terms = append(prepared.terms, []byte(word))
	}
	if len(words) == 1 || len(words) > maxQueryTerms {
		prepared.phrase = []byte(trimmed)
	}
	if containsASCIILetter(trimmed) {
		prepared.fold = true
		for i := range prepared.terms {
			prepared.terms[i] = []byte(foldASCII(string(prepared.terms[i])))
		}
		if prepared.phrase != nil {
			prepared.phrase = []byte(foldASCII(string(prepared.phrase)))
		}
	}
	return prepared
}

// splitQueryTerms：Unicode 空白分词（strings.Fields 覆盖全角空格 U+3000）。
func splitQueryTerms(query string) []string {
	return strings.Fields(query)
}

func containsASCIILetter(s string) bool {
	for i := 0; i < len(s); i++ {
		if c := s[i]; (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') {
			return true
		}
	}
	return false
}

// matchLine 判定一行是否命中：所有词元都必须出现（AND，顺序无关）。
// 返回首个词元的位置（片段锚点，字节偏移）与行内评分。
func (q contentQuery) matchLine(line string) (int, int, bool) {
	hay := line
	if q.fold {
		hay = foldASCII(line)
	}
	first := -1
	maxEnd := 0
	for _, term := range q.terms {
		idx := strings.Index(hay, string(term))
		if idx < 0 {
			return 0, 0, false
		}
		if first < 0 || idx < first {
			first = idx
		}
		if end := idx + len(term); end > maxEnd {
			maxEnd = end
		}
	}
	if first < 0 {
		return 0, 0, false
	}
	score := contentLineBase - minInt(first, 200)
	if span := maxEnd - first; span <= contentSpanWindow {
		score += contentSpanWindow - span
	}
	if q.phrase != nil && strings.Contains(hay, string(q.phrase)) {
		score += contentPhraseBonus
	}
	return first, score, true
}

// markTermsInLine 记录该行出现过的词元，并返回首词元在本行的位置
// （文件级兜底命中的片段锚点）。只用于行内 AND 未命中时，不多做分配。
func (q contentQuery) markTermsInLine(line string, seen []bool) (int, bool) {
	hay := line
	if q.fold {
		hay = foldASCII(line)
	}
	for i, term := range q.terms {
		if seen[i] {
			continue
		}
		if strings.Contains(hay, string(term)) {
			seen[i] = true
		}
	}
	firstColumn := strings.Index(hay, string(q.terms[0]))
	return firstColumn, firstColumn >= 0
}

// textExtensions 内容检索的候选扩展名白名单。只读「用户会想搜正文」的类型：
// 二进制（图片/压缩包/可执行/媒体）整类不读，既省 IO 也避免把乱码拼进片段。
var textExtensions = map[string]bool{
	".txt": true, ".text": true, ".md": true, ".markdown": true, ".mdx": true,
	".json": true, ".jsonc": true, ".jsonl": true, ".ndjson": true, ".csv": true, ".tsv": true,
	".js": true, ".jsx": true, ".mjs": true, ".cjs": true, ".ts": true, ".tsx": true, ".mts": true, ".cts": true,
	".css": true, ".scss": true, ".sass": true, ".less": true, ".html": true, ".htm": true, ".vue": true, ".svelte": true,
	".xml": true, ".svg": true, ".yaml": true, ".yml": true, ".toml": true, ".ini": true, ".cfg": true, ".conf": true,
	".properties": true, ".env": true, ".editorconfig": true, ".gitignore": true, ".dockerignore": true,
	".go": true, ".py": true, ".pyi": true, ".rb": true, ".rs": true, ".java": true, ".kt": true, ".kts": true,
	".c": true, ".h": true, ".cc": true, ".cpp": true, ".cxx": true, ".hpp": true, ".cs": true, ".php": true,
	".swift": true, ".m": true, ".mm": true, ".dart": true, ".lua": true, ".pl": true, ".r": true, ".jl": true,
	".sh": true, ".bash": true, ".zsh": true, ".fish": true, ".ps1": true, ".psm1": true, ".bat": true, ".cmd": true,
	".sql": true, ".graphql": true, ".proto": true, ".gradle": true, ".groovy": true, ".cmake": true, ".mk": true,
	".log": true, ".diff": true, ".patch": true, ".tex": true, ".rst": true, ".adoc": true,
}

// textFileNames 无扩展名的常见文本文件（扩展名白名单覆盖不到）。
var textFileNames = map[string]bool{
	"makefile": true, "dockerfile": true, "license": true, "licence": true, "notice": true,
	"readme": true, "changelog": true, "authors": true, "contributing": true,
	".gitignore": true, ".gitattributes": true, ".dockerignore": true, ".editorconfig": true,
	".npmrc": true, ".nvmrc": true, ".env": true, ".babelrc": true, ".eslintrc": true, ".prettierrc": true,
}
