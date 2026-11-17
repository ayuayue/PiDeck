//go:build !js && !android && !ios

package main

// Project trust: a folder the user added may hold anything, and the agent
// reads and writes there. Projects from before trust existed, and the
// built-in chat folder, are trusted; a folder added at runtime asks once.

import (
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// trustKey identifies a project across machines.
func trustKey(ws *workspace) string {
	if ws == nil {
		return ""
	}
	return ws.Target.key() + "|" + ws.Path
}

// projectTrusted reports whether the user allowed agents in a project.
func (a *app) projectTrusted(ws *workspace) bool {
	if ws == nil {
		return true
	}
	key := trustKey(ws)
	for _, v := range a.cfg.TrustedProjects {
		if v == key {
			return true
		}
	}
	return false
}

// trustProject allows agents to work in a project.
func (a *app) trustProject(ws *workspace) {
	if ws == nil || a.projectTrusted(ws) {
		return
	}
	key := trustKey(ws)
	a.cfg.TrustedProjects = append(a.cfg.TrustedProjects, key)
	if a.st != nil {
		a.st.edit(func(c *config) {
			for _, v := range c.TrustedProjects {
				if v == key {
					return
				}
			}
			c.TrustedProjects = append(c.TrustedProjects, key)
		})
	}
}

// untrustProject revokes a project's trust.
func (a *app) untrustProject(ws *workspace) {
	if ws == nil {
		return
	}
	key := trustKey(ws)
	kept := a.cfg.TrustedProjects[:0]
	for _, v := range a.cfg.TrustedProjects {
		if v != key {
			kept = append(kept, v)
		}
	}
	a.cfg.TrustedProjects = kept
	if a.st != nil {
		a.st.edit(func(c *config) {
			var out []string
			for _, v := range c.TrustedProjects {
				if v != key {
					out = append(out, v)
				}
			}
			c.TrustedProjects = out
		})
	}
}

// toggleProjectTrust flips a project's trust.
func (a *app) toggleProjectTrust(ws *workspace) {
	if ws == nil || ws.Chat {
		return
	}
	if a.projectTrusted(ws) {
		a.untrustProject(ws)
		a.toast(ui.ToastInfo, T("已撤销信任"), T("%s：新的消息会先询问。", ws.label()))
		return
	}
	a.trustProject(ws)
	a.toast(ui.ToastSuccess, T("已信任项目"), ws.label())
}

// askTrust asks before an agent works in an untrusted project, then runs
// the pending action.
func (a *app) askTrust(ws *workspace, then func()) {
	if ws == nil {
		if then != nil {
			then()
		}
		return
	}
	a.trustWS = ws
	a.trustThen = then
	a.trustOpen.Set(true)
}

// confirmTrust trusts the project and runs what was waiting.
func (a *app) confirmTrust() {
	ws := a.trustWS
	then := a.trustThen
	a.trustWS, a.trustThen = nil, nil
	a.trustOpen.Set(false)
	if ws == nil {
		return
	}
	a.trustProject(ws)
	if then != nil {
		then()
	}
}

// trustDialog asks once before an agent works in a new project.
func (a *app) trustDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		name := "这个项目"
		if a.trustWS != nil {
			name = "「" + a.trustWS.label() + "」"
		}
		return ui.Dialog{
			Open:         a.trustOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.trustOpen.Set(open) },
			Title:        T("信任这个项目？"),
			TestID:       "trust-dialog",
			Style:        core.Style{Width: core.Pt(420)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Text{Content: T("pi 会在%s里读写文件、运行命令。只信任你了解的文件夹。", name),
					Style: core.Style{FontSize: 12, LineHeight: 18}, StyleFunc: ui.Colored(colors.Text)},
				core.Text{Content: T("信任后可以随时在项目右键菜单里撤销。"),
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
			}}},
			Footer: []core.Node{
				ui.Button{Text: T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "trust-cancel",
					OnPress: func() { a.trustOpen.Set(false) }},
				ui.Button{Text: T("信任并继续"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "trust-ok",
					OnPress: a.confirmTrust},
			},
		}
	})
}

// trustBar is the warning over an untrusted project's composer.
func (a *app) trustBar(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		ws := a.workspaceOf(s.WS)
		if ws == nil || a.projectTrusted(ws) {
			return nil
		}
		colors := ui.ColorsOf(cx)
		return core.View{TestID: "trust-bar", StyleFunc: func() core.Style {
			return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, Padding: core.Symmetric(7, 12),
				// Opaque under the tint: the bar floats over the transcript,
				// and a wallpaper's see-through panels would let it read
				// through the words.
				Background: ui.Mix(ui.Alpha(colors.Surface(), 1), colors.Warn(), 0.10),
				Borders:    core.Edges{Top: 1}, BorderColors: core.EdgeColors{Top: ui.Alpha(colors.Warn(), 0.30)}}
		}, Children: []core.Node{
			ui.Icon(lucide.ShieldAlert, 13, colors.Warn),
			core.Text{Content: T("这个项目还没有被信任，pi 会在里面读写文件。"),
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
			ui.Button{Text: T("信任"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "trust-project",
				OnPress: func() { a.trustProject(ws) }},
		}}
	})
}
