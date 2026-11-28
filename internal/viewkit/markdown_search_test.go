package viewkit

import (
	"fmt"
	"strings"
	"testing"

	"github.com/nsgo-dev/nsgo/base/textview"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestLongMarkdownHistoryWithoutActiveSearchSettles(t *testing.T) {
	for _, mode := range []string{"closed", "empty-query"} {
		t.Run(mode, func(t *testing.T) {
			var search *textview.Search
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				cx.SetTheme(Theme())
				search = textview.NewSearch(cx)
				if mode == "closed" {
					search.SetQuery("history")
				} else {
					search.Open()
				}
				// Separate prose blocks in a long conversation share a finder.
				// Eagerly joining these views rechecks existing text on every join
				// and exceeds core's effect limit even with no active query.
				var paragraphs []core.Node
				for i := range 144 {
					markdown := strings.Repeat("Shared history paragraph.\n\n", 128) + fmt.Sprintf("History tail %d.", i)
					paragraphs = append(paragraphs, MarkdownSearch(search, markdown, nil, false, 0, 0, core.Style{}))
				}
				return core.Scroll{Style: core.Style{FlexGrow: 1}, Children: []core.Node{
					core.View{Children: paragraphs},
				}}
			}, nsgotest.Size(800, 600))
			screen.FindMounted("text:History tail 143.")
			if got := search.Count(); got != 0 {
				t.Fatalf("inactive search has %d matches, want 0", got)
			}
		})
	}
}

func TestMarkdownSearchActivatesAndKeepsTextAcrossQueries(t *testing.T) {
	var search *textview.Search
	var text *core.Signal[string]
	var extra *core.Signal[bool]
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		cx.SetTheme(Theme())
		search = textview.NewSearch(cx)
		text = core.NewSignal(cx, "Alpha beta Alpha.")
		extra = core.NewSignal(cx, false)
		return core.Scroll{Style: core.Style{FlexGrow: 1}, Children: []core.Node{
			MarkdownLive(search, text.Get, nil, 0, 0, core.Style{}, nil),
			core.Show{When: extra.Get, Then: func(*core.Scope) core.Node {
				return MarkdownSearch(search, "Another Alpha.", nil, false, 0, 0, core.Style{})
			}},
		}}
	}, nsgotest.Size(800, 600))
	update := func(fn func()) { screen.Post(fn); screen.Settle() }
	wantCount := func(want int) {
		t.Helper()
		if got := search.Count(); got != want {
			t.Fatalf("search count = %d, want %d", got, want)
		}
	}

	before := screen.Find("text:Alpha beta Alpha.").ID
	update(func() { search.SetQuery("Alpha") })
	wantCount(0)
	if got := screen.Find("text:Alpha beta Alpha.").ID; got != before {
		t.Fatal("changing a closed search remounted the text")
	}
	update(search.Open)
	wantCount(2)
	if got := search.Selected(); got != 1 {
		t.Fatalf("initial selected match = %d, want 1", got)
	}
	update(search.Next)
	if got := search.Selected(); got != 2 {
		t.Fatalf("next selected match = %d, want 2", got)
	}
	update(search.Previous)
	if got := search.Selected(); got != 1 {
		t.Fatalf("previous selected match = %d, want 1", got)
	}

	before = screen.Find("text:Alpha beta Alpha.").ID
	update(func() { search.SetQuery("beta") })
	wantCount(1)
	if got := screen.Find("text:Alpha beta Alpha.").ID; got != before {
		t.Fatal("switching active queries remounted the text")
	}
	update(func() { text.Set("Alpha beta beta.") })
	wantCount(2)
	update(func() { search.SetQuery("missing") })
	wantCount(0)
	update(func() { search.SetQuery("Alpha"); extra.Set(true) })
	wantCount(2)
	update(func() { extra.Set(false) })
	wantCount(1)
	update(search.Close)
	wantCount(0)
	screen.Find("text:Alpha beta beta.")
	update(search.Open)
	wantCount(1)
	update(func() { search.SetQuery("") })
	wantCount(0)
	screen.Find("text:Alpha beta beta.")
	update(func() { search.SetQuery("beta") })
	wantCount(2)
}
