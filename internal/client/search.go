package client

// The phone build: it connects to a desktop PiDeck V2 server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"fmt"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// scheduleSearch asks the desktop for message matches, once typing pauses.
func (a *mobileApp) scheduleSearch() {
	query := strings.TrimSpace(a.query.GetUntracked())
	if len([]rune(query)) < 2 {
		a.searchSeq++
		a.hits.Set(nil)
		a.hitsBusy.Set(false)
		return
	}
	a.searchSeq++
	seq := a.searchSeq
	a.hitsBusy.Set(true)
	a.cx.AfterFunc(320*time.Millisecond, func() {
		if seq != a.searchSeq || a.client == nil {
			return
		}
		client := a.client
		go func() {
			hits, err := client.search(query, "")
			a.cx.Post(func() {
				if seq != a.searchSeq {
					return
				}
				a.hitsBusy.Set(false)
				if err != nil {
					return
				}
				a.hits.Set(hits)
				a.hitsQuery = query
			})
		}()
	})
}

// hitRows are the message matches under the title matches.
func (a *mobileApp) hitRows(cx *core.Scope, query string) []core.Node {
	colors := ui.ColorsOf(cx)
	hits := a.hits.Get()
	if a.hitsBusy.Get() && len(hits) == 0 {
		return []core.Node{core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(8, 16)},
			Children: []core.Node{ui.Spinner{Size: 12, Label: apptext.T("搜索消息")}, ui.Text(apptext.T("正在搜索消息…"), 11, ui.Regular, colors.Faint)}}}
	}
	if len(hits) == 0 {
		return nil
	}
	rows := make([]core.Node, 0, len(hits))
	for _, hit := range hits {
		h := hit
		rows = append(rows, core.View{OnPress: func(core.PressEvent) {
			a.searchOpen.Set(false)
			a.query.Set("")
			a.hits.Set(nil)
			a.openSession(h.Session, h.Title)
			// Land on the matches rather than the top of a long history.
			a.findText.Set(strings.TrimSpace(a.hitsQuery))
			a.findOpen.Set(true)
		}, Role: core.RoleButton, Label: h.Title, TestID: "mobile-hit",
			StyleFunc: func() core.Style {
				return core.Style{Gap: 2, Padding: core.Symmetric(7, 12), CornerRadius: 8, Transition: viewkit.PressMotion,
					Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
			},
			Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
					ui.Icon(lucide.MessageSquare, 11, colors.Faint),
					core.Text{Content: h.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FontSize: 12.5}, StyleFunc: ui.Colored(colors.Text)},
					ui.Text(h.Project, 9.5, ui.Regular, colors.Faint),
				}},
				core.Text{Content: h.Snippet, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Muted)},
			}})
	}
	return []core.Node{core.View{Style: core.Style{Gap: 1, Margin: core.Edges{Bottom: 14}}, Children: append([]core.Node{
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7, Padding: core.Symmetric(8, 16)}, Children: []core.Node{
			ui.Icon(lucide.Search, 13, colors.Muted),
			core.Text{Content: apptext.T("消息匹配"), MaxLines: 1, Style: core.Style{FlexGrow: 1, FontSize: 12, FontWeight: ui.Semibold},
				StyleFunc: ui.Colored(colors.Text)},
			ui.Text(fmt.Sprint(len(hits)), 10, ui.Regular, colors.Faint),
		}},
	}, rows...)}}
}
