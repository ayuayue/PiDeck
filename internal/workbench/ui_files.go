//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"path/filepath"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// drawerFiles is the active workspace's tree.
func (a *app) drawerFiles() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s := a.active()
		if s != nil && s.Target.remote() {
			if ws := a.workspaceFor(s.Target, s.WS); ws != nil {
				return a.targetFileList(ws)
			}
		}
		root := a.files.root.Get()
		if s != nil && s.WS != "" {
			root = s.WS
		}
		if root == "" {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("先打开一个工作区"), 12.5, ui.Regular, colors.Muted),
			}}
		}
		head := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6}, Children: []core.Node{
			ui.Icon(lucide.Folder, 12, colors.Muted),
			core.Text{Content: filepath.Base(root), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FlexGrow: 1, FontSize: 11.5, FontFamily: viewkit.MonoFont()}, StyleFunc: ui.Colored(colors.Muted)},
		}}
		empty := func() core.Node {
			return core.View{Style: core.Style{Padding: core.Symmetric(10, 4)}, Children: []core.Node{
				ui.Text(apptext.T("目录为空"), 11.5, ui.Regular, colors.Faint),
			}}
		}
		// Polls and index completions update their own subtrees. Rebuilding
		// the whole drawer here would discard the input's focus and file
		// rows between a pointer-down and pointer-up.
		marks := core.NewMemoFunc(cx, a.fileMarks, nil)
		dirs := core.NewMemoFunc(cx, func() map[string]bool { return changedDirs(marks.Get(), root) }, nil)
		markColor := func(mark string) core.Color {
			switch gitMarkColor(mark) {
			case "up":
				return colors.Up()
			case "down":
				return colors.Danger()
			case "warn":
				return colors.Warn()
			}
			return colors.Faint()
		}
		list := core.Each(a.files.nodes.Get, func(n fileNode) string { return n.Path }, func(cx *core.Scope, n func() fileNode, _ func() int) core.Node {
			node := n()
			row := core.View{
				OnPress: func(core.PressEvent) {
					if node.Dir {
						a.animateNextLayout()
						a.files.toggle(node.Path)
						return
					}
					a.openEditorFile(root, node.Path)
				},
				Role: core.RoleButton, Label: node.Name, TestID: "file-row",
				StyleFunc: func() core.Style {
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(25),
						Padding: core.Edges{Left: core.Points(4 + node.Depth*13), Right: 6}, CornerRadius: 6,
						Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
						Active: &core.Style{Background: colors.Pressed()}}
				},
				Children: []core.Node{
					core.View{Style: core.Style{Width: core.Pt(12), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter}, Children: []core.Node{
						core.Dynamic(func(*core.Scope) core.Node {
							if !node.Dir {
								return nil
							}
							if n().Expanded {
								return ui.Icon(lucide.ChevronDown, 10, colors.Faint)
							}
							return ui.Icon(lucide.ChevronRight, 10, colors.Faint)
						}),
					}},
					ui.IconOf(func() *core.SVG {
						if node.Dir {
							if n().Expanded {
								return lucide.FolderOpen()
							}
							return lucide.Folder()
						}
						return lucide.FileText()
					}, 12.5, func() core.Color {
						if node.Dir {
							return colors.Muted()
						}
						return colors.Faint()
					}),
					core.Text{Content: node.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12}, StyleFunc: ui.Colored(colors.Text)},
					core.Show{When: func() bool { return node.Dir && dirs.Get()[node.Path] }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Width: core.Pt(5), Height: core.Pt(5), CornerRadius: 3,
							Background: colors.Warn(), FlexShrink: 0}}
					}},
					core.Dynamic(func(*core.Scope) core.Node {
						mark, ok := marks.Get()[node.Path]
						if node.Dir || !ok {
							return nil
						}
						label := mark.mark()
						return core.View{TestID: "file-git-mark", Accessible: true, Label: label,
							Style: core.Style{Width: core.Pt(12), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter},
							Children: []core.Node{core.Text{Content: label, Style: core.Style{FontFamily: viewkit.MonoFont(),
								FontSize: 9.5, FontWeight: ui.Semibold}, StyleFunc: ui.Colored(func() core.Color { return markColor(label) })}}}
					}),
				},
			}
			return base.ContextMenu{
				Trigger:        row,
				Children:       a.fileMenuItems(root, node),
				PopupStyle:     core.Style{MinWidth: core.Pt(200)},
				PopupStyleFunc: func() core.Style { return a.menuCard(a.cx) },
			}
		})
		search := core.Input{Value: a.filesQuery.Get, OnChange: a.filesQuery.Set, Placeholder: apptext.T("筛选文件…"),
			Label: apptext.T("筛选文件"), TestID: "files-search",
			Style: core.Style{Height: core.Pt(28), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11,
				FontFamily: viewkit.MonoFont(), Color: colors.Text(), Background: colors.Field(),
				BorderWidth: 1, BorderColor: colors.FieldBorder()}}
		hits := func() core.Node {
			filter := strings.ToLower(strings.TrimSpace(a.filesQuery.Get()))
			_ = a.filesRev.Get()
			var rows []core.Node
			for _, rel := range a.workspaceFiles(root) {
				if !containsQuery(rel, filter) {
					continue
				}
				rel := rel
				rows = append(rows, core.View{
					OnPress: func(core.PressEvent) { a.openEditorFile(root, filepath.Join(root, filepath.FromSlash(rel))) },
					Role:    core.RoleButton, Label: rel, TestID: "file-hit",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 6, Height: core.Pt(25),
							Padding: core.Symmetric(0, 6), CornerRadius: 6, Transition: viewkit.PressMotion,
							Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()}}
					},
					Children: []core.Node{
						ui.Icon(lucide.FileText, 12, colors.Faint),
						core.Text{Content: rel, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: 11},
							StyleFunc: ui.Colored(colors.Text)},
					},
				})
				if len(rows) >= 60 {
					break
				}
			}
			if len(rows) == 0 {
				rows = append(rows, core.Text{Content: apptext.T("没有匹配的文件"), Style: core.Style{FontSize: 11, Padding: core.Symmetric(8, 4)},
					StyleFunc: ui.Colored(colors.Faint)})
			}
			return core.View{Style: core.Style{Gap: 1}, Children: rows}
		}
		return core.Scroll{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Gap: 4, Padding: core.Edges{Top: 2, Bottom: 20, Right: 2, Left: 2}}, Children: []core.Node{
				head,
				search,
				core.Text{Content: apptext.T("点文件在编辑器里打开，点目录展开；右键可插入 @ 路径。"), Style: core.Style{FontSize: 10.5, LineHeight: 15}, StyleFunc: ui.Colored(colors.Faint)},
				core.Show{When: func() bool { return strings.TrimSpace(a.filesQuery.Get()) != "" }, Then: func(*core.Scope) core.Node { return core.Dynamic(func(*core.Scope) core.Node { return hits() }) }},
				core.Show{When: func() bool { return strings.TrimSpace(a.filesQuery.Get()) == "" }, Then: func(*core.Scope) core.Node {
					return core.Group{
						core.Show{When: func() bool { return len(a.files.nodes.Get()) == 0 }, Then: func(*core.Scope) core.Node { return empty() }},
						list,
					}
				}},
			}},
		}}
	})
}
