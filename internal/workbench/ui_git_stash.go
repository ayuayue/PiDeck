//go:build !js && !android && !ios

package workbench

// The stash list: every entry git keeps, with pop, apply and drop.

import (
	"fmt"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// openGitStashList shows the stash list.
func (a *app) openGitStashList() {
	a.gitStashOpen.Set(true)
	a.gitStashErr.Set("")
	a.gitStashList.Set(nil)
	a.gitStashBusy.Set(true)
	g := a.git.runner()
	go func() {
		list, err := listGitStashes(g)
		a.cx.Post(func() {
			a.gitStashBusy.Set(false)
			if err != nil {
				a.gitStashErr.Set(err.Error())
				return
			}
			a.gitStashList.Set(list)
		})
	}()
}

// gitStashAction pops, applies or drops one stash entry.
func (a *app) gitStashAction(action, ref string) {
	if ref == "" {
		return
	}
	label := map[string]string{"pop": "恢复贮藏", "apply": "应用贮藏", "drop": "删除贮藏"}[action]
	if label == "" {
		label = "贮藏操作"
	}
	a.git.run(label, func(g gitRunner) error {
		_, err := g.exec(120*time.Second, "stash", action, ref)
		return err
	}, func(err error) {
		if err == nil {
			a.openGitStashList()
		}
	})
}

// gitStashDialog lists the stash and acts on one entry.
func (a *app) gitStashDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		busy := a.gitStashBusy.Get()
		list := a.gitStashList.Get()
		var rows []core.Node
		for i, entry := range list {
			idx := i
			item := entry
			rows = append(rows, core.View{TestID: fmt.Sprintf("git-stash-row-%d", i),
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(40),
					Padding: core.Symmetric(4, 6)}, Children: []core.Node{
					ui.Icon(lucide.Archive, 12, colors.Muted),
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 1}, Children: []core.Node{
						core.Text{Content: item.Ref, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10.5}, StyleFunc: ui.Colored(colors.Faint)},
						core.Text{Content: item.Subject, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
							Style: core.Style{FontSize: 11.5}, StyleFunc: ui.Colored(colors.Text)},
					}},
					ui.Button{Text: apptext.T("弹出"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall,
						TestID: fmt.Sprintf("git-stash-pop-%d", idx), Disabled: func() bool { return a.git.busy.Get() != "" },
						OnPress: func() { a.gitStashAction("pop", item.Ref) }},
					ui.Button{Text: apptext.T("应用"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID: fmt.Sprintf("git-stash-apply-%d", idx), Disabled: func() bool { return a.git.busy.Get() != "" },
						OnPress: func() { a.gitStashAction("apply", item.Ref) }},
					ui.Button{Text: apptext.T("删除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						TestID: fmt.Sprintf("git-stash-drop-%d", idx), Disabled: func() bool { return a.git.busy.Get() != "" },
						OnPress: func() { a.gitStashAction("drop", item.Ref) }},
				}})
		}
		var status core.Node
		switch {
		case busy:
			status = core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
				ui.Spinner{Size: 12}, ui.Text(apptext.T("正在读取贮藏…"), 11.5, ui.Regular, colors.Muted)}}
		case a.gitStashErr.Get() != "":
			status = core.Text{Content: a.gitStashErr.Get(), MaxLines: 3, Style: core.Style{FontSize: 11, LineHeight: 16},
				StyleFunc: ui.Colored(colors.Danger)}
		case len(list) == 0:
			status = core.Text{Content: apptext.T("还没有贮藏。"), Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Faint)}
		}
		return ui.Dialog{
			Open:         a.gitStashOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.gitStashOpen.Set(open) },
			Title:        apptext.T("贮藏"),
			TestID:       "git-stash-dialog",
			Style:        core.Style{Width: a.dialogWidth(), MaxHeight: core.Pt(560)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Text{Content: apptext.T("弹出会恢复并从列表移除；应用保留条目；删除只移除条目。"),
					Style: core.Style{FontSize: 10.5, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				status,
				a.scrollStashFor("gitStashDialog:1").bind(cx, core.Scroll{Style: core.Style{MaxHeight: core.Pt(380)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 1}, Children: rows}}}),
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("贮藏当前改动"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "git-stash-push",
					OnPress: func() {
						a.gitStashOpen.Set(false)
						a.gitStash()
					}},
				core.View{Style: core.Style{FlexGrow: 1}},
				ui.Button{Text: apptext.T("关闭"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "git-stash-close",
					OnPress: func() { a.gitStashOpen.Set(false) }},
			},
		}
	})
}
