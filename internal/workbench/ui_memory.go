//go:build !js && !android && !ios

package workbench

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

type memoryViewState struct {
	store      *memoryStore
	items      *core.Signal[[]memoryEntry]
	selected   *core.Signal[map[string]bool]
	open, busy *core.Signal[bool]
	query      *core.Signal[string]
	edit       *core.Signal[memoryEntry]
}

func newMemoryView(cx *core.Scope, store *memoryStore) memoryViewState {
	return memoryViewState{store: store, items: core.NewSignalFunc(cx, store.snapshot(), nil),
		selected: core.NewSignalFunc(cx, map[string]bool{}, nil), open: core.NewSignal(cx, false), busy: core.NewSignal(cx, false),
		query: core.NewSignal(cx, ""), edit: core.NewSignal(cx, memoryEntry{})}
}

func (a *app) refreshMemory() {
	a.memory.items.Set(a.memory.store.snapshot())
}

func (a *app) memoryChange(work func() error, done func()) {
	if a.memory.busy.GetUntracked() {
		return
	}
	a.memory.busy.Set(true)
	go func() {
		err := work()
		a.cx.Post(func() {
			a.memory.busy.Set(false)
			if err != nil {
				a.toast(ui.ToastError, "操作失败", err.Error())
				return
			}
			a.refreshMemory()
			if done != nil {
				done()
			}
		})
	}()
}

func (a *app) importMemory() {
	a.cx.PickFiles(core.PickFilesOptions{Types: []string{".yaml", ".yml"}}, func(files []core.File, err error) {
		if err != nil {
			a.toast(ui.ToastError, "导入失败", err.Error())
			return
		}
		if len(files) == 0 || files[0].Path == "" {
			return
		}
		var added int
		file := files[0].Path
		a.memoryChange(func() error {
			entries, err := readMemoryBundle(file)
			if err == nil {
				added, err = a.memory.store.merge(entries)
			}
			return err
		}, func() {
			a.toast(ui.ToastSuccess, "导入完成", apptext.T("已添加 %d 条记忆，保留已有条目。", added))
		})
	})
}

func (a *app) exportMemory() {
	file := filepath.Join(a.dataDir, "exports", "memory-"+a.cx.Now().Format("20060102-150405")+".yaml")
	a.memoryChange(func() error {
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			return err
		}
		return writeMemoryBundle(file, a.memory.store.snapshot())
	}, func() {
		a.toastAction(ui.ToastSuccess, "已导出记忆", file, "打开", func() { a.cx.OpenURL(fileURL(file), nil) })
	})
}

func (a *app) removeSelectedMemories() {
	ids := a.memory.selected.GetUntracked()
	if len(ids) == 0 {
		return
	}
	a.askConfirm("删除记忆", apptext.T("删除选中的 %d 条记忆？", len(ids)), "删除", func() {
		a.memoryChange(func() error {
			return a.memory.store.change(func(list []memoryEntry) ([]memoryEntry, error) {
				return slices.DeleteFunc(list, func(e memoryEntry) bool { return ids[e.ID] }), nil
			})
		}, func() { a.memory.selected.Set(map[string]bool{}) })
	})
}

func (a *app) memoryPane() core.Node {
	return core.Func(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		state := &a.memory
		items := core.NewMemoFunc(cx, func() []memoryEntry {
			query := strings.ToLower(strings.TrimSpace(state.query.Get()))
			list := slices.Clone(state.items.Get())
			list = slices.DeleteFunc(list, func(e memoryEntry) bool { return !strings.Contains(strings.ToLower(e.Title+"\n"+e.Body), query) })
			slices.SortStableFunc(list, func(a, b memoryEntry) int { return b.Updated.Compare(a.Updated) })
			return list
		}, slices.Equal)
		return core.View{Style: ui.FillRest, TestID: "memory-pane", Children: []core.Node{
			a.paneHeader("智能体记忆", "保留项目约定、决策和常用做法。", ui.Button{Text: apptext.T("新建记忆"), TestID: "memory-new", Disabled: state.busy.Get, OnPress: func() {
				state.edit.Set(memoryEntry{ID: newSessionID(), Project: a.draftProject()})
			}}),
			core.Show{When: func() bool { return state.edit.Get().ID != "" }, Then: func(cx *core.Scope) core.Node { return a.memoryEditor(cx) }, Else: func(cx *core.Scope) core.Node {
				return core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Padding: core.All(12), Gap: 8}, Children: []core.Node{
					core.Input{Value: state.query.Get, OnChange: state.query.Set, Placeholder: apptext.T("搜索记忆"), Label: apptext.T("搜索记忆"), TestID: "memory-search", Style: draftFieldStyle(colors)},
					core.List{Count: func() int { return len(items.Get()) }, Key: func(i int) any { return items.Get()[i].ID }, EstimatedSize: 56, Style: ui.FillRest,
						Empty: ui.Text(apptext.T("没有匹配的记忆"), 12, ui.Regular, colors.Muted), Row: func(cx *core.Scope, row core.ListRow) core.Node {
							return core.Dynamic(func(cx *core.Scope) core.Node {
								list, i := items.Get(), row.Index()
								if i < 0 || i >= len(list) {
									return nil
								}
								return a.memoryRow(cx, list[i])
							})
						}},
					core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
						ui.Button{Text: apptext.T("导入"), TestID: "memory-import", Variant: ui.ButtonSecondary, Disabled: state.busy.Get, OnPress: a.importMemory},
						ui.Button{Text: apptext.T("导出"), TestID: "memory-export", Variant: ui.ButtonSecondary, Disabled: state.busy.Get, OnPress: a.exportMemory},
						ui.Button{Text: apptext.T("移除所选"), TestID: "memory-remove", Variant: ui.ButtonGhost, Disabled: func() bool { return state.busy.Get() || len(state.selected.Get()) == 0 }, OnPress: a.removeSelectedMemories},
					}},
				}}
			}},
		}}
	})
}

func (a *app) memoryRow(cx *core.Scope, entry memoryEntry) core.Node {
	label := apptext.T("全局")
	if entry.Project != "" {
		label = apptext.T("项目")
		for _, ws := range a.workspaces.Get() {
			if trustKey(ws) == entry.Project {
				label = ws.label()
				break
			}
		}
	}
	detail := fmt.Sprintf("%s · %s · %s", label, entry.Updated.Local().Format("2006-01-02 15:04"), viewkit.FirstLine(entry.Body, 80))
	row := composerRow(cx, lucide.BookOpen, entry.Title, detail, false, false, func() { a.memory.edit.Set(entry) })
	row.Style.FlexGrow = 1
	row.TestID = "memory-open-" + entry.ID
	return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
		ui.Checkbox{Label: entry.Title, TestID: "memory-select-" + entry.ID, Checked: func() bool { return a.memory.selected.Get()[entry.ID] }, OnChange: func(on bool) {
			a.memory.selected.Update(func(old map[string]bool) map[string]bool {
				next := make(map[string]bool, len(old)+1)
				for k, v := range old {
					next[k] = v
				}
				if on {
					next[entry.ID] = true
				} else {
					delete(next, entry.ID)
				}
				return next
			})
		}}, row,
	}}
}

func (a *app) memoryEditor(cx *core.Scope) core.Node {
	draft := a.memory.edit
	style := draftFieldStyle(ui.ColorsOf(cx))
	bodyStyle := style
	bodyStyle.MinHeight, bodyStyle.FlexGrow, bodyStyle.TextAlignVertical = core.Pt(110), 1, core.TextAlignVerticalTop
	project := a.draftProject()
	return core.View{Style: core.Style{FlexGrow: 1, MinHeight: core.Pt(0), Padding: core.All(12), Gap: 8}, Children: []core.Node{
		core.Input{Value: func() string { return draft.Get().Title }, OnChange: func(title string) { draft.Update(func(e memoryEntry) memoryEntry { e.Title = title; return e }) },
			Placeholder: apptext.T("标题"), Label: apptext.T("标题"), TestID: "memory-title", Style: style},
		core.Input{Value: func() string { return draft.Get().Body }, OnChange: func(body string) { draft.Update(func(e memoryEntry) memoryEntry { e.Body = body; return e }) },
			Placeholder: "Markdown", Label: apptext.T("记忆正文"), TestID: "memory-body", Multiline: true, Style: bodyStyle},
		core.View{Style: core.Style{Direction: core.Row, Gap: 8, Wrap: core.Wrap}, Children: []core.Node{
			ui.ToggleButton{Text: apptext.T("仅当前项目"), TestID: "memory-project", On: func() bool { return draft.Get().Project != "" }, Disabled: func() bool { return project == "" || !draft.Get().Updated.IsZero() }, OnChange: func(on bool) {
				draft.Update(func(e memoryEntry) memoryEntry {
					e.Project = ""
					if on {
						e.Project = project
					}
					return e
				})
			}},
			core.View{Style: core.Style{FlexGrow: 1}},
			ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, TestID: "memory-cancel", OnPress: func() { draft.Set(memoryEntry{}) }},
			ui.Button{Text: apptext.T("保存"), TestID: "memory-save", Disabled: func() bool { return a.memory.busy.Get() || !draft.Get().valid() }, OnPress: func() {
				e := draft.GetUntracked()
				a.memoryChange(func() error { _, err := a.memory.store.put(e); return err }, func() { draft.Set(memoryEntry{}) })
			}},
		}},
	}}
}
