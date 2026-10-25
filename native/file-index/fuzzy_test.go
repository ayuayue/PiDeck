package main

import (
	"strings"
	"testing"
)

func TestFoldASCIIOnlyTouchesASCII(t *testing.T) {
	if got := foldASCII("AbC中文"); got != "abc中文" {
		t.Fatalf("got %q", got)
	}
	// 无大写字母时原样返回（零分配路径）
	original := "abc中文"
	if got := foldASCII(original); got != original {
		t.Fatalf("got %q", got)
	}
}

func TestSubsequenceScorePrefersContiguousAndBoundaryStarts(t *testing.T) {
	contiguous, ok := subsequenceScore("workspacesurface.tsx", "surface", scoreNameFuzzy)
	if !ok {
		t.Fatal("连续子串必须命中")
	}
	scattered, ok := subsequenceScore("s_u_r_f_a_c_e_helper.tsx", "surface", scoreNameFuzzy)
	if !ok {
		t.Fatal("散落子序列也必须命中（fzf 语义）")
	}
	// 被分隔符撕开的子序列不得压过连续命中（首字符边界加成只给一次）
	if separated, _ := subsequenceScore("prefix_s_u_r_f_a_c_e", "surface", scoreNameFuzzy); separated >= contiguous {
		t.Fatalf("分隔符子序列(%d)不应高于连续命中(%d)", separated, contiguous)
	}
	if contiguous <= scattered {
		t.Fatalf("连续命中(%d)应高于散落命中(%d)", contiguous, scattered)
	}
}

func TestSubsequenceScoreRejectsMissingCharacter(t *testing.T) {
	if _, ok := subsequenceScore("main.go", "mangox", scoreNameFuzzy); ok {
		t.Fatal("缺字符不应命中")
	}
}

func TestFuzzyScoreLevelsAndDirectoryPenalty(t *testing.T) {
	exact, _ := fuzzyScore("index.ts", "src/index.ts", "index.ts", false)
	has, _ := fuzzyScore("index.tsx", "src/index.tsx", "index.ts", false)
	fuzzy, _ := fuzzyScore("indentx.ts", "src/indentx.ts", "index.ts", false)
	if !(exact > has && has > fuzzy) {
		t.Fatalf("分级错误：exact=%d has=%d fuzzy=%d", exact, has, fuzzy)
	}
	// 排在同分的文件后面：目录减 1 分
	fileScore, _ := fuzzyScore("utils", "utils", "utils", false)
	dirScore, _ := fuzzyScore("utils", "utils", "utils", true)
	if fileScore != dirScore+1 {
		t.Fatalf("目录应比同分文件低 1：file=%d dir=%d", fileScore, dirScore)
	}
}

func TestScoreStringPositionPenalty(t *testing.T) {
	early, _ := scoreString("alphabet.ts", "alpha", scoreNameExact, scoreNameHas, scoreNameFuzzy)
	late, _ := scoreString("xxalphabet.ts", "alpha", scoreNameExact, scoreNameHas, scoreNameFuzzy)
	if early <= late {
		t.Fatalf("靠前命中应更高：early=%d late=%d", early, late)
	}
}

func TestPrepareQuerySplitsTermsAndFoldsASCII(t *testing.T) {
	prepared := prepareQuery("  SnapShot\tloader　状态  ")
	if len(prepared.terms) != 3 {
		t.Fatalf("词元数错误：%d %q", len(prepared.terms), prepared.terms)
	}
	if !prepared.fold {
		t.Fatal("含 ASCII 字母应折叠大小写")
	}
	if string(prepared.terms[0]) != "snapshot" || string(prepared.terms[1]) != "loader" {
		t.Fatalf("词元折叠错误：%q %q", prepared.terms[0], prepared.terms[1])
	}
	// 多词时不是整句语义
	if prepared.phrase != nil {
		t.Fatalf("多词不应带整句，got %q", prepared.phrase)
	}
	// 单词 = 整句（加成）
	single := prepareQuery("连接池")
	if string(single.phrase) != "连接池" || single.fold {
		t.Fatalf("单词应按整句且不折叠 CJK：%q fold=%v", single.phrase, single.fold)
	}
	// 词元过多（>16）按整句处理
	many := strings.TrimSpace(strings.Repeat("w ", maxQueryTerms+1))
	long := prepareQuery(many)
	if long.phrase == nil {
		t.Fatal("超过词元上限必须退化为整句")
	}
	if empty := prepareQuery("   "); len(empty.terms) != 0 {
		t.Fatalf("空查询不应有词元，got %+v", empty.terms)
	}
}

func TestMatchLineRequiresAllTerms(t *testing.T) {
	prepared := prepareQuery("连接池 超时")
	if _, _, ok := prepared.matchLine("只有连接池"); ok {
		t.Fatal("缺一个词不应命中")
	}
	if _, _, ok := prepared.matchLine("超时重试"); ok {
		t.Fatal("缺一个词不应命中")
	}
	if _, _, ok := prepared.matchLine("连接池超时一起调"); !ok {
		t.Fatal("同词都出现应命中（顺序无关）")
	}
	column, score, ok := prepared.matchLine("前缀连接池超时")
	if !ok || column != len("前缀") {
		t.Fatalf("命中位置应该是首词元的位置，got column=%d ok=%v", column, ok)
	}
	if score <= contentLineBase-len("前缀") {
		t.Fatalf("紧凑的多词命中应有跨度加成，got %d", score)
	}
}
