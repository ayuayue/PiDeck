// 文件名的模糊匹配打分。分级而非单一 contains：用户敲 "wsurf" 期望命中
// "WorkspaceSurface.tsx"（子序列），敲 "index.go" 期望精确的排最前。
package main

// foldASCII 只折叠 ASCII 大小写：CJK 不受大小写影响，用 strings.ToLower
// 走 Unicode 映射会引入例外规则（如 İ），与宿主侧/另一 sidecar 的行为不一致。
// 文件名以 ASCII 为主，够用且零分配（无大写字母时直接返回原串）。
func foldASCII(s string) string {
	needs := false
	for i := 0; i < len(s); i++ {
		if c := s[i]; c >= 'A' && c <= 'Z' {
			needs = true
			break
		}
	}
	if !needs {
		return s
	}
	buf := []byte(s)
	for i, c := range buf {
		if c >= 'A' && c <= 'Z' {
			buf[i] = c + 32
		}
	}
	return string(buf)
}

// 分级基准分（同一查询内排序用，绝对值无意义）：
const (
	scoreNameExact = 1000
	scoreNameHas   = 800
	scoreNameFuzzy = 600
	scorePathHas   = 400
	scorePathFuzzy = 250

	// 拼音通道（native/file-index/pinyin.go）：首字母整名对齐 > 首字母前缀 >
	// 全拼子串 > 跳字首字母。全落在名字通道内、路径通道（400/250）之上：
	// 拼音命中比「路径里凑巧出现的子序列」更接近用户意图，但弱于真名字命中。
	scoreNamePinyinExact  = 700
	scoreNamePinyinPrefix = 680
	scoreNamePinyinFull   = 640
	scoreNamePinyinSkip   = 560
)

// fuzzyScore 返回命中分数；needle 必须是已折叠的查询词。
// 名字命中一律优先于路径命中：搜 "main.go" 时 main.go 要排在
// "src/main/go/parser.ts" 这类路径恰好也包含该片段的文件前面。
func fuzzyScore(foldedName, relPath, needle string, isDir bool) (int, bool) {
	score, ok := scoreString(foldedName, needle, scoreNameExact, scoreNameHas, scoreNameFuzzy)
	if !ok {
		foldedPath := foldASCII(relPath)
		score, ok = scoreString(foldedPath, needle, scorePathHas, scorePathHas, scorePathFuzzy)
	}
	if !ok {
		return 0, false
	}
	// 目录在同分时让位于文件（同名时用户通常要找文件），不改变跨级排序
	if isDir {
		score--
	}
	return score, true
}

// scoreString 三级尝试：等值 → 包含（越靠前越高）→ 子序列。
func scoreString(hay, needle string, exact, has, fuzzy int) (int, bool) {
	if hay == needle {
		return exact, true
	}
	if idx := indexOfBytes(hay, needle); idx >= 0 {
		// 命中位置惩罚：排在名字开头的命中比结尾的更可能是目标
		penalty := idx
		if penalty > 160 {
			penalty = 160
		}
		return has - penalty, true
	}
	return subsequenceScore(hay, needle, fuzzy)
}

// subsequenceScore：needle 的字节按顺序出现在 hay 中即命中（fzf 语义）。
// 奖励连续命中（"surf" 打在 "Surface" 上）与词边界起点（-_. / 之后），
// 惩罚跳跃与过长的宿主串——否则长路径里随便凑出的子序列会压过精确命中。
func subsequenceScore(hay, needle string, base int) (int, bool) {
	if needle == "" {
		return 0, false
	}
	score := base
	cursor := 0
	lastHit := -2
	for ni := 0; ni < len(needle); ni++ {
		target := needle[ni]
		found := -1
		for ; cursor < len(hay); cursor++ {
			if hay[cursor] == target {
				found = cursor
				cursor++
				break
			}
		}
		if found < 0 {
			return 0, false
		}
		if found == lastHit+1 {
			score += 8
		} else if lastHit >= 0 {
			gap := found - lastHit - 1
			if gap > 12 {
				gap = 12
			}
			score -= gap
		}
		// 词边界加成只给首个命中字符：给每个字符都加会让 “s-u-r-f-a-c-e”
		// 这种被分隔符撕开的子序列反而压过真正的连续命中。
		if lastHit < 0 && (found == 0 || isBoundaryByte(hay[found-1])) {
			score += 6
		}
		lastHit = found
	}
	score -= minInt(len(hay)/8, 60)
	return score, true
}

func isBoundaryByte(b byte) bool {
	switch b {
	case '/', '\\', '-', '_', '.', ' ', ':':
		return true
	default:
		return false
	}
}

// indexOfBytes：needle 非空时的朴素子串查找（不引 strings 只为省一次调用）。
func indexOfBytes(hay, needle string) int {
	if needle == "" || len(needle) > len(hay) {
		return -1
	}
	limit := len(hay) - len(needle)
	for i := 0; i <= limit; i++ {
		if hay[i] == needle[0] && hay[i:i+len(needle)] == needle {
			return i
		}
	}
	return -1
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
