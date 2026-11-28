//go:build !js && !android && !ios

package workbench

// The card a session shows while the pointer rests on it: a row in the rail
// and a tab above the chat show the same small card, so a session reads the
// same wherever the pointer finds it. The card carries what one line cannot:
// the whole title, when it began, its folder and what it is doing.
//
// The card is a hover card, so the pointer may move from the row onto it
// without it closing in between. One card shows at a time: the app keeps
// which session holds it, so leaving one row for the next closes the first
// before the second opens and no card trails the pointer.
//
// A card reads what is on screen: the title, status and times the session
// already keeps. It never reads a session file itself, so a resting pointer
// costs no disk.

import (
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// Which list a hover card belongs to: the rail's rows and the tab bar differ
// in placement and size, and a session is in both.
const (
	sessionHoverRail = "rail"
	sessionHoverTab  = "tab"
)

// A resting pointer opens the card; a quick pass over the list only starts
// a timer that the next row cancels. The close is short, so the card is gone
// by the time the next one opens, and long enough for the pointer to cross
// the few points between the row and the card.
const (
	sessionHoverOpenDelay  = 280 * time.Millisecond
	sessionHoverCloseDelay = 140 * time.Millisecond
)

// sessionHoverState is which session holds the one open card, and from which
// list. The zero value means none.
type sessionHoverState struct {
	ID    string
	Where string
}

// shows reports whether a card of this list and session holds the pointer.
func (h sessionHoverState) shows(id, where string) bool {
	return id != "" && h.ID == id && h.Where == where
}

// sessionHoverCard wraps the row or tab that opens a session's card.
func (a *app) sessionHoverCard(s func() *session, where string, placement core.Placement, trigger core.Node) core.Node {
	return sessionHoverNode{a: a, sess: s, where: where, placement: placement, trigger: trigger}
}

// sessionHoverNode is the row or tab, its card, and the pointer between
// them. Rendering it is what gives the card a scope to time its own leave
// with: base.HoverCard will not close a card whose trigger still holds the
// keyboard focus, and a pointer leaving a clicked tab should close it all
// the same.
type sessionHoverNode struct {
	a         *app
	sess      func() *session
	where     string
	placement core.Placement
	trigger   core.Node
}

func (h sessionHoverNode) Render(cx *core.Scope) core.Node {
	style := core.Style{Width: core.Pt(232)}
	id := func() string {
		if sess := h.sess(); sess != nil {
			return sess.ID
		}
		return ""
	}
	open := func() bool {
		return !h.a.railMenuShowing() && h.a.sessionHover.Get().shows(id(), h.where)
	}
	// inside is whether the pointer is on the card itself, as opposed to the
	// row or tab. A leave of one hands over to the other within the delay.
	var inside bool
	var pending func() bool
	cancel := func() {
		if pending != nil {
			pending()
			pending = nil
		}
	}
	cx.Cleanup(cancel)
	closeLater := func() {
		cancel()
		if !open() {
			return
		}
		pending = cx.AfterFunc(sessionHoverCloseDelay, func() {
			pending = nil
			if inside {
				return
			}
			if h.a.sessionHover.GetUntracked().shows(id(), h.where) {
				h.a.sessionHover.Set(sessionHoverState{})
			}
		})
	}
	trigger := core.View{
		OnMouseEnter: func(core.MouseEvent) { inside = false; cancel() },
		OnMouseLeave: func(core.MouseEvent) { closeLater() },
		Children:     []core.Node{h.trigger},
	}
	body := []core.Node{core.Dynamic(func(cx *core.Scope) core.Node {
		sess := h.sess()
		if sess == nil {
			return nil
		}
		return h.a.sessionHoverBody(cx, sess, h.where)
	})}
	return ui.HoverCard{
		Open:         open,
		OnOpenChange: func(isOpen bool, reason base.Reason) { h.a.setSessionHover(id(), h.where, isOpen, reason) },
		OpenDelay:    sessionHoverOpenDelay, CloseDelay: sessionHoverCloseDelay,
		Placement: h.placement, Align: core.AlignStart,
		Trigger: trigger, TestID: "session-hover-" + h.where, Style: style,
		Children: []core.Node{core.View{
			OnMouseEnter: func(core.MouseEvent) { inside = true; cancel() },
			OnMouseLeave: func(core.MouseEvent) { inside = false; closeLater() },
			// The popup pads its content by 12; the same margin backwards
			// makes this view cover that padding too, so crossing the card's
			// edge counts as being on the card instead of leaving it.
			Style:    core.Style{Margin: core.All(-12), Padding: core.All(12)},
			Children: body,
		}},
	}
}

// railMenuShowing reports whether a rail menu is open anywhere. A card that
// opened under one would cover the menu the pointer is on its way to.
func (a *app) railMenuShowing() bool {
	return a.railMenuOpen.Get() != "" || a.addProjectOpen.Get() ||
		a.sessionMoreOpen.Get() != "" || a.projectMoreOpen.Get() != ""
}

// setSessionHover answers a hover card's request: a fine pointer's rest
// opens, its leave closes, and keyboard focus is no reason to open a card
// the user did not point at.
func (a *app) setSessionHover(id, where string, open bool, reason base.Reason) {
	if id == "" || reason == base.ReasonFocus {
		return
	}
	if open {
		if a.railMenuShowing() {
			return
		}
		a.sessionHover.Set(sessionHoverState{ID: id, Where: where})
		return
	}
	if a.sessionHover.GetUntracked().shows(id, where) {
		a.sessionHover.Set(sessionHoverState{})
	}
}

// clearSessionHover drops the card without waiting for its pointer to leave.
// A menu opening over it, or a session going away, ends the preview at once.
func (a *app) clearSessionHover() {
	if a.sessionHover.GetUntracked().ID != "" {
		a.sessionHover.Set(sessionHoverState{})
	}
}

// sessionHoverBody is the card's content: the whole title, the status and
// last activity, when the session began and its folder. A tab and a rail
// row share it, so the same session reads the same in both places.
func (a *app) sessionHoverBody(cx *core.Scope, s *session, where string) core.Node {
	colors := ui.ColorsOf(cx)
	title := core.Text{TestID: "session-hover-title", ContentFunc: func() string {
		return firstNonEmpty(s.title.Get(), apptext.T("未命名会话"))
	}, MaxLines: 2, EllipsizeMode: core.EllipsizeTail,
		Style:     core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 13, LineHeight: 18, FontWeight: ui.Semibold},
		StyleFunc: ui.Colored(colors.Text)}
	return core.View{TestID: "session-hover-card-" + where, Style: core.Style{Gap: 6}, Children: []core.Node{
		core.View{Style: core.Style{Gap: 4}, Children: []core.Node{title, a.sessionHoverStateRow(cx, s, colors)}},
		a.sessionHoverMeta(colors, "created", apptext.T("创建时间"), func() string {
			if s.Created.IsZero() {
				return ""
			}
			return s.Created.Local().Format("2006-01-02 15:04")
		}, false),
		core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
			ui.Icon(lucide.Folder, 11, colors.Faint),
			core.Text{TestID: "session-hover-dir", ContentFunc: func() string { return s.WS },
				MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 10.5},
				StyleFunc: ui.Colored(colors.Faint)},
		}},
	}}
}

// sessionHoverStateRow is the dot and what the session is doing, with its
// last activity: the same words and colors the overview uses.
func (a *app) sessionHoverStateRow(cx *core.Scope, s *session, colors ui.Colors) core.Node {
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 5}, Children: []core.Node{
		core.View{Style: core.Style{Width: core.Pt(6), Height: core.Pt(6), CornerRadius: 3, FlexShrink: 0},
			StyleFunc: func() core.Style { return core.Style{Background: statusDot(colors, s)} }},
		ui.Textf(func() string { return sessionStateText(s) }, 11, ui.Medium, func() core.Color { return statusDot(colors, s) }),
		ui.Text("·", 10.5, ui.Regular, colors.Faint),
		core.Text{ContentFunc: func() string { return viewkit.WhenText(s.updated.Get(), cx.Now()) }, MaxLines: 1,
			Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
	}}
}

// sessionHoverMeta is one labelled fact of the card. A path keeps its whole
// value and is drawn in the code face, so its start and last name survive
// the narrow column.
func (a *app) sessionHoverMeta(colors ui.Colors, key, label string, value func() string, mono bool) core.Node {
	face := ""
	if mono {
		face = viewkit.MonoFont()
	}
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
		ui.Text(label, 10.5, ui.Regular, colors.Faint),
		core.Text{TestID: "session-hover-" + key, ContentFunc: value, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
			Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: face, FontSize: 10.5},
			StyleFunc: ui.Colored(colors.Muted)},
	}}
}
