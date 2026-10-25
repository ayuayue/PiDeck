// 生成渲染层拼音表（src/renderer/src/utils/pinyinTable.ts）。
//
// 为什么用 Go 生成：file-index sidecar 已用 go-pinyin 做文件名拼音，渲染层的
// 「搜索会话」是本地过滤、拿不到 sidecar 索引；如果渲染层另引一个 JS 拼音库，
// 同一个字会出现两套读音（"cq" 在一个入口命中、另一个不命中）。所以渲染层的表
// 从同一本字典抽出来：生成物入库，测试钉住关键映射，改字典版本必须重新生成。
//
// 输出格式（两个常量，按序一一对应）：
//
//	PINYIN_CHARS   —— 每个字符是一个有读音的汉字；
//	PINYIN_ENTRIES —— 按换行切分后与 PINYIN_CHARS 同序，每项是
//	                  「首字母集合 + 制表符 + 默认全拼」，集合按字典序、含异读。
//
// 用法：go run . > 目标文件（由 scripts/gen-pinyin-table.mjs 调用）。
package main

import (
	"bufio"
	"fmt"
	"os"
	"sort"
	"strings"
	"unicode"

	"github.com/mozillazg/go-pinyin"
)

// 覆盖区段：扩展 A（U+3400–U+4DBF）与基本区（U+4E00–U+9FFF）。
// 再往上（扩展 B+）都是生僻字，进包只涨体积不涨命中；没有读音的字直接跳过。
var ranges = [][2]rune{
	{0x3400, 0x4DBF},
	{0x4E00, 0x9FFF},
}

func main() {
	args := pinyin.NewArgs()
	args.Style = pinyin.Normal
	args.Heteronym = true

	var chars strings.Builder
	var entries strings.Builder
	count := 0
	for _, span := range ranges {
		for r := span[0]; r <= span[1]; r++ {
			if !unicode.Is(unicode.Han, r) {
				continue
			}
			groups := pinyin.Pinyin(string(r), args)
			if len(groups) == 0 || len(groups[0]) == 0 {
				continue
			}
			letters := make([]byte, 0, len(groups[0]))
			seen := map[byte]bool{}
			first := ""
			for _, reading := range groups[0] {
				if reading == "" {
					continue
				}
				lower := strings.ToLower(reading)
				if !isASCIILetters(lower) {
					continue
				}
				if first == "" {
					first = lower
				}
				if c := lower[0]; !seen[c] {
					seen[c] = true
					letters = append(letters, c)
				}
			}
			if len(letters) == 0 || first == "" {
				continue
			}
			// 字母集合排序后输出：同一字典重复生成逐字节一致，diff 才干净。
			sort.Slice(letters, func(i, j int) bool { return letters[i] < letters[j] })
			chars.WriteRune(r)
			if count > 0 {
				entries.WriteByte('\n')
			}
			entries.Write(letters)
			entries.WriteByte('\t')
			entries.WriteString(first)
			count++
		}
	}

	out := bufio.NewWriter(os.Stdout)
	defer func() {
		if err := out.Flush(); err != nil {
			fmt.Fprintf(os.Stderr, "flush failed: %v\n", err)
			os.Exit(1)
		}
	}()
	writeLine(out, "// 生成物，禁止手改：由 native/tools/pinyin-table 从 go-pinyin 字典生成。\n")
	writeLine(out, "// 重新生成：npm run gen:pinyin-table（改字典版本后必须跑，测试会校验关键映射）。\n")
	writeLine(out, "// PINYIN_CHARS 的每个字符与 PINYIN_ENTRIES 的每一项一一对应（按换行切分）。\n")
	writeLine(out, "// 每项格式为「首字母集合 + 制表符 + 默认全拼」，集合按字典序、含异读（重 → czt 与 zhong）。\n")
	fmt.Fprintf(out, "// 条目数：%d\n", count)
	fmt.Fprintf(out, "export const PINYIN_CHARS =\n\t%q;\n", chars.String())
	fmt.Fprintf(out, "export const PINYIN_ENTRIES =\n\t%q;\n", entries.String())
}

func writeLine(out *bufio.Writer, line string) {
	out.WriteString(line)
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
