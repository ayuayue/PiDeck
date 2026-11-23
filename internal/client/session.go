package client

// The phone build: it connects to a desktop PiDeck V2 server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

import (
	"errors"
	"time"

	"example.com/pideck-v2/internal/alerts"
	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// sessionRecentDays is how far back the rail shows a project's sessions
// before it folds the rest behind one row.
const sessionRecentDays = 3

// splitRecentSessions divides a project's sessions into the ones the rail
// shows by default and the older ones it folds away. A session that is
// pinned, running, waiting on an answer, or has no time at all stays in
// sight: hiding it would hide something the user is watching.
func splitRecentSessions(list []remotewire.Session, now time.Time) (recent, earlier []remotewire.Session) {
	cutoff := now.AddDate(0, 0, -sessionRecentDays).UnixMilli()
	for _, s := range list {
		if s.Updated <= 0 || s.Updated >= cutoff || s.Running || s.Ask != nil || s.Pinned {
			recent = append(recent, s)
			continue
		}
		earlier = append(earlier, s)
	}
	return recent, earlier
}

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

// railSessionRows is a project's sessions, throttled: the last few days'
// worth, then the older ones behind one row that opens and closes them.
func (a *mobileApp) railSessionRows(cx *core.Scope, path string, sessions []remotewire.Session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		recent, earlier := splitRecentSessions(sessions, time.Now())
		expanded := a.railExpanded(path)
		rows := make([]core.Node, 0, len(recent)+2)
		for _, s := range recent {
			rows = append(rows, a.mobileSessionRow(cx, s))
		}
		if len(earlier) > 0 {
			if expanded {
				for _, s := range earlier {
					rows = append(rows, a.mobileSessionRow(cx, s))
				}
				rows = append(rows, a.railMoreRow(apptext.T("收起更早的会话"), path, "mobile-sessions-fewer"))
			} else {
				rows = append(rows, a.railMoreRow(apptext.T("展开更早的 %d 个会话", len(earlier)), path, "mobile-sessions-more"))
			}
		}
		return core.View{Style: core.Style{Gap: 1, Padding: core.Edges{Left: 6}}, Children: rows}
	})
}

// railMoreRow opens or closes a project's older sessions.
func (a *mobileApp) railMoreRow(label, path, testID string) core.Node {
	colors := ui.ColorsOf(a.cx)
	return core.View{OnPress: func(core.PressEvent) { a.toggleRailExpanded(path) }, Role: core.RoleButton, Label: label, TestID: testID,
		StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, MinHeight: core.Pt(34),
				Padding: core.Edges{Left: 8, Right: 6}, CornerRadius: 8, Transition: viewkit.PressMotion,
				Active: &core.Style{Background: colors.Pressed()}}
		},
		Children: []core.Node{
			ui.Icon(lucide.Clock, 12, colors.Faint),
			core.Text{Content: label, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)},
		}}
}

// railExpanded says a project shows its older sessions too.
func (a *mobileApp) railExpanded(path string) bool {
	for _, p := range a.railExpandedPaths.Get() {
		if p == path {
			return true
		}
	}
	return false
}

// toggleRailExpanded opens or closes one project's older sessions.
func (a *mobileApp) toggleRailExpanded(path string) {
	a.railExpandedPaths.Update(func(list []string) []string {
		out := make([]string, 0, len(list)+1)
		found := false
		for _, p := range list {
			if p == path {
				found = true
				continue
			}
			out = append(out, p)
		}
		if !found {
			out = append(out, path)
		}
		return out
	})
}

// syncMode follows the desktop's mode for the open session: it owns what
// the next turn asks for, the phone only echoes it.
func (a *mobileApp) syncMode(snap remotewire.Snapshot) {
	id := a.active.GetUntracked()
	if id == "" {
		return
	}
	for _, p := range snap.Projects {
		for _, s := range p.Sessions {
			if s.ID == id {
				if a.mode.GetUntracked() != s.Mode {
					a.mode.Set(s.Mode)
				}
				return
			}
		}
	}
}

// openSession downloads a session's transcript.
func (a *mobileApp) openSession(id, title string) {
	a.sessionSeq++
	a.active.Set(id)
	a.activeTitle.Set(title)
	a.messages.Set(nil)
	a.running.Set(false)
	a.findOpen.Set(false)
	a.findText.Set("")
	a.findSelected.Set(transcriptRowKey{})
	a.resetTranscriptPicture()
	a.transcriptErr.Set("")
	a.transcriptTruncated.Set(false)
	a.messagesBefore.Set(0)
	a.olderBusy.Set(false)
	a.sendErr.Set("")
	a.ask.Set(nil)
	a.askText.Set("")
	a.options.Set(remotewire.Options{})
	a.mode.Set("")
	a.syncMode(a.state.GetUntracked())
	a.refreshTranscript()
	a.loadOptions(id)
}

func (a *mobileApp) closeSession() {
	a.sessionSeq++
	a.active.Set("")
	a.messages.Set(nil)
	a.running.Set(false)
	a.mode.Set("")
	a.findOpen.Set(false)
	a.findText.Set("")
	a.findSelected.Set(transcriptRowKey{})
	a.resetTranscriptPicture()
	a.transcriptErr.Set("")
	a.transcriptBusy.Set(false)
	a.transcriptTruncated.Set(false)
	a.messagesBefore.Set(0)
	a.olderBusy.Set(false)
	a.sendErr.Set("")
	a.ask.Set(nil)
	a.askText.Set("")
}

func (a *mobileApp) refreshTranscript() {
	client := a.client
	id := a.active.GetUntracked()
	if client == nil || id == "" {
		return
	}
	// A newer read owns the page: switching sessions must not wait for the
	// poll that was already in flight.
	a.transcriptSeq++
	seq := a.transcriptSeq
	visit := a.sessionSeq
	a.transcriptBusy.Set(true)
	go func() {
		t, err := client.transcript(id, 0)
		a.cx.Post(func() {
			if a.client != client || visit != a.sessionSeq || seq != a.transcriptSeq || a.active.GetUntracked() != id {
				return
			}
			a.transcriptBusy.Set(false)
			if err != nil {
				if errors.Is(err, errRemoteAuth) {
					a.disconnectWith(remoteErrorText(err))
				} else {
					a.transcriptErr.Set(remoteErrorText(err))
				}
				return
			}
			a.activeTitle.Set(t.Title)
			a.setTranscriptMessages(mergeMessages(a.messages.GetUntracked(), t.Messages, t.Before))
			a.messagesBefore.Set(keepBefore(a.messagesBefore.GetUntracked(), t.Before))
			a.transcriptTruncated.Set(t.Truncated)
			// The phone cannot watch the desktop's events, so it hears the
			// change between two polls: a turn that just ended, or a
			// question that just appeared.
			wasRunning := a.running.GetUntracked()
			wasAsk := a.ask.GetUntracked() != nil
			a.running.Set(t.Running)
			a.resetAskDraft(t.Ask)
			a.ask.Set(t.Ask)
			switch {
			case wasRunning && !t.Running:
				a.playAlert(alerts.KindDone)
				a.notifySession(id, false)
			case !wasAsk && t.Ask != nil:
				a.playAlert(alerts.KindWaiting)
				a.notifySession(id, true)
			}
			a.transcriptErr.Set(t.Error)
		})
	}()
}

// loadOlderTranscript reads the turns before the ones the page holds.
func (a *mobileApp) loadOlderTranscript() {
	client := a.client
	id := a.active.GetUntracked()
	before := a.messagesBefore.GetUntracked()
	if client == nil || id == "" || before <= 0 || a.olderBusy.Get() {
		return
	}
	visit := a.sessionSeq
	a.olderBusy.Set(true)
	go func() {
		t, err := client.transcript(id, before)
		a.cx.Post(func() {
			if a.client != client || visit != a.sessionSeq || a.active.GetUntracked() != id {
				return
			}
			a.olderBusy.Set(false)
			if err != nil {
				if errors.Is(err, errRemoteAuth) {
					a.disconnectWith(remoteErrorText(err))
					return
				}
				a.transcriptErr.Set(remoteErrorText(err))
				return
			}
			held := a.messages.GetUntracked()
			a.messages.Set(append(append([]remotewire.Message(nil), t.Messages...), held...))
			a.messagesBefore.Set(keepBefore(a.messagesBefore.GetUntracked(), t.Before))
			if t.Truncated {
				a.transcriptTruncated.Set(true)
			}
		})
	}()
}

// mergeMessages keeps the older pages the reader loaded and takes the
// newest page in their place: a turn the page carries replaces the copy
// it had, so a poll never drops what was already read.
func mergeMessages(held, page []remotewire.Message, pageBefore int) []remotewire.Message {
	if pageBefore <= 0 || len(held) == 0 {
		return page
	}
	kept := make([]remotewire.Message, 0, len(held)+len(page))
	for _, m := range held {
		if m.Turn < pageBefore {
			kept = append(kept, m)
		}
	}
	return append(kept, page...)
}

// keepBefore is the cursor after a read: the one that reaches further back.
func keepBefore(current, next int) int {
	if current <= 0 {
		return next
	}
	if next <= 0 {
		return 0
	}
	if current < next {
		return current
	}
	return next
}

// setTranscriptMessages publishes a read's messages only when they differ,
// so the twice-a-second poll does not rebuild the whole page under the
// reader.
func (a *mobileApp) setTranscriptMessages(next []remotewire.Message) {
	old := a.messages.GetUntracked()
	if len(old) == len(next) {
		same := true
		for i := range next {
			if old[i] != next[i] {
				same = false
				break
			}
		}
		if same {
			return
		}
	}
	a.messages.Set(next)
}
