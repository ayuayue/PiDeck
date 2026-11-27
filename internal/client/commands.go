package client

import (
	"net/url"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type mobileSessionFeatures struct {
	commands       *core.Signal[[]remotewire.Command]
	commandBusy    *core.Signal[bool]
	commandError   *core.Signal[string]
	commandLimit   *core.Signal[int]
	commandSession string
	activity       *core.Signal[remotewire.SessionActivity]
	activityOpen   *core.Signal[bool]
	activityLimit  *core.Signal[int]
	jumpTurn       *core.Signal[int]
}

func newMobileSessionFeatures(cx *core.Scope) mobileSessionFeatures {
	return mobileSessionFeatures{
		commands:    core.NewSignalFunc(cx, []remotewire.Command(nil), nil),
		commandBusy: core.NewSignal(cx, false), commandError: core.NewSignal(cx, ""), commandLimit: core.NewSignal(cx, 6),
		activity:     core.NewSignalFunc(cx, remotewire.SessionActivity{}, sameSessionActivity),
		activityOpen: core.NewSignal(cx, false), activityLimit: core.NewSignal(cx, 40), jumpTurn: core.NewSignal(cx, -1),
	}
}

func (a *mobileApp) resetSessionFeatures() {
	a.features.commandSession = ""
	a.features.commands.Set(nil)
	a.features.commandBusy.Set(false)
	a.features.commandError.Set("")
	a.features.commandLimit.Set(6)
	a.features.activity.Set(remotewire.SessionActivity{})
	a.features.activityOpen.Set(false)
	a.features.activityLimit.Set(40)
	a.features.jumpTurn.Set(-1)
}

func slashQuery(text string) (string, bool) {
	if !strings.HasPrefix(text, "/") || strings.ContainsAny(text, " \t\r\n\u3000") {
		return "", false
	}
	return strings.ToLower(strings.TrimPrefix(text, "/")), true
}

func (a *mobileApp) commandDraftChanged(text string) {
	a.draft.Set(text)
	a.features.commandLimit.Set(6)
	if _, show := slashQuery(text); show {
		a.loadSessionCommands()
	}
}

func (c *remoteClient) sessionCommands(id string) ([]remotewire.Command, error) {
	var out remotewire.Commands
	err := c.do("/api/session/"+url.PathEscape(id)+"/commands", &out)
	return out.Commands, err
}

func (a *mobileApp) loadSessionCommands() {
	client, id, visit := a.client, a.active.GetUntracked(), a.sessionSeq
	if client == nil || id == "" || a.features.commandSession == id {
		return
	}
	a.features.commandSession = id
	a.features.commandBusy.Set(true)
	a.features.commandError.Set("")
	go func() {
		commands, err := client.sessionCommands(id)
		a.cx.Post(func() {
			if a.client != client || a.active.GetUntracked() != id || a.sessionSeq != visit {
				return
			}
			a.features.commandBusy.Set(false)
			if err != nil {
				a.features.commandError.Set(remoteErrorText(err))
				return
			}
			a.features.commands.Set(commands)
		})
	}()
}

// This subtree changes as the prefix changes, while the native editor keeps
// its identity, selection and composition state in its separate sibling.
func (a *mobileApp) commandSuggestions(cx *core.Scope) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		query, show := slashQuery(a.draft.Get())
		if !show || a.active.Get() == "" {
			return nil
		}
		colors := ui.ColorsOf(cx)
		var matches []remotewire.Command
		for _, command := range a.features.commands.Get() {
			if strings.Contains(strings.ToLower(command.Name), query) {
				matches = append(matches, command)
			}
		}
		var rows []core.Node
		if a.features.commandBusy.Get() {
			rows = append(rows, ui.Spinner{Size: 12, Label: apptext.T("命令")})
		}
		if message := a.features.commandError.Get(); message != "" {
			rows = append(rows, ui.Text(message, 11, ui.Regular, colors.Muted),
				ui.Button{Text: apptext.T("重试"), Size: ui.SizeSmall, Variant: ui.ButtonGhost, TestID: "mobile-command-retry", OnPress: func() {
					a.features.commandSession = ""
					a.loadSessionCommands()
				}})
		}
		limit := min(len(matches), a.features.commandLimit.Get())
		for _, command := range matches[:limit] {
			rows = append(rows, core.View{TestID: "mobile-command:" + command.Name, Role: core.RoleButton, Label: "/" + command.Name,
				OnPress:   func(core.PressEvent) { a.draft.Set("/" + command.Name + " ") },
				Style:     core.Style{MinHeight: core.Pt(38), Padding: core.Symmetric(4, 8), Gap: 1, CornerRadius: ui.RadiusControl},
				StyleFunc: func() core.Style { return core.Style{Active: &core.Style{Background: colors.Pressed()}} },
				Children: []core.Node{
					core.Text{Content: "/" + command.Name, MaxLines: 1, Style: core.Style{FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: command.Description, MaxLines: 1, Style: core.Style{FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
				}})
		}
		if len(matches) > limit {
			rows = append(rows, ui.Button{Text: apptext.T("加载更多"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "mobile-command-more", OnPress: func() { a.features.commandLimit.Update(func(n int) int { return n + 12 }) }})
		} else if len(matches) == 0 && !a.features.commandBusy.Get() && a.features.commandError.Get() == "" {
			rows = append(rows, ui.Text(apptext.T("没有匹配的命令"), 11, ui.Regular, colors.Muted))
		}
		return core.Scroll{TestID: "mobile-commands", Style: core.Style{MaxHeight: core.Pt(180)}, Children: []core.Node{
			core.View{Style: core.Style{Gap: 2, Padding: core.Edges{Top: 4, Right: viewkit.PanelInset, Bottom: 4, Left: 2}}, Children: rows},
		}}
	})
}
