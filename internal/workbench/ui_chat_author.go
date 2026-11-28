//go:build !js && !android && !ios

package workbench

import (
	"context"

	"example.com/pideck/assets"
	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit/brands"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// turnReplyHeader keeps the author independent of the streamed turn. The
// timestamp follows completion without rereading a preset on every delta.
func (a *app) turnReplyHeader(s *session, t func() turn) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		name, mark := a.replyAuthor(cx, s)
		return core.Dynamic(func(cx *core.Scope) core.Node {
			return a.chatAuthorHeader(cx, "reply", name(), mark, clockTime(t().End))
		})
	})
}

func (a *app) turnPromptHeader(t func() turn) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		tt := t()
		if tt.System {
			return nil
		}
		return a.chatAuthorHeader(cx, "prompt", apptext.T("用户"),
			ui.Icon(lucide.UserRound, a.chatAvatarSize()-14, ui.ColorsOf(cx).Muted), clockTime(tt.Start))
	})
}

func (a *app) chatAvatarSize() core.Points { return max(32, a.readingFont()*2) }

// chatAuthorHeader gives both sides the same identity scale. The outgoing
// side mirrors the order, so the avatar stays at the outside edge.
func (a *app) chatAuthorHeader(cx *core.Scope, role, name string, mark core.Node, stamp string) core.Node {
	colors := ui.ColorsOf(cx)
	avatarSize := a.chatAvatarSize()
	avatar := core.View{TestID: "chat-" + role + "-avatar", Role: core.RoleImage, Label: name,
		Style: core.Style{Width: core.Pt(avatarSize), Height: core.Pt(avatarSize), FlexShrink: 0,
			CornerRadius: avatarSize / 3, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, BorderWidth: 1},
		StyleFunc: func() core.Style { return core.Style{Background: colors.Surface(), BorderColor: colors.Border()} },
		Children:  []core.Node{mark}}
	author := core.Text{Content: name, TestID: "chat-" + role + "-author", MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
		Style: core.Style{FontSize: max(14, a.readingFont()-1), LineHeight: a.readingRowLine(), FontWeight: ui.Semibold,
			MinWidth: core.Pt(0), FlexShrink: 1}, StyleFunc: ui.Colored(colors.Text)}
	labels := []core.Node{author}
	if stamp != "" {
		timestamp := ui.Tabular(core.Text{Content: stamp, TestID: "chat-" + role + "-time", MaxLines: 1,
			Style:     core.Style{FontSize: a.readingDetailFont(), LineHeight: a.readingDetailLine(), FlexShrink: 0},
			StyleFunc: ui.Colored(colors.Muted)})
		if role == "prompt" {
			labels = []core.Node{timestamp, author}
		} else {
			labels = append(labels, timestamp)
		}
	}
	info := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10,
		MinWidth: core.Pt(0), FlexShrink: 1}, Children: labels}
	children := []core.Node{avatar, info}
	style := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinWidth: core.Pt(0), Width: core.Pct(100)}
	if role == "prompt" {
		children = []core.Node{info, avatar}
		style.JustifyContent = core.JustifyEnd
	}
	return core.View{TestID: "chat-" + role + "-header", Style: style, Children: children}
}

// replyAuthor uses the backend's own identity, with a terminal mark for a
// custom agent. Reading its preset belongs off the UI thread.
func (a *app) replyAuthor(cx *core.Scope, s *session) (func() string, core.Node) {
	colors := ui.ColorsOf(cx)
	if backendOf(s) != "acp" {
		return func() string { return "pi" }, core.Dynamic(func(*core.Scope) core.Node {
			size := a.chatAvatarSize() - 8
			return core.Image{Source: core.ImageSource{Data: assets.LogoPNG},
				Style: core.Style{Width: core.Pt(size), Height: core.Pt(size), CornerRadius: 4}}
		})
	}
	id := s.acpPreset
	presetName := core.NewResource(cx, nil, func(context.Context, struct{}, core.ResourceInfo) (string, error) {
		if preset := a.acpPresetByID(id); preset != nil {
			return preset.Name, nil
		}
		return firstNonEmpty(id, "ACP"), nil
	})
	name := func() string {
		if value, ok := presetName.Get(); ok {
			return value
		}
		return firstNonEmpty(id, "ACP")
	}
	return name, core.Dynamic(func(*core.Scope) core.Node {
		size := a.chatAvatarSize() - 8
		if mark := brands.Mark(id, size, colors.Text); mark != nil {
			return mark
		}
		return ui.Icon(lucide.Terminal, size, colors.Text)
	})
}
