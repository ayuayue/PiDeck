//go:build !js && !android && !ios

package workbench

// The announcement center: what the feed says, newest first, with a
// refresh and the unread dot beside the rail's megaphone. Opening it
// counts as reading, as it does in PiDeck.

import (
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openAnnouncements shows the news, marks it read, and reads the feed
// again when the copy on screen is old.
func (a *app) openAnnouncements() {
	a.announceOpen.Set(true)
	a.markAnnouncementsRead()
	if a.announceStale() {
		a.fetchAnnouncements(false)
	}
}

// announceStale reports whether the feed is worth reading again.
func (a *app) announceStale() bool {
	a.announceMu.Lock()
	defer a.announceMu.Unlock()
	if len(a.announceItems) == 0 {
		return true
	}
	return time.Since(a.announceFetched) > announceEvery
}

// announceButton is the rail footer's megaphone, with a dot while there
// is news the user has not opened.
func (a *app) announceButton() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.announceRev.Get()
		unread := a.announceUnread()
		return core.View{Style: core.Style{Width: core.Pt(28), Height: core.Pt(28)}, Children: []core.Node{
			hint(apptext.T("公告"), ui.IconButton{Icon: lucide.Megaphone, Label: apptext.T("公告"), Size: 28, IconSize: 14.5,
				TestID: "rail-announcements", OnPress: func() { a.openAnnouncements() }}),
			core.Show{When: func() bool { return unread > 0 }, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Position: core.Absolute, Top: core.Pt(3), Right: core.Pt(2), Width: core.Pt(6), Height: core.Pt(6),
					CornerRadius: 3, Background: colors.Accent(), PointerEvents: core.PointerEventsNone}}
			}},
		}}
	})
}

// announcementsDialog lists the feed.
func (a *app) announcementsDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.announceRev.Get()
		_ = a.langRev.Get()
		items := a.announceList()
		busy := a.announceBusy.Get()
		failure := a.announceErr.Get()

		var rows []core.Node
		for _, it := range items {
			it := it
			tone := colors.Accent()
			switch it.Level {
			case announceWarn:
				tone = colors.Warn()
			case announceCritical:
				tone = colors.Danger()
			}
			children := []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
					core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: tone}},
					core.Text{Content: it.Title, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FontSize: 13, FontWeight: ui.Semibold, FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0)},
						StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: announcePublished(it).Format("2006-01-02"),
						Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 9.5, FlexShrink: 0}, StyleFunc: ui.Colored(colors.Faint)},
				}},
			}
			if it.Body != "" {
				children = append(children, core.Text{Content: it.Body, Style: core.Style{FontSize: 11.5, LineHeight: 17},
					StyleFunc: ui.Colored(colors.Muted)})
			}
			rows = append(rows, core.View{TestID: "announce-row",
				Style: core.Style{Gap: 4, Padding: core.Edges{Top: 9, Right: 11, Bottom: 10, Left: 11},
					CornerRadius: ui.RadiusCard, BorderWidth: 1, BorderColor: colors.Border()},
				Children: children})
		}

		var body core.Node
		switch {
		case len(rows) > 0:
			body = a.scrollStashFor("announcementsDialog:1").bind(cx, core.Scroll{TestID: "announce-list", Style: core.Style{MaxHeight: core.Pt(420)}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 8}, Children: rows}}})
		case busy:
			body = core.Text{Content: apptext.T("正在读取公告…"), Style: core.Style{FontSize: 11.5, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)}
		case failure != "":
			body = core.View{Style: core.Style{Gap: 4, Padding: core.All(8)}, Children: []core.Node{
				core.Text{Content: apptext.T("没能读到公告。"), Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: failure, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
			}}
		default:
			body = core.Text{Content: apptext.T("还没有公告。"), Style: core.Style{FontSize: 11.5, Padding: core.All(8)},
				StyleFunc: ui.Colored(colors.Faint)}
		}

		return ui.Dialog{
			Open:         a.announceOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.announceOpen.Set(open) },
			Title:        apptext.T("公告"),
			Description:  apptext.T("维护者发在这里的消息，打开即已读。"),
			TestID:       "announce-dialog",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(560)},
			Children:     []core.Node{body},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("刷新"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "announce-refresh",
					Disabled: func() bool { return busy },
					OnPress:  func() { a.fetchAnnouncements(true) }},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
					OnPress: func() { a.announceOpen.Set(false) }},
			},
		}
	})
}
