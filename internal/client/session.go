package client

// The phone build: it connects to a desktop PiDeck Lite server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_LITE_MOBILE=1 for a preview on a desktop).

import (
	"errors"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// mobileSessionRow is one session in the rail: a status dot, its title,
// and when it last did something.
func (a *mobileApp) mobileSessionRow(cx *core.Scope, s remotewire.Session) core.Node {
	colors := ui.ColorsOf(cx)
	tone := remoteStatusColor(s.Status, colors)
	if s.Ask != nil {
		tone = colors.Warn()
	}
	return core.View{OnPress: func(core.PressEvent) {
		a.openDrawer(false)
		a.openSession(s.ID, s.Title)
	}, Role: core.RoleButton, Label: s.Title, TestID: "mobile-session",
		StyleFunc: func() core.Style {
			st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(44),
				Padding: core.Edges{Left: 8, Right: 2}, CornerRadius: 8, Transition: viewkit.PressMotion,
				Active: &core.Style{Background: colors.Pressed()}}
			if a.active.Get() == s.ID {
				st.Background = colors.Pressed()
			}
			return st
		},
		Children: []core.Node{
			core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, Background: tone, FlexShrink: 0}},
			core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 0}, Children: []core.Node{
				core.Text{Content: s.Title, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
					Style: core.Style{FontSize: 13, LineHeight: 18}, StyleFunc: ui.Colored(colors.Text)},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
					core.Text{Content: mobileWhen(s.Updated), MaxLines: 1, Style: core.Style{FontSize: 10},
						StyleFunc: ui.Colored(colors.Faint)},
					core.Show{When: func() bool { return s.Running }, Then: func(*core.Scope) core.Node {
						return ui.Text(apptext.T("运行中"), 9.5, ui.Medium, colors.Accent)
					}},
					core.Show{When: func() bool { return s.Ask != nil }, Then: func(*core.Scope) core.Node {
						return ui.Text(apptext.T("待确认"), 9.5, ui.Medium, colors.Warn)
					}},
				}},
			}},
			core.Show{When: func() bool { return s.External }, Then: func(*core.Scope) core.Node {
				return core.View{Style: core.Style{Padding: core.Symmetric(1, 5), CornerRadius: 4, Background: colors.Inset()},
					Children: []core.Node{ui.Text("pi", 9, ui.Medium, colors.Faint)}}
			}},
			core.Show{When: func() bool { return s.Pinned }, Then: func(*core.Scope) core.Node {
				return ui.Icon(lucide.Pin, 11, colors.Faint)
			}},
			a.pressIcon(lucide.Ellipsis, apptext.T("会话操作"), 30, 15, nil, func() { a.actionID.Set(s.ID) }, "mobile-session-actions"),
		}}
}

func remoteStatusColor(status string, colors ui.Colors) core.Color {
	switch status {
	case "running":
		return viewkit.Thinking
	case "waiting":
		return viewkit.Warning
	case "failed":
		return colors.Danger()
	case "starting":
		return colors.Accent()
	}
	return colors.Faint()
}

func mobileWhen(ms int64) string {
	if ms <= 0 {
		return ""
	}
	return viewkit.WhenText(time.UnixMilli(ms), time.Now())
}

// pressIcon is a phone toolbar action with a springing press.
func (a *mobileApp) pressIcon(icon func() *core.SVG, label string, size, iconSize core.Points, disabled func() bool,
	press func(), testID string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return ui.Press{
		OnPress: press, Disabled: disabled, Scale: 0.88, Role: core.RoleButton, Label: label, TestID: testID,
		Style: core.Style{Width: core.Pt(size), Height: core.Pt(size), AlignItems: core.AlignCenter,
			JustifyContent: core.JustifyCenter, CornerRadius: 8},
		StyleFunc: func() core.Style {
			return core.Style{Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
				Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{ui.Icon(icon, iconSize, colors.Muted)},
	}
}

// openSession downloads a session's transcript.
func (a *mobileApp) openSession(id, title string) {
	a.active.Set(id)
	a.activeTitle.Set(title)
	a.messages.Set(nil)
	a.running.Set(false)
	a.findOpen.Set(false)
	a.findText.Set("")
	a.transcriptErr.Set("")
	a.ask.Set(nil)
	a.askText.Set("")
	a.options.Set(remotewire.Options{})
	a.refreshTranscript()
	a.loadOptions(id)
}

func (a *mobileApp) closeSession() {
	a.active.Set("")
	a.messages.Set(nil)
	a.running.Set(false)
	a.findOpen.Set(false)
	a.findText.Set("")
	a.transcriptErr.Set("")
	a.ask.Set(nil)
	a.askText.Set("")
}

func (a *mobileApp) refreshTranscript() {
	client := a.client
	id := a.active.GetUntracked()
	if client == nil || id == "" || a.transcriptLoading {
		return
	}
	a.transcriptLoading = true
	a.transcriptBusy.Set(true)
	go func() {
		t, err := client.transcript(id)
		a.cx.Post(func() {
			a.transcriptLoading = false
			a.transcriptBusy.Set(false)
			if a.active.GetUntracked() != id {
				return
			}
			if err != nil {
				if errors.Is(err, errRemoteAuth) {
					a.disconnectWith(remoteErrorText(err))
				} else {
					a.transcriptErr.Set(remoteErrorText(err))
				}
				return
			}
			a.activeTitle.Set(t.Title)
			a.messages.Set(t.Messages)
			a.running.Set(t.Running)
			a.ask.Set(t.Ask)
			a.transcriptErr.Set(t.Error)
		})
	}()
}
