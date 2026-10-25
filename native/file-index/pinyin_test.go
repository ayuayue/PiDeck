// 拼音/首字母通道的语义测试：索引期键的构造、查询分级、端到端排序。
package main

import "testing"

func TestPinyinKeysForChineseName(t *testing.T) {
	initials, full := pinyinKeys("用量查询.md")
	if initials != "y\x00l\x00cz\x00x" {
		t.Fatalf("initials = %q, want y\\x00l\\x00cz\\x00x", initials)
	}
	if full != "yongliangchaxun" {
		t.Fatalf("full = %q, want yongliangchaxun", full)
	}
	if groups := countGroups(initials); groups != 4 {
		t.Fatalf("countGroups = %d, want 4", groups)
	}
}

func TestPinyinKeysSkipNonHanRunes(t *testing.T) {
	// 非汉字不参与：ASCII 片段由 FoldedName 匹配负责，拼音键只反映汉字部分。
	if initials, full := pinyinKeys("README.md"); initials != "" || full != "" {
		t.Fatalf("ASCII 名字不该有拼音键：%q / %q", initials, full)
	}
	initials, full := pinyinKeys("a用b查.ts")
	if initials != "y\x00cz" {
		t.Fatalf("initials = %q, want y\\x00cz", initials)
	}
	if full != "yongcha" {
		t.Fatalf("full = %q, want yongcha", full)
	}
}

func TestIsPinyinQuery(t *testing.T) {
	cases := map[string]bool{
		"ylcx":                      true,
		"y":                         false, // 单字母噪声太大
		"y1":                        false,
		"main.go":                   false,
		"用量":                        false,
		"":                          false,
		"ylcxylcxylcxylcxylcxylcxx": false, // 25 > 24
	}
	for input, want := range cases {
		if got := isPinyinQuery(input); got != want {
			t.Fatalf("isPinyinQuery(%q) = %v, want %v", input, got, want)
		}
	}
}

func TestInitialsMatchKinds(t *testing.T) {
	// 用量查询 → y / l / c(z) / x
	const usage = "y\x00l\x00cz\x00x"
	cases := []struct {
		needle string
		kind   int
		ok     bool
	}{
		{"ylcx", pinyinMatchExact, true},
		{"ylc", pinyinMatchPrefix, true},
		{"yx", pinyinMatchSkip, true},  // 跳过「量」「查」
		{"lcx", pinyinMatchSkip, true}, // 跳过开头的「用」属跳字，不是前缀
		{"yly", 0, false},              // 第二个字给不出 y
		{"ylcxz", 0, false},            // 比汉字数还长
	}
	for _, tc := range cases {
		kind, ok := initialsMatch(usage, tc.needle)
		if ok != tc.ok || (ok && kind != tc.kind) {
			t.Fatalf("initialsMatch(%q) = (%d, %v), want (%d, %v)", tc.needle, kind, ok, tc.kind, tc.ok)
		}
	}
}

func TestInitialsMatchHeteronym(t *testing.T) {
	// 重庆：重 有 zhong/chong/tong 三个读音，首字母集合是 "zct"。
	const chongqing = "zct\x00q"
	for _, needle := range []string{"zq", "cq", "tq"} {
		if kind, ok := initialsMatch(chongqing, needle); !ok || kind != pinyinMatchExact {
			t.Fatalf("initialsMatch(%q) = (%d, %v), want exact", needle, kind, ok)
		}
	}
	if _, ok := initialsMatch(chongqing, "qq"); ok {
		t.Fatalf("「重庆」不该命中 qq")
	}
}

func TestPinyinNameScoreOrdering(t *testing.T) {
	const usage = "y\x00l\x00cz\x00x"
	const full = "yongliangchaxun"
	exact, _ := pinyinNameScore(usage, full, "ylcx")
	prefix, _ := pinyinNameScore(usage, full, "ylc")
	fullHit, _ := pinyinNameScore(usage, full, "yongliang")
	skip, _ := pinyinNameScore(usage, full, "yx")
	if !(exact > prefix && prefix > fullHit && fullHit > skip) {
		t.Fatalf("分数次序应为 exact > prefix > full > skip，实际 %d/%d/%d/%d", exact, prefix, fullHit, skip)
	}
	if _, ok := pinyinNameScore(usage, full, "nope"); ok {
		t.Fatalf("无关查询不该命中拼音通道")
	}
	if _, ok := pinyinNameScore("", "", "ylcx"); ok {
		t.Fatalf("没有拼音键的条目不该命中")
	}
}

func TestSearchNamesFindsChineseNamesByPinyin(t *testing.T) {
	fx := newFixture(t)
	usage := fx.writeFile("docs/用量查询.md", "usage\n")
	usageOther := fx.writeFile("docs/用法.md", "usage\n")
	query := fx.writeFile("docs/查询工具.md", "query\n")
	readme := fx.writeFile("docs/README.md", "readme\n")
	fx.boot()

	// 首字母整名 / 前缀 / 全拼 / 跳字 —— 都指向「用量查询.md」
	for _, q := range []string{"ylcx", "ylc", "yongliang", "yx"} {
		got := fx.firstPath(fx.names(q, 50))
		if got != usage {
			t.Fatalf("query %q 首条命中 = %s, want %s", q, got, usage)
		}
	}
	// 「查询工具」：cx 是前两字前缀
	if got := fx.firstPath(fx.names("cx", 50)); got != query {
		t.Fatalf("query cx 首条命中 = %s, want %s", got, query)
	}
	// 「用法」命中 yf（首字母前缀）与 yongfa（全拼）
	for _, q := range []string{"yf", "yongfa"} {
		if got := fx.firstPath(fx.names(q, 50)); got != usageOther {
			t.Fatalf("query %q 首条命中 = %s, want %s", q, got, usageOther)
		}
	}
	// ASCII 查询不受影响
	if got := fx.firstPath(fx.names("readme", 50)); got != readme {
		t.Fatalf("ASCII 查询被拼音通道影响：%s", got)
	}
}

func TestSearchNamesPinyinRanksBelowRealNameHit(t *testing.T) {
	fx := newFixture(t)
	literal := fx.writeFile("tools/ylcx.txt", "x\n")
	fx.writeFile("docs/用量查询.md", "usage\n")
	fx.boot()

	result := fx.names("ylcx", 50)
	if len(result.Hits) < 2 {
		t.Fatalf("expected 2 hits, got %d", len(result.Hits))
	}
	// 真名字命中（包含 800）必须排在拼音命中（700）前面
	if result.Hits[0].Path != literal {
		t.Fatalf("首条应为字面名字命中 %s，实际 %s（score %d）", literal, result.Hits[0].Path, result.Hits[0].Score)
	}
	if result.Hits[1].Score >= result.Hits[0].Score {
		t.Fatalf("拼音命中分数不该高于字面命中：%d vs %d", result.Hits[1].Score, result.Hits[0].Score)
	}
}

func TestSearchNamesChineseQueryStillMatchesText(t *testing.T) {
	fx := newFixture(t)
	want := fx.writeFile("docs/用量查询.md", "usage\n")
	fx.boot()

	// 中文查询走名称包含（拼音通道只在纯字母查询时启用）
	if got := fx.firstPath(fx.names("用量", 50)); got != want {
		t.Fatalf("中文查询首条命中 = %s, want %s", got, want)
	}
	// 带点的查询不是拼音查询，也不会误伤
	if got := fx.firstPath(fx.names("用量查询.md", 50)); got != want {
		t.Fatalf("完整文件名查询首条命中 = %s, want %s", got, want)
	}
}
