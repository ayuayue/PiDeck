//go:build !js && !android && !ios

package workbench

import (
	"context"
	"path"
	"slices"
	"strings"
	"time"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

func (a *app) targetFileList(ws *workspace) core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		files := core.NewSignalFunc(cx, []string(nil), slices.Equal)
		busy, problem := core.NewSignal(cx, true), core.NewSignal(cx, "")
		query := core.NewSignal(cx, "")
		var cancel context.CancelFunc
		cx.Cleanup(func() {
			if cancel != nil {
				cancel()
			}
		})
		refresh := func() {
			if cancel != nil {
				cancel()
			}
			ctx, stop := context.WithTimeout(context.Background(), 15*time.Second)
			cancel = stop
			busy.Set(true)
			problem.Set("")
			go func() {
				defer stop()
				list, err := ws.Target.targetFiles(ctx, ws.Path)
				if ctx.Err() == context.Canceled {
					return
				}
				cx.Post(func() {
					busy.Set(false)
					if err != nil {
						problem.Set(fileEditorError(err))
						return
					}
					files.Set(list)
				})
			}()
		}
		refresh()
		shown := core.NewMemoFunc(cx, func() []string {
			q := strings.ToLower(strings.TrimSpace(query.Get()))
			if q == "" {
				return files.Get()
			}
			return slices.DeleteFunc(slices.Clone(files.Get()), func(f string) bool { return !containsQuery(f, q) })
		}, slices.Equal)
		return core.View{TestID: "target-files", Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Gap: 6}, Children: []core.Node{
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 4}, Children: []core.Node{
				core.Input{Value: query.Get, OnChange: query.Set, Label: apptext.T("筛选文件"), Placeholder: apptext.T("筛选文件…"),
					TestID: "target-files-filter", Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Height: core.Pt(30),
						Padding: core.Symmetric(0, 8), CornerRadius: ui.RadiusControl, Color: colors.Text(), Background: colors.Field()}},
				ui.IconButton{Icon: lucide.RefreshCw, Label: apptext.T("刷新"), TestID: "target-files-refresh", Disabled: busy.Get, OnPress: refresh},
			}},
			core.Show{When: busy.Get, Then: func(*core.Scope) core.Node { return ui.Spinner{Size: 14} }},
			core.Text{ContentFunc: problem.Get, MaxLines: 2, Style: core.Style{FontSize: 11}, StyleFunc: ui.Colored(colors.Danger)},
			core.List{Style: ui.FillRest.Merge(core.Style{Padding: core.Edges{Right: viewkit.PanelInset}}), Count: func() int { return len(shown.Get()) }, EstimatedSize: 32,
				Key: func(i int) any { return shown.Get()[i] },
				Row: func(cx *core.Scope, row core.ListRow) core.Node {
					return core.Dynamic(func(cx *core.Scope) core.Node {
						i, list := row.Index(), shown.Get()
						if i < 0 || i >= len(list) {
							return nil
						}
						rel := list[i]
						item := composerRow(cx, lucide.FileText, path.Base(rel), rel, false, false, func() {
							a.activePane.Set("")
							a.editor.openWorkspaceFile(path.Join(ws.Path, rel), workspaceFile{target: ws.Target, root: ws.Path, rel: rel})
						})
						item.Label, item.TestID = rel, "target-file"
						return item
					})
				}},
		}}
	})
}
