package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// userMsgMultiline：正文带换行的用户消息（fixture 的 quoteJSON 不转义换行，
// 带换行的正文会写出非法 JSONL 行），用 %q 正确转义，专门覆盖「词元跨行」场景。
func userMsgMultiline(id, text string) string {
	return fmt.Sprintf(`{"type":"message","id":%q,"timestamp":"2026-01-01T00:00:01.000Z","message":{"role":"user","content":%q}}`, id, text)
}

// ── 多词 AND 匹配与命中排序 ────────────────────────────────────────────
//
// 用户现场：「记不全一整句，只记得几个词」搜不到（旧实现整串 contains，
// 「数据库 超时」被当成带空格的连续子串，必然 0 命中）。这里锁定：
//   - 多词 = AND（都出现即可，顺序无关、允许跨行）；
//   - 整句连续命中排最前；会话之间按最高分排（同分比最近活跃）；
//   - perSession 截断保留最相关的几条，HitCount 报真实命中数。

func TestMultiTermMatchesWhenTermsAreApart(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("--t--a", userMsgMultiline("u1", "第一条：数据库连接池\n第二条：超时重试怎么调"))
	fx.writeSession("--t--b", userMsg("u2", "只有数据库连接池"))
	fx.boot()

	r := fx.indexer.Search("数据库 超时", 10, 5)
	if r.TotalHitSessions != 1 || len(r.Sessions) != 1 {
		t.Fatalf("多词命中应为 1 个会话，got %+v", r)
	}
	hit := r.Sessions[0]
	if len(hit.Matches) != 1 || hit.Matches[0].MessageId != "u1" {
		t.Fatalf("跨行两词应命中同一条消息 u1，got %+v", hit.Matches)
	}
	if hit.HitCount != 1 {
		t.Fatalf("hitCount=%d, want 1", hit.HitCount)
	}
	// 单词查询仍走原来的子串语义（两个会话都有「数据库连接池」）
	if got := fx.indexer.Search("数据库", 10, 5).TotalHitSessions; got != 2 {
		t.Fatalf("single-term hits=%d, want 2", got)
	}
}

func TestMultiTermRequiresEveryTerm(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("--t--a", userMsg("u1", "数据库连接池"))
	fx.boot()

	if got := fx.indexer.Search("数据库 不存在的词", 10, 5).TotalHitSessions; got != 0 {
		t.Fatalf("缺一个词就不该命中，got %d 个会话", got)
	}
}

func TestMultiTermIgnoresOrderAndASCIICase(t *testing.T) {
	fx := newFixture(t)
	fx.writeSession("--t--a", userMsg("u1", "SnapShot loader 状态检查"))
	fx.boot()

	if got := fx.indexer.Search("loader snapshot", 10, 5).TotalHitSessions; got != 1 {
		t.Fatalf("词序无关 + ASCII 大小写不敏感应命中，got %d", got)
	}
	// 全角空格同样分词
	if got := fx.indexer.Search("loader\u3000snapshot", 10, 5).TotalHitSessions; got != 1 {
		t.Fatalf("全角空格应作为分隔符，got %d", got)
	}
}

func TestPhraseMatchRanksFirstAndSnippetFollows(t *testing.T) {
	fx := newFixture(t)
	filler := strings.Repeat("填充内容", 300)
	short := strings.Repeat("填充", 4)
	// 同一会话三条命中：u2 是整句（最高分），u1 相距近，u3 相距很远（最低分）
	fx.writeSession("--t--a", userMsg("u1", "alpha"+short+"beta"), userMsg("u2", "alpha beta 连着写"), userMsg("u3", "alpha"+filler+"beta"))
	fx.boot()

	r := fx.indexer.Search("alpha beta", 10, 2)
	if r.TotalHitSessions != 1 {
		t.Fatalf("want 1 session, got %+v", r)
	}
	hit := r.Sessions[0]
	if hit.HitCount != 3 {
		t.Fatalf("hitCount=%d, want 3（真实命中数不被截断）", hit.HitCount)
	}
	if len(hit.Matches) != 2 {
		t.Fatalf("perSession=2 应截断到 2 条，got %d", len(hit.Matches))
	}
	if hit.Matches[0].MessageId != "u2" {
		t.Fatalf("整句连续命中必须排第一，got %+v", hit.Matches)
	}
	if hit.Matches[1].MessageId != "u1" {
		t.Fatalf("次位应是词元相距更近的那条，got %+v", hit.Matches)
	}
	if !strings.Contains(hit.Matches[0].Snippet, "alpha beta") {
		t.Fatalf("snippet 应围绕整句命中，got %q", hit.Matches[0].Snippet)
	}
}

func TestSessionRankingPrefersScoreOverRecency(t *testing.T) {
	fx := newFixture(t)
	old := fx.writeSession("--t--a", userMsg("u1", "连接池 超时"))
	spread := strings.Repeat("填充内容", 300)
	newer := fx.writeSession("--t--b", userMsg("u2", "连接池"+spread+"超时"))
	base := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(old, base, base); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(newer, base.Add(time.Hour), base.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fx.boot()

	// 旧会话整句命中（高分），新会话词元散落（低分）→ 高分优先于活跃时间
	r := fx.indexer.Search("连接池 超时", 10, 5)
	if len(r.Sessions) != 2 || r.Sessions[0].FilePath != old {
		t.Fatalf("整句命中的旧会话应排第一，got %+v", r.Sessions)
	}
}

func TestSessionRankingPrefersRecencyOnTie(t *testing.T) {
	fx := newFixture(t)
	old := fx.writeSession("--t--a", userMsg("u1", "连接池 超时一起调"))
	newer := fx.writeSession("--t--b", userMsg("u2", "连接池 超时另一次"))
	base := time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC)
	if err := os.Chtimes(old, base, base); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(newer, base.Add(time.Hour), base.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	fx.boot()

	// 两个会话都是整句命中（同分）→ 回到「最近活跃优先」
	r := fx.indexer.Search("连接池 超时", 10, 5)
	if len(r.Sessions) != 2 || r.Sessions[0].FilePath != newer {
		t.Fatalf("同分应最近活跃优先，got %+v", r.Sessions)
	}
}

func TestLongQueryFallsBackToPhrase(t *testing.T) {
	fx := newFixture(t)
	words := make([]string, 0, 17)
	for i := 0; i < 17; i++ {
		words = append(words, "w"+string(rune('a'+i)))
	}
	joined := strings.Join(words, " ")
	shuffled := append([]string{}, words...)
	for i, j := 0, len(shuffled)-1; i < j; i, j = i+1, j-1 {
		shuffled[i], shuffled[j] = shuffled[j], shuffled[i]
	}
	fx.writeSession("--t--a", userMsg("u1", "前缀 "+joined+" 后缀"))
	fx.writeSession("--t--b", userMsg("u2", "乱序 "+strings.Join(shuffled, " ")))
	fx.boot()

	// 超过 16 个词元按整句处理：只有连续出现的那条命中
	r := fx.indexer.Search(joined, 10, 5)
	if r.TotalHitSessions != 1 || !strings.Contains(r.Sessions[0].FilePath, "--t--a") {
		t.Fatalf("长查询应按整句匹配，got %+v", r.Sessions)
	}
}

func TestSplitQueryTerms(t *testing.T) {
	got := splitQueryTerms("  alpha\tbeta\u3000gamma\ndelta  ")
	want := []string{"alpha", "beta", "gamma", "delta"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
	if terms := splitQueryTerms("   "); len(terms) != 0 {
		t.Fatalf("空白查询应无词元，got %v", terms)
	}
}

// ── 会话内查找（SearchInSession）────────────────────────────────────────
//
// 现场：「在某个会话里按关键词找那条消息，然后上一条/下一条跳过去」。
// 与跨会话搜索共用匹配逻辑，差异只在范围（单文件）与顺序（时间线）。

func TestSearchInSessionOnlyMatchesTargetFile(t *testing.T) {
	fx := newFixture(t)
	// 两个会话都含同一个词：会话内查找只能命中目标那一个
	target := fx.writeSession("--t--a", userMsg("u1", "部署脚本超时"), userMsg("u2", "部署完成"))
	fx.writeSession("--t--b", userMsg("u3", "部署脚本超时"))
	fx.boot()

	r := fx.indexer.SearchInSession("部署", target, 50)
	if r.TotalHitSessions != 1 || len(r.Sessions) != 1 {
		t.Fatalf("只应命中目标会话，got %+v", r)
	}
	hit := r.Sessions[0]
	if hit.FilePath != target {
		t.Fatalf("命中会话路径=%q, want %q", hit.FilePath, target)
	}
	// 跨会话搜索仍能看到两个会话（范围差异只作用于 SearchInSession）
	if got := fx.indexer.Search("部署", 10, 5).TotalHitSessions; got != 2 {
		t.Fatalf("跨会话搜索应命中 2 个会话，got %d", got)
	}
}

func TestSearchInSessionOrdersByTimeline(t *testing.T) {
	fx := newFixture(t)
	// 三条命中：中间那条是「整句」（跨会话评分里最高），会话内查找必须仍按时间线
	path := fx.writeSession("--t--a",
		userMsg("u1", "alpha 很远 beta"),
		userMsg("u2", "alpha beta"),
		userMsg("u3", "alpha 又一次 beta"),
	)
	fx.boot()

	hit := fx.indexer.SearchInSession("alpha beta", path, 50).Sessions[0]
	if len(hit.Matches) != 3 {
		t.Fatalf("应有 3 条命中，got %d", len(hit.Matches))
	}
	for index, want := range []string{"u1", "u2", "u3"} {
		if hit.Matches[index].MessageId != want {
			t.Fatalf("会话内命中必须按时间线排序：位置 %d got %q want %q", index, hit.Matches[index].MessageId, want)
		}
	}
	if hit.HitCount != 3 {
		t.Fatalf("hitCount=%d, want 3", hit.HitCount)
	}
}

func TestSearchInSessionUnknownPathAndLimits(t *testing.T) {
	fx := newFixture(t)
	path := fx.writeSession("--t--a", userMsg("u1", "abc"), userMsg("u2", "abc"), userMsg("u3", "abc"))
	fx.boot()

	if got := fx.indexer.SearchInSession("abc", "", 50); len(got.Sessions) != 0 {
		t.Fatalf("空路径应返回空结果，got %+v", got)
	}
	if got := fx.indexer.SearchInSession("abc", filepath.Join(fx.root, "nope.jsonl"), 50); len(got.Sessions) != 0 {
		t.Fatalf("未索引路径应返回空结果，got %+v", got)
	}
	// limit 同时是「返回条数」上限，Truncated 标记真实命中更多
	limited := fx.indexer.SearchInSession("abc", path, 2)
	if len(limited.Sessions) != 1 || len(limited.Sessions[0].Matches) != 2 {
		t.Fatalf("limit=2 应只返回 2 条，got %+v", limited.Sessions)
	}
	if !limited.Truncated {
		t.Fatal("命中数超过 limit 时应标 truncated")
	}
	// 大小写不同的路径也应命中（Windows 路径在索引里统一小写）
	upper := strings.ToUpper(path)
	if got := fx.indexer.SearchInSession("abc", upper, 50); len(got.Sessions) != 1 {
		t.Fatalf("大小写不同的路径应命中，got %+v", got)
	}
}
