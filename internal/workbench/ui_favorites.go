//go:build !js && !android && !ios

package workbench

// The favorites page: saved answers and saved conversations, with a
// kind filter and a search field. A saved answer can be copied; either
// kind can jump back to its conversation.

import (
	"fmt"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openFavorites shows the list in the work area.
func (a *app) openFavorites() {
	a.openPane(paneFavorites)
}

// filterFavorites keeps the entries matching the kind and the query.
func filterFavorites(list []favoriteEntry, kind, query string) []favoriteEntry {
	query = strings.ToLower(strings.TrimSpace(query))
	var out []favoriteEntry
	for _, e := range list {
		if kind != "" && e.Kind != kind {
			continue
		}
		if query != "" {
			hay := strings.ToLower(e.SessionTitle + "\n" + e.Project + "\n" + e.Prompt + "\n" + e.Text)
			if !strings.Contains(hay, query) {
				continue
			}
		}
		out = append(out, e)
	}
	return out
}

// favoritesPane draws the list.
func (a *app) favoritesPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.favRev.Get()
		_ = a.langRev.Get()
		list := a.favoriteList()
		kind := a.favKind.Get()
		query := a.favQuery.Get()
		shown := filterFavorites(list, kind, query)

		chip := func(id, label string, count int) core.Node {
			on := func() bool { return kind == id }
			return core.View{
				OnPress: func(core.PressEvent) { a.favKind.Set(id) },
				Role:    core.RoleRadio, Label: label, TestID: "favorite-filter-" + id,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5, Height: core.Pt(26),
						Padding: core.Symmetric(0, 10), CornerRadius: 13, Hover: &core.Style{Background: colors.Hover()}}
					if on() {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{
					ui.Text(apptext.T(label), 11, ui.Medium, colors.Text),
					ui.Text(fmt.Sprint(count), 9.5, ui.Regular, colors.Faint),
				},
			}
		}
		replyCount, sessionCount := 0, 0
		for _, e := range list {
			switch e.Kind {
			case favoriteReply:
				replyCount++
			case favoriteSession:
				sessionCount++
			}
		}

		var rows []core.Node
		for _, e := range shown {
			entry := e
			icon := lucide.Quote
			if entry.Kind == favoriteSession {
				icon = lucide.MessageCircle
			}
			openable := entry.SessionID != ""
			row := core.View{TestID: favoriteKeyDown(entry),
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 9, MinHeight: core.Pt(52),
					Padding: core.Symmetric(5, 7), CornerRadius: 7},
				Children: []core.Node{
					ui.Icon(icon, 14, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
							core.Text{Content: favoriteKindLabel(entry.Kind), MaxLines: 1,
								Style: core.Style{FontSize: 9, FontWeight: ui.Semibold, LetterSpacing: 0.4}, StyleFunc: ui.Colored(colors.Accent)},
							core.Text{Content: viewkit.FirstLine(a.favoriteSubtitle(entry), 48), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style:     core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11},
								StyleFunc: ui.Colored(colors.Muted)},
							ui.Text(favoriteWhen(entry.CreatedAt), 9, ui.Regular, colors.Faint),
						}},
						core.Text{Content: favoriteSummary(entry, 110), MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 12, LineHeight: 17}, StyleFunc: ui.Colored(colors.Text)},
					}},
					core.View{OnPress: func(core.PressEvent) { a.copyFavorite(entry) }, Role: core.RoleButton,
						Label: apptext.T("复制收藏"), TestID: "favorite-copy-" + entry.ID,
						StyleFunc: func() core.Style {
							return core.Style{Width: core.Pt(24), Height: core.Pt(24), CornerRadius: 5, AlignItems: core.AlignCenter,
								JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Hover()}}
						}, Children: []core.Node{ui.Icon(lucide.Copy, 11, colors.Faint)}},
					core.View{OnPress: func(core.PressEvent) { a.openFavorite(entry) }, Role: core.RoleButton,
						Label: apptext.T("打开原会话"), TestID: "favorite-open-" + entry.ID,
						StyleFunc: func() core.Style {
							st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4, Height: core.Pt(24),
								Padding: core.Symmetric(0, 7), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
							if !openable {
								st.Opacity = core.Alpha(0.45)
							}
							return st
						}, Children: []core.Node{
							ui.Icon(lucide.ArrowUpRight, 11, colors.Faint),
							ui.Text(apptext.T("打开"), 9.5, ui.Regular, colors.Muted),
						}},
					core.View{OnPress: func(core.PressEvent) {
						a.removeFavorite(entry.ID)
					}, Role: core.RoleButton, Label: apptext.T("移除收藏"), TestID: "favorite-delete-" + entry.ID,
						StyleFunc: func() core.Style {
							return core.Style{Width: core.Pt(24), Height: core.Pt(24), CornerRadius: 5, AlignItems: core.AlignCenter,
								JustifyContent: core.JustifyCenter, Hover: &core.Style{Background: colors.Pressed()}}
						}, Children: []core.Node{ui.Icon(lucide.Trash, 11, colors.Faint)}},
				}}
			rows = append(rows, core.View{Style: core.Style{Hover: &core.Style{Background: colors.Hover()}}, Children: []core.Node{row}})
		}
		var body core.Node
		if len(rows) == 0 {
			text := apptext.T("还没有收藏。收藏一条回复或一个会话，它们会留在这里。")
			if len(list) > 0 {
				text = apptext.T("没有匹配的收藏。")
			}
			body = core.View{Style: core.Style{Padding: core.Symmetric(28, 8), AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
				ui.Icon(lucide.Star, 20, colors.Faint),
				core.Text{Content: text, MaxLines: 2, Style: core.Style{FontSize: 11.5, TextAlign: core.TextAlignCenter},
					StyleFunc: ui.Colored(colors.Faint)},
			}}
		} else {
			body = core.Scroll{Style: ui.FillRest, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}}
		}

		return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
			a.paneHeader("收藏夹", "回复保存的是当时的正文快照；会话保存的是引用，点开会回到原对话。",
				ui.Button{Text: apptext.T("清空收藏"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "favorite-clear",
					Disabled: func() bool { return len(list) == 0 },
					OnPress: func() {
						a.askConfirm("清空收藏", "所有收藏都会删除，原会话不受影响。", "清空", func() {
							a.clearFavorites()
						})
					}}),
			core.View{Style: core.Style{Direction: core.Column, Gap: 8, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
				Padding: core.Edges{Top: 12, Left: 18, Right: 18, Bottom: 10}}, Children: []core.Node{
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
					chip("", "全部", len(list)),
					chip(favoriteReply, "回复", replyCount),
					chip(favoriteSession, "会话", sessionCount),
					core.View{Style: core.Style{FlexGrow: 1}},
					core.Text{ContentFunc: func() string {
						return apptext.T("共 %d 条收藏。", len(list))
					}, Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
					core.View{Style: core.Style{Width: core.Pt(210)}, Children: []core.Node{
						core.Input{Value: a.favQuery.Get, OnChange: a.favQuery.Set, Placeholder: apptext.T("搜索收藏…"), Label: apptext.T("搜索收藏"),
							TestID: "favorite-search", AutoFocus: false,
							Style: core.Style{Height: core.Pt(28), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11.5,
								Color: colors.Text(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}},
					}},
				}},
				body,
			}},
		}}
	})
}

// copyFavorite puts an entry's text on the clipboard.
func (a *app) copyFavorite(e favoriteEntry) {
	text := e.Text
	if e.Kind == favoriteSession {
		text = e.SessionTitle
		if text == "" {
			text = e.SessionID
		}
	}
	if strings.TrimSpace(text) == "" {
		a.toast(ui.ToastInfo, "这条收藏没有正文", "")
		return
	}
	a.copyText(text, apptext.T("收藏内容"))
}
