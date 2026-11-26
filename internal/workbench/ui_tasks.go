//go:build !js && !android && !ios

package workbench

// The scheduled tasks page and its editor. The list shows what will run
// next and how the last run went; the editor keeps the prompt, the
// project, the backend and the cron expression in one place.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// taskStatusColor picks the status's color.
func taskStatusColor(colors ui.Colors, status string) core.Color {
	switch status {
	case taskOK:
		return colors.Up()
	case taskFailed, taskTimeout, taskInterrupted:
		return colors.Danger()
	case taskRunning:
		return colors.Warn()
	}
	return colors.Faint()
}

// tasksPane lists tasks and recent runs.
func (a *app) tasksPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.taskRev.Get()
		_ = a.langRev.Get()
		if a.env != nil {
			_ = a.env.Get()
		}
		list := a.taskList()
		var rows []core.Node
		for _, item := range list {
			t := item
			rows = append(rows, core.View{TestID: "task-row-" + t.ID,
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 10, MinHeight: core.Pt(56),
					Padding: core.Symmetric(5, 8), CornerRadius: 8},
				Children: []core.Node{
					ui.Switch{Checked: func() bool { return t.Enabled }, Label: apptext.T("启用定时任务"),
						TestID: "task-enabled-" + t.ID, OnChange: func(on bool) { a.toggleTask(t.ID, on) }},
					core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), Gap: 2}, Children: []core.Node{
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 7}, Children: []core.Node{
							core.Text{Content: t.Name, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
								Style:     core.Style{FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 12.5, FontWeight: ui.Medium},
								StyleFunc: ui.Colored(colors.Text)},
							core.View{Style: core.Style{Padding: core.Symmetric(0, 6), CornerRadius: 8,
								Background: colors.Inset()}, Children: []core.Node{
								ui.Text(a.taskBackendLabel(t), 9, ui.Regular, colors.Faint)}},
						}},
						core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8}, Children: []core.Node{
							core.Text{Content: t.Cron, MaxLines: 1, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 10},
								StyleFunc: ui.Colored(colors.Muted)},
							core.Text{Content: a.taskScheduleText(t), MaxLines: 1, Style: core.Style{FontSize: 10.5},
								StyleFunc: ui.Colored(colors.Faint)},
							core.Text{Content: a.taskProjectLabel(t), MaxLines: 1, EllipsizeMode: core.EllipsizeMiddle,
								Style: core.Style{FontSize: 10}, StyleFunc: ui.Colored(colors.Faint)},
						}},
						core.Show{When: func() bool { return t.LastStatus != "" }, Then: func(*core.Scope) core.Node {
							return core.Text{Content: apptext.T("上次 ") + taskStatusLabel(t.LastStatus) + " · " + t.LastRunAt.Format("01-02 15:04"),
								MaxLines: 1, Style: core.Style{FontSize: 10},
								StyleFunc: func() core.Style { return core.Style{Color: taskStatusColor(colors, t.LastStatus)} }}
						}},
					}},
					ui.Button{Text: apptext.T("运行"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "task-run-" + t.ID,
						OnPress: func() { a.runTaskNow(t.ID) }},
					ui.Button{Text: apptext.T("编辑"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "task-edit-" + t.ID,
						OnPress: func() { a.editTask(t.ID) }},
					ui.Button{Text: apptext.T("删除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "task-delete-" + t.ID,
						OnPress: func() {
							a.askConfirm("删除定时任务", "「"+t.Name+"」不再按时间运行；运行历史会一起删除。", "删除", func() {
								a.removeTask(t.ID)
							})
						}},
				}})
		}
		var body core.Node
		if len(rows) == 0 {
			body = core.View{Style: core.Style{FlexGrow: 1, AlignItems: core.AlignCenter, JustifyContent: core.JustifyCenter, Padding: core.Symmetric(30, 8), Gap: 5}, Children: []core.Node{
				ui.Icon(lucide.CalendarClock, 20, colors.Faint),
				core.Text{Content: apptext.T("还没有定时任务。按 cron 建一个，应用在后台按时开会话并发送提示词。"),
					MaxLines: 2, Style: core.Style{FontSize: 11.5, TextAlign: core.TextAlignCenter},
					StyleFunc: ui.Colored(colors.Faint)},
			}}
		} else {
			body = a.scrollStashFor("tasksPane:1").Bind(cx, core.Scroll{Style: ui.FillRest, Children: []core.Node{
				core.View{Style: core.Style{Gap: 1}, Children: rows}}})
		}
		// Recent runs, newest first.
		runs := a.taskRunList()
		var runRows []core.Node
		for i, r := range runs {
			if i >= 8 {
				break
			}
			run := r
			runRows = append(runRows, core.View{TestID: "task-run-row-" + run.ID,
				Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8, MinHeight: core.Pt(30),
					Padding: core.Symmetric(2, 7)}, Children: []core.Node{
					ui.Icon(lucide.Circle, 8, func() core.Color { return taskStatusColor(colors, run.Status) }),
					core.Text{Content: run.TaskName, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{Width: core.Pt(150), FontSize: 11}, StyleFunc: ui.Colored(colors.Text)},
					core.Text{Content: taskStatusLabel(run.Status), MaxLines: 1,
						Style: core.Style{Width: core.Pt(52), FontSize: 10.5}, StyleFunc: ui.Colored(colors.Muted)},
					core.Text{Content: run.StartedAt.Format("01-02 15:04"), MaxLines: 1,
						Style: core.Style{Width: core.Pt(76), FontFamily: viewkit.MonoFont(), FontSize: 9.5}, StyleFunc: ui.Colored(colors.Faint)},
					core.Text{Content: run.Error, MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
						Style:     core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 10},
						StyleFunc: ui.Colored(colors.Faint)},
					core.Show{When: func() bool { return run.SessionID != "" }, Then: func(*core.Scope) core.Node {
						return core.View{OnPress: func(core.PressEvent) { a.openTaskRunSession(run) }, Role: core.RoleButton,
							Label: apptext.T("打开会话"), TestID: "task-run-open-" + run.ID,
							StyleFunc: func() core.Style {
								return core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 3, Height: core.Pt(22),
									Padding: core.Symmetric(0, 6), CornerRadius: 5, Hover: &core.Style{Background: colors.Hover()}}
							}, Children: []core.Node{
								ui.Icon(lucide.ArrowUpRight, 10, colors.Faint),
								ui.Text(apptext.T("打开"), 9.5, ui.Regular, colors.Muted),
							}}
					}},
				}})
		}
		history := core.View{Style: core.Style{FlexShrink: 0, MinWidth: core.Pt(0), Gap: 3}, Children: []core.Node{
			ui.Text(apptext.T("运行历史"), 10, ui.Semibold, colors.Faint),
			core.Show{When: func() bool { return len(runRows) > 0 }, Then: func(*core.Scope) core.Node {
				return core.Scroll{Style: core.Style{MaxHeight: core.Pt(150)}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 0}, Children: runRows}}}
			}},
			core.Show{When: func() bool { return len(runRows) == 0 }, Then: func(*core.Scope) core.Node {
				return core.Text{Content: apptext.T("还没有运行记录。"), Style: core.Style{FontSize: 10.5},
					StyleFunc: ui.Colored(colors.Faint)}
			}},
		}}

		return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, MinHeight: core.Pt(0)}, Children: []core.Node{
			a.paneHeader("定时任务", "按 cron 在后台开始一个新会话并发送提示词；pi 与 ACP 都能跑，运行记录留在本机。",
				ui.Button{Text: apptext.T("新建任务"), Variant: ui.ButtonSecondary, Size: ui.SizeSmall, TestID: "task-new",
					OnPress: a.openTaskForm}),
			core.View{Style: core.Style{Direction: core.Column, Gap: 10, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0),
				Padding: core.Edges{Top: 12, Left: 18, Right: 18, Bottom: 14}}, Children: []core.Node{body, history}},
		}}
	})
}

// openTaskRunSession jumps to the session a run created.
func (a *app) openTaskRunSession(run taskRun) {
	s := a.findSession(run.SessionID)
	if s == nil {
		a.toast(ui.ToastWarning, "找不到这次运行的会话", "它可能已经被删除。")
		return
	}
	a.selectSession(s)
}

// taskFormDialog edits one task.
func (a *app) taskFormDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		_ = a.taskRev.Get()
		_ = a.langRev.Get()
		editing := a.taskEditID.Get()
		title := apptext.T("新建定时任务")
		if editing != "" {
			title = apptext.T("编辑定时任务")
		}
		fieldStyle := core.Style{Height: core.Pt(30), Padding: core.Symmetric(0, 8), CornerRadius: 6, FontSize: 11.5, Overflow: core.Hidden,
			Color: colors.Text(), PlaceholderColor: colors.Muted(), Background: colors.Field(), BorderWidth: 1, BorderColor: colors.FieldBorder()}
		chip := func(on func() bool, label, testID string, press func()) core.Node {
			return core.View{OnPress: func(core.PressEvent) { press() }, Role: core.RoleRadio, Label: label, TestID: testID,
				StyleFunc: func() core.Style {
					st := core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Height: core.Pt(24), MaxWidth: core.Pct(100),
						Padding: core.Symmetric(0, 9), CornerRadius: 12, Hover: &core.Style{Background: colors.Hover()}}
					if on() {
						st.Background = colors.Pressed()
					}
					return st
				},
				Children: []core.Node{core.Text{Content: apptext.T(label), MaxLines: 1,
					Style:     core.Style{FontSize: 10.5, FontWeight: ui.Medium, FlexShrink: 1, MinWidth: core.Pt(0)},
					StyleFunc: ui.Colored(colors.Text)}}}
		}
		cronChip := func(label, expr string) core.Node {
			return chip(func() bool { return a.taskCron.Get() == expr }, label, "task-cron-"+expr,
				func() { a.taskCron.Set(expr) })
		}
		var projectChips []core.Node
		for _, ws := range a.workspaces.Get() {
			w := ws
			projectChips = append(projectChips, chip(func() bool { return a.taskProject.Get() == w.Path },
				w.label(), "task-project-"+w.Path, func() { a.taskProject.Set(w.Path) }))
		}
		var backendChips []core.Node
		backendChips = append(backendChips,
			chip(func() bool { return a.taskBackend.Get() != "acp" }, "pi", "task-backend-pi",
				func() { a.taskBackend.Set("pi") }),
			chip(func() bool { return a.taskBackend.Get() == "acp" }, "ACP", "task-backend-acp",
				func() { a.taskBackend.Set("acp") }),
		)
		var presetChips []core.Node
		for _, p := range a.acpPresetList() {
			preset := p
			presetChips = append(presetChips, chip(func() bool { return a.taskPreset.Get() == preset.ID },
				preset.Name, "task-preset-"+preset.ID, func() { a.taskPreset.Set(preset.ID) }))
		}
		var personaChips []core.Node
		personaChips = append(personaChips, chip(func() bool { return a.taskPersona.Get() == "" },
			"不使用", "task-persona-none", func() { a.taskPersona.Set("") }))
		for _, p := range a.agentList() {
			agent := p
			personaChips = append(personaChips, chip(func() bool { return a.taskPersona.Get() == agent.ID },
				agent.Name, "task-persona-"+agent.ID, func() { a.taskPersona.Set(agent.ID) }))
		}
		errText := a.taskErr.Get()

		return ui.Dialog{
			Open:         a.taskFormOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.taskFormOpen.Set(open) },
			Title:        title,
			TestID:       "task-form",
			Style:        core.Style{Width: a.dialogWidth(), MaxWidth: core.Pt(760)},
			Children: []core.Node{core.Scroll{TestID: "task-form-scroll", Style: core.Style{MinHeight: core.Pt(0), FlexShrink: 1}, Children: []core.Node{
				core.View{Style: core.Style{Gap: 12, Padding: core.Edges{Right: scrollbarGutter, Bottom: 4}}, Children: []core.Node{
					core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
						ui.Text(apptext.T("任务名称"), 10.5, ui.Medium, colors.Muted),
						core.Input{Value: a.taskName.Get, OnChange: a.taskName.Set, Placeholder: apptext.T("例如：每天整理变更"),
							Label: apptext.T("任务名称"), TestID: "task-field-name", Style: fieldStyle},
					}},
					core.View{Style: core.Style{Direction: core.Row, Wrap: core.Wrap, Gap: 10}, Children: []core.Node{
						core.View{Style: core.Style{FlexGrow: 1, FlexBasis: core.Pt(230), MinWidth: core.Pt(0), Gap: 4}, Children: []core.Node{
							ui.Text(apptext.T("cron 表达式"), 10.5, ui.Medium, colors.Muted),
							core.Input{Value: a.taskCron.Get, OnChange: a.taskCron.Set, Placeholder: "0 9 * * *",
								Label: apptext.T("cron 表达式"), TestID: "task-field-cron",
								Style: fieldStyle.Merge(core.Style{FontFamily: viewkit.MonoFont()})},
						}},
						core.View{Style: core.Style{Width: core.Pt(120), Gap: 4}, Children: []core.Node{
							ui.Text(apptext.T("超时分钟"), 10.5, ui.Medium, colors.Muted),
							core.Input{Value: a.taskTimeout.Get, OnChange: a.taskTimeout.Set, Placeholder: "30",
								Label: apptext.T("超时分钟"), TestID: "task-field-timeout", Style: fieldStyle},
						}},
					}},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 4}, Children: []core.Node{
						ui.Text(apptext.T("常用"), 9.5, ui.Regular, colors.Muted),
						cronChip("每小时", "0 * * * *"),
						cronChip("每天 9 点", "0 9 * * *"),
						cronChip("工作日 9 点", "0 9 * * 1-5"),
						cronChip("每周一 9 点", "0 9 * * 1"),
						cronChip("每月 1 号", "0 0 1 * *"),
					}},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 4}, Children: append([]core.Node{
						ui.Text(apptext.T("项目"), 9.5, ui.Regular, colors.Muted)}, projectChips...)},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 4}, Children: append([]core.Node{
						ui.Text(apptext.T("后端"), 9.5, ui.Regular, colors.Muted)}, backendChips...)},
					core.Show{When: func() bool { return a.taskBackend.Get() == "acp" }, Then: func(*core.Scope) core.Node {
						return core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 4},
							Children: append([]core.Node{ui.Text(apptext.T("ACP 预设"), 9.5, ui.Regular, colors.Muted)}, presetChips...)}
					}},
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 4}, Children: append([]core.Node{
						ui.Text(apptext.T("智能体"), 9.5, ui.Regular, colors.Muted)}, personaChips...)},
					core.View{Style: core.Style{Gap: 4}, Children: []core.Node{
						ui.Text(apptext.T("任务提示词"), 10.5, ui.Medium, colors.Muted),
						core.Input{Value: a.taskPrompt.Get, OnChange: a.taskPrompt.Set, Multiline: true,
							Placeholder: apptext.T("每次运行时发给会话的提示词。"),
							Label:       apptext.T("任务提示词"), TestID: "task-field-prompt",
							Style: core.Style{MinHeight: core.Pt(130), Padding: core.Symmetric(7, 9), CornerRadius: 6, FontSize: 12,
								LineHeight: 18, Color: colors.Text(), PlaceholderColor: colors.Muted(), Background: colors.Field(),
								BorderWidth: 1, BorderColor: colors.FieldBorder()}},
					}},
				}}}}},
			Footer: []core.Node{core.View{Style: core.Style{FlexGrow: 1, MinWidth: core.Pt(0), Gap: 10}, Children: []core.Node{
				core.Show{When: func() bool { return strings.TrimSpace(errText) != "" }, Then: func(*core.Scope) core.Node {
					return core.Text{Content: a.taskErr.Get(), TestID: "task-form-error", Style: core.Style{FontSize: 10.5},
						StyleFunc: ui.Colored(colors.Danger)}
				}},
				core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Wrap: core.Wrap, Gap: 8}, Children: []core.Node{
					core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, FlexGrow: 1, Gap: 8}, Children: []core.Node{
						ui.Switch{Checked: a.taskEnabled.Get, Label: apptext.T("保存后立即启用"), TestID: "task-field-enabled",
							OnChange: a.taskEnabled.Set},
						ui.Text(apptext.T("保存后立即启用"), 10.5, ui.Regular, colors.Muted),
					}},
					ui.Button{Text: apptext.T("取消"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
						OnPress: func() { a.taskFormOpen.Set(false) }},
					ui.Button{Text: apptext.T("保存任务"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "task-save",
						OnPress: a.saveTaskForm},
				}},
			}}},
		}
	})
}
