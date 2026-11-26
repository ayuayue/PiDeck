//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestSearchResultsLoadMore(t *testing.T) {
	for _, tt := range []struct {
		name          string
		width, height core.Points
		dark          bool
	}{
		{name: "regular", width: 1320, height: 860},
		{name: "compact-dark", width: 960, height: 640, dark: true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			var docs []searchDoc
			for i := range 135 {
				title := fmt.Sprintf("工作记录 %03d · 跨平台产品界面与可访问性优化", i+1)
				if i < 70 {
					title = "发布" + title
				}
				text := ""
				if i >= 60 {
					text = "检查发布结果，并记录发布后的验证。"
				}
				docs = append(docs, searchDoc{ID: fmt.Sprintf("result-%03d", i+1), Title: title,
					Cwd: "/projects/product", Text: text})
			}
			var built *app
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				cx.SetTheme(viewkit.Theme())
				if tt.dark {
					cx.SetAppearance(core.AppearanceDark)
				} else {
					cx.SetAppearance(core.AppearanceLight)
				}
				built = &app{
					cx: cx, chatWidthPctSig: core.NewSignal(cx, chatWidthPctDefault),
					searchOpen: core.NewSignal(cx, true), searchText: core.NewSignal(cx, "发布"),
					searchScope: core.NewSignal(cx, ""), searchRev: core.NewSignal(cx, 0),
					searchBusy: core.NewSignal(cx, false), searchDocs: docs, searchIndexed: true,
					searchResults: core.NewSignal(cx, &searchResult{query: "发布", hits: matchSearch(t.Context(), docs, "发布", 0)}),
				}
				return core.View{Style: ui.FillRest.Merge(core.Style{FontFamily: cx.Theme().Sans}),
					StyleFunc: func() core.Style { return core.Style{Background: ui.ColorsOf(cx).Background()} },
					Children:  []core.Node{built.searchDialog()}}
			}, nsgotest.Size(tt.width, tt.height), nsgotest.Environment(core.Environment{OS: core.OSWindows, Idiom: core.IdiomDesktop}))
			screen.WaitFor("id:session-search", 5*time.Second)
			if nsgotest.Target() != "" {
				screen.Screenshot("search-results-" + tt.name)
			}
			assertSummary := func(sessions, matches int) {
				t.Helper()
				want := fmt.Sprintf("找到 %d 个会话 · %d 处匹配", sessions, matches)
				if !screen.Exists("text:" + want) {
					t.Fatalf("missing complete result summary %q; texts = %v", want, screen.Texts())
				}
			}
			assertRows := func(want int) {
				t.Helper()
				if got := len(screen.QueryMounted("id:search-hit")); got != want {
					t.Fatalf("mounted search results = %d, want %d", got, want)
				}
			}
			scrollToEnd := func() {
				t.Helper()
				list := screen.Find("id:search-results")
				screen.Scroll("id:search-results", list.Content.Height)
			}
			assertActionsVisible := func() {
				t.Helper()
				for _, selector := range []string{"id:search-input", "id:search-rebuild", "id:search-close"} {
					bounds := screen.Find(selector).Bounds()
					if bounds.Origin.Y < 0 || bounds.Origin.Y+bounds.Size.Height > tt.height+1 {
						t.Fatalf("%s is outside the window: %v", selector, bounds)
					}
				}
			}
			assertSummary(135, 150)
			assertRows(60)
			assertActionsVisible()
			scrollToEnd()
			before := screen.Find("id:search-results").Offset.Y
			screen.Focus("id:search-more")
			screen.Key("Return")
			assertSummary(135, 150)
			assertRows(120)
			if got := screen.Find("id:search-results").Offset.Y; got < before-1 {
				t.Fatalf("loading more reset the reading position: got %v, was %v", got, before)
			}
			scrollToEnd()
			screen.Press("id:search-more")
			assertRows(135)
			assertActionsVisible()
			if len(screen.QueryMounted("id:search-more")) != 0 {
				t.Fatal("load more remains after all results are shown")
			}
			scrollToEnd()
			last := screen.Find("id:search-hit >> text:工作记录 135").Bounds()
			viewport := screen.Find("id:search-results").Bounds()
			if last.Origin.Y < viewport.Origin.Y || last.Origin.Y+last.Size.Height > viewport.Origin.Y+viewport.Size.Height+1 {
				t.Fatalf("last search result is unreachable: last=%v viewport=%v", last, viewport)
			}
			if list := screen.Find("id:search-results"); list.Content.Width > list.Bounds().Size.Width+1 {
				t.Fatalf("results overflow horizontally: content=%v viewport=%v", list.Content, list.Bounds())
			}
			if nsgotest.Target() != "" {
				screen.Screenshot("search-results-" + tt.name + "-last")
			}
			screen.Press("role:radio 标题")
			assertSummary(70, 20)
			assertRows(60)
			scrollToEnd()
			screen.Press("id:search-more")
			assertRows(70)
			screen.Press("role:radio 正文")
			assertSummary(75, 150)
			assertRows(60)
			screen.Press("role:radio 全部")
			assertSummary(135, 150)
			assertRows(60)

			scrollToEnd()
			screen.Press("id:search-more")
			assertRows(120)
			screen.Clear("id:search-input")
			screen.Type("id:search-input", "记录")
			screen.Post(built.runSearch)
			screen.WaitFor("text:找到 135 个会话 · 75 处匹配", 5*time.Second)
			assertRows(60)
			screen.Clear("id:search-input")
			screen.Type("id:search-input", strings.Repeat("不存在", 2))
			screen.Post(built.runSearch)
			screen.WaitFor("text:没有匹配的会话", 5*time.Second)
			assertRows(0)
			if len(screen.QueryMounted("id:search-more")) != 0 {
				t.Fatal("empty results offer loading more")
			}
			screen.Press("id:search-close")
			screen.WaitForGone("id:session-search", 5*time.Second)
		})
	}
}
