//go:build !js && !android && !ios

package workbench

// The window: a rail of projects and sessions, a bar of session tabs, the
// chat, and a drawer for the session's numbers and the project's files.

import (
	"path/filepath"
	"strings"

	"example.com/pideck/internal/apptext"
	"example.com/pideck/internal/viewkit"
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
		if ws := a.activeWorkspace(); ws != nil && ws.Target.remote() {
			return a.targetFileList(ws)
		}
		root := a.files.root.Get()
		if s != nil && (s.Target.remote() || !samePath(s.WS, root)) {
			s = nil
		}
		if root == "" {
			return core.View{Style: core.Style{Padding: core.All(16)}, Children: []core.Node{
				ui.Text(apptext.T("先打开一个工作区"), viewkit.PanelTextSize, ui.Regular, colors.Muted),
			}}
		}
		head := core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
			ui.Icon(lucide.Folder, viewkit.PanelIconSize, colors.Muted),
			core.Text{Content: filepath.Base(root), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: viewkit.PanelTitleSize, FontWeight: ui.Medium, LineHeight: 24}, StyleFunc: ui.Colored(colors.Text)},
			hint(apptext.T("在文件管理器中打开工作区"), ui.IconButton{Icon: lucide.FolderOpen, Label: apptext.T("在文件管理器中打开工作区"), Size: viewkit.PanelControlSize, IconSize: viewkit.PanelIconSize, TestID: "files-open-folder", OnPress: func() { a.revealFileBrowserRoot(root) }}),
			ui.IconButton{Icon: lucide.RefreshCw, Label: apptext.T("刷新文件"), Size: viewkit.PanelControlSize, IconSize: viewkit.PanelIconSize, TestID: "files-refresh", OnPress: a.refreshFileBrowser},
			ui.IconButton{Icon: func() *core.SVG {
				if a.files.hidden.Get() {
					return lucide.Eye()
				}
				return lucide.EyeOff()
			}, Label: apptext.T("显示隐藏文件"), Selected: a.files.hidden.Get,
				Disabled: func() bool { return a.files.scope.Get() == "session" }, Size: viewkit.PanelControlSize, IconSize: viewkit.PanelIconSize, TestID: "files-hidden", Tint: func() core.Color {
					if a.files.hidden.Get() {
						return colors.Text()
					}
					return colors.Muted()
				}, OnPress: func() { a.files.setHidden(!a.files.hidden.Get()) }},
			ui.IconButton{Icon: lucide.ChevronsUp, Label: apptext.T("收起全部"), Size: viewkit.PanelControlSize, IconSize: viewkit.PanelIconSize, TestID: "files-collapse", OnPress: a.files.collapse,
				Disabled: func() bool { return a.files.scope.Get() == "session" || strings.TrimSpace(a.filesQuery.Get()) != "" }},
		}}
		empty := func() core.Node {
			return core.View{Style: core.Style{Padding: core.Symmetric(10, 4)}, Children: []core.Node{
				ui.Text(apptext.T("目录为空"), viewkit.PanelCaptionSize, ui.Regular, colors.Muted),
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
					return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(viewkit.PanelRowHeight),
						Padding: core.Edges{Top: 6, Bottom: 6, Left: 4 + core.Points(node.Depth)*viewkit.PanelInset, Right: 8}, CornerRadius: 6,
						Transition: viewkit.PressMotion, Hover: &core.Style{Background: colors.Hover()},
						Active: &core.Style{Background: colors.Pressed()}, FocusVisible: ui.FocusRing(cx, 2)}
				},
				Children: []core.Node{
					core.View{Style: core.Style{Width: core.Pt(12), AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter}, Children: []core.Node{
						core.Dynamic(func(*core.Scope) core.Node {
							if !node.Dir {
								return nil
							}
							if n().Expanded {
								return ui.Icon(lucide.ChevronDown, 12, colors.Faint)
							}
							return ui.Icon(lucide.ChevronRight, 12, colors.Faint)
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
					}, viewkit.PanelDetailIconSize, func() core.Color {
						if node.Dir {
							return colors.Muted()
						}
						return colors.Faint()
					}),
					core.Text{Content: node.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight}, StyleFunc: ui.Colored(colors.Text)},
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
								FontSize: viewkit.PanelMicroSize, FontWeight: ui.Medium}, StyleFunc: ui.Colored(func() core.Color { return markColor(label) })}}}
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
			Style: core.Style{Height: core.Pt(viewkit.PanelFieldHeight), Padding: core.Symmetric(0, 12), CornerRadius: 8,
				FontSize: viewkit.PanelTextSize, LineHeight: viewkit.PanelLineHeight},
			StyleFunc: func() core.Style {
				return core.Style{Color: colors.Text(), Background: colors.Field(), PlaceholderColor: colors.Muted(),
					CaretColor: colors.Text(), SelectionColor: colors.Now().Selection, BorderWidth: 1,
					BorderColor: colors.FieldBorder(), FocusVisible: ui.FocusRing(cx, 2)}
			}}
		hits := func() core.Node {
			filter := strings.ToLower(strings.TrimSpace(a.filesQuery.Get()))
			_ = a.filesRev.Get()
			var rows []core.Node
			for _, rel := range a.sortedWorkspacePaths(root, a.workspaceFiles(root)) {
				if !containsQuery(rel, filter) {
					continue
				}
				rel := rel
				rows = append(rows, core.View{
					OnPress: func(core.PressEvent) { a.openEditorFile(root, filepath.Join(root, filepath.FromSlash(rel))) },
					Role:    core.RoleButton, Label: rel, TestID: "file-hit",
					StyleFunc: func() core.Style {
						return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(viewkit.PanelRowHeight),
							Padding: core.Symmetric(6, 8), CornerRadius: 6, Transition: viewkit.PressMotion,
							Hover: &core.Style{Background: colors.Hover()}, Active: &core.Style{Background: colors.Pressed()},
							FocusVisible: ui.FocusRing(cx, 2)}
					},
					Children: []core.Node{
						ui.Icon(lucide.FileText, viewkit.PanelDetailIconSize, colors.Muted),
						core.Text{Content: rel, MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
							Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontFamily: viewkit.MonoFont(), FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight},
							StyleFunc: ui.Colored(colors.Text)},
					},
				})
				if len(rows) >= 60 {
					break
				}
			}
			if len(rows) == 0 {
				rows = append(rows, core.Text{Content: apptext.T("没有匹配的文件"), Style: core.Style{FontSize: viewkit.PanelCaptionSize, LineHeight: viewkit.PanelLineHeight, Padding: core.Symmetric(8, 4)},
					StyleFunc: ui.Colored(colors.Muted)})
			}
			return core.View{Style: core.Style{Gap: 1}, Children: rows}
		}
		return core.View{Style: ui.FillRest, Children: []core.Node{
			core.View{Style: core.Style{Gap: viewkit.PanelGap, Padding: core.Edges{Bottom: viewkit.PanelGap}}, Children: []core.Node{
				hintOf(func() string { return root }, head), search, a.fileScopeTabs(), a.fileSortControl(),
			}},
			core.Show{When: func() bool { return a.files.scope.Get() == "session" }, Then: func(cx *core.Scope) core.Node { return a.sessionFiles(cx, s, root) }},
			core.Show{When: func() bool { return a.files.scope.Get() != "session" }, Then: func(cx *core.Scope) core.Node {
				return a.scrollStashFor("drawerFiles:1").Bind(cx, core.Scroll{TestID: "files-scroll", Style: ui.FillRest, Children: []core.Node{
					core.View{Style: core.Style{Gap: 4, Padding: core.Edges{Bottom: 20, Right: 2, Left: 2}}, Children: []core.Node{
						core.Show{When: func() bool { return strings.TrimSpace(a.filesQuery.Get()) != "" }, Then: func(*core.Scope) core.Node { return core.Dynamic(func(*core.Scope) core.Node { return hits() }) }},
						core.Show{When: func() bool { return strings.TrimSpace(a.filesQuery.Get()) == "" }, Then: func(*core.Scope) core.Node {
							return core.Group{
								core.Show{When: func() bool { return len(a.files.nodes.Get()) == 0 }, Then: func(*core.Scope) core.Node { return empty() }},
								list,
							}
						}},
					}},
				}})
			}},
		}}
	})
}
