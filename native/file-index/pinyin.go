// 文件名/目录名的拼音检索：中文名字（"用量查询.md"）要能被 "ylcx"（首字母）、
// "ylc"（首字母前缀）、"yx"（跳字首字母）与 "yongliang"（全拼）搜到。
//
// 为什么放在索引期：名字命中是这个 sidecar 的主路径，40 万条目上每次查询现算
// 拼音会把查询从亚毫秒拖到几百毫秒；一次建索引算好（walkRoot 里），查询只做
// 字符串比对。这也是宿主侧 BFS 兜底（FileSystemService.searchNames）做不到的：
// 那边没有索引，每敲一个字都要重扫目录树。
//
// 语义与限制（都在测试里钉住）：
//   - 只对含汉字的条目预计算；纯 ASCII 名字走既有折叠匹配，不受影响。
//   - 首字母按「逐字读音集合」存（重 zhong/chong/tong → "zct"），因此 "cq" 与
//     "zq" 都能命中「重庆」——异读不漏，代价是每字最多几字节。
//   - 全拼只存库默认读音（"zhongqing"），异读全拼（"chongqing"）不命中；
//     全拼异读组合会指数膨胀，实测用户更常敲首字母，取舍写在这里。
//   - 查询必须是纯 ASCII 字母且长度 ≥2：中文/带点/带下划线的查询走名字/路径匹配，
//     避免把 "main.go" 这种真片段塞进拼音通道。
//   - 内容检索不参与拼音（那需要把整份语料拼音化，收益远小于成本）。
package main

import (
	"strings"
	"unicode"

	"github.com/mozillazg/go-pinyin"
)

// 读音集合内的字分隔符：文件名不能含 NUL，用它当分隔不会与名字冲突。
const pinyinGroupSep = '\x00'

// 库的参数是只读值类型，进程内复用一份（避免每次调用重建映射）。
var pinyinNormalArgs = func() pinyin.Args {
	args := pinyin.NewArgs()
	args.Style = pinyin.Normal
	args.Heteronym = true
	return args
}()

// maxPinyinQueryLen 给拼音通道设闸：首字母查询不会超过整名汉字数，24 足够覆盖
// 极长的中文文件名，超过一律按普通查询处理。
const maxPinyinQueryLen = 24

// hasHanRune 判断名字里是否有汉字：绝大多数文件是纯 ASCII，先做这个廉价判断
// 才值得去调带字典的库。
func hasHanRune(s string) bool {
	for _, r := range s {
		if unicode.Is(unicode.Han, r) {
			return true
		}
	}
	return false
}

// pinyinKeys 返回条目的首字母串与默认全拼串：
//   - 首字母：每个汉字一组「候选首字母」（去重、按库顺序），组间用 pinyinGroupSep 分隔，
//     例如「用量查询」→ "y\x00l\x00cz\x00x"（cha/zha/chai 三个读音去重后是 c、z）；
//   - 全拼：每个汉字取默认读音首选项拼接，例如 "yongliangchaxun"。
//
// 库的返回只覆盖汉字字符（非汉字不占位），所以两串都只反映汉字部分——ASCII 片段
// 由既有 FoldedName 匹配负责，两者互补。
func pinyinKeys(name string) (initials string, full string) {
	if !hasHanRune(name) {
		return "", ""
	}
	groups := pinyin.Pinyin(name, pinyinNormalArgs)
	if len(groups) == 0 {
		return "", ""
	}
	var ini strings.Builder
	var ful strings.Builder
	written := 0
	for _, group := range groups {
		var letters [26]bool
		groupLetters := 0
		firstReading := ""
		for _, reading := range group {
			if reading == "" {
				continue
			}
			lower := foldASCII(reading)
			// 库对查不到读音的字会原样返回该字，这里直接当没有读音处理：
			// 让它进首字母串会污染匹配，进全拼串会混入非字母。
			if !isASCIILetters(lower) {
				continue
			}
			if firstReading == "" {
				firstReading = lower
			}
			c := lower[0]
			if letters[c-'a'] {
				continue
			}
			letters[c-'a'] = true
			groupLetters++
		}
		if groupLetters == 0 {
			continue
		}
		if written > 0 {
			ini.WriteByte(pinyinGroupSep)
		}
		for i := 0; i < 26; i++ {
			if letters[i] {
				ini.WriteByte(byte('a' + i))
			}
		}
		if firstReading != "" {
			ful.WriteString(firstReading)
		}
		written++
	}
	return ini.String(), ful.String()
}

func isASCIILetters(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 'a' || c > 'z' {
			return false
		}
	}
	return true
}

// isPinyinQuery：纯 ASCII 小写字母、长度 2..maxPinyinQueryLen。
// 单字母查询会被几十万条首字母命中，噪声远大于价值。
func isPinyinQuery(needle string) bool {
	if len(needle) < 2 || len(needle) > maxPinyinQueryLen {
		return false
	}
	return isASCIILetters(needle)
}

// 首字母命中分级：整名逐字对齐 > 前缀逐字对齐 > 跳字子序列。
const (
	pinyinMatchExact  = 3
	pinyinMatchPrefix = 2
	pinyinMatchSkip   = 1
)

// initialsMatch 在首字母串上匹配查询，返回最严格的一种命中。
//
// 三种命中都要求「一个查询字母吃掉一个汉字」，区别只在是否允许跳字与是否吃掉整名：
//   - exact：查询长度 == 汉字数且每字都能给出对应首字母（"ylcx" → 用量查询，含异读）；
//   - prefix：查询只覆盖开头若干个汉字（"ylc" → 用量查询，用户边打边看）；
//   - skip：允许跨过中间的汉字（"yx" → 用量查询），召回优先、分数最低。
func initialsMatch(initials string, needle string) (int, bool) {
	if initials == "" || needle == "" {
		return 0, false
	}
	needleIndex := 0
	matchedGroups := 0
	skippedGroups := 0
	for pos := 0; pos < len(initials) && needleIndex < len(needle); {
		end := strings.IndexByte(initials[pos:], byte(pinyinGroupSep))
		var group string
		if end < 0 {
			group = initials[pos:]
			pos = len(initials)
		} else {
			group = initials[pos : pos+end]
			pos += end + 1
		}
		if strings.IndexByte(group, needle[needleIndex]) >= 0 {
			needleIndex++
			matchedGroups++
		} else {
			skippedGroups++
		}
	}
	if needleIndex < len(needle) {
		return 0, false
	}
	// 只要跨过了任何一个汉字就不是前缀命中（"lcx" 搜「用量查询」属跳字，不是开头匹配）。
	if skippedGroups > 0 {
		return pinyinMatchSkip, true
	}
	if matchedGroups == countGroups(initials) {
		return pinyinMatchExact, true
	}
	return pinyinMatchPrefix, true
}

// countGroups 数首字母串里的汉字组数（分隔符个数 + 1，空串为 0）。
func countGroups(initials string) int {
	if initials == "" {
		return 0
	}
	groups := 1
	for i := 0; i < len(initials); i++ {
		if initials[i] == pinyinGroupSep {
			groups++
		}
	}
	return groups
}

// pinyinNameScore 返回拼音通道的分数：先比首字母分级，再比全拼子串，取高者。
// 分数线刻意落在名字通道内（exact 1000 / has 800 / fuzzy 600）与路径通道
// （has 400 / fuzzy 250）之间偏上的位置：拼音命中比「路径里凑巧出现的子序列」
// 更可能是用户的意图，但不如真名字命中确定。
func pinyinNameScore(initials string, full string, needle string) (int, bool) {
	best := 0
	if kind, ok := initialsMatch(initials, needle); ok {
		switch kind {
		case pinyinMatchExact:
			best = scoreNamePinyinExact
		case pinyinMatchPrefix:
			best = scoreNamePinyinPrefix
		default:
			best = scoreNamePinyinSkip
		}
	}
	if full != "" && indexOfBytes(full, needle) >= 0 && scoreNamePinyinFull > best {
		best = scoreNamePinyinFull
	}
	if best == 0 {
		return 0, false
	}
	return best, true
}
