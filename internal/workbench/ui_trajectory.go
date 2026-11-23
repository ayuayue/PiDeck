//go:build !js && !android && !ios

package workbench

import (
	"fmt"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

type trajectoryView struct {
	turn    turn
	prompts []string
	busy    bool
	err     string
}

func (a *app) openTrajectory(s *session, t turn) {
	v := &trajectoryView{turn: t, busy: s.File != "" && !s.Target.remote() && !s.External && s.backend != "acp"}
	a.trajectory.Set(v)
	a.openPane(paneTrajectory)
	if !v.busy {
		return
	}
	file := s.File
	go func() {
		prompts, err := readTrajectory(file, t.sourceEntryID, t.Start)
		a.cx.Post(func() {
			if a.trajectory.GetUntracked() != v {
				return
			}
			next := &trajectoryView{turn: t, prompts: prompts}
			if err != nil {
				next.err = err.Error()
			}
			a.trajectory.Set(next)
		})
	}()
}

// trajectoryPane shows what a turn actually ran on: the system prompts it
// was given, its usage and the tools it called.
func (a *app) trajectoryPane() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		v := a.trajectory.Get()
		if v == nil {
			return core.View{Style: ui.FillRest}
		}
		colors := ui.ColorsOf(cx)
		t := v.turn
		usage := t.Usage
		var metrics []core.Node
		if t.Model != "" {
			metrics = append(metrics, setRow("模型", t.Model, nil))
		}
		metrics = append(metrics, setRow("用时", duration(t.elapsed(a.cx.Now())), nil),
			setRow("Token 用量", apptext.T("输入 %s · 输出 %s · 缓存读取 %s · 缓存写入 %s", viewkit.Tokens(usage.Input), viewkit.Tokens(usage.Output), viewkit.Tokens(usage.CacheRead), viewkit.Tokens(usage.CacheWrite)), nil))
		var prompts []core.Node
		switch {
		case v.busy:
			prompts = append(prompts, ui.Spinner{Size: 14})
		case v.err != "":
			prompts = append(prompts, ui.Text(v.err, 12, ui.Regular, colors.Danger))
		case len(v.prompts) == 0:
			prompts = append(prompts, ui.Text(apptext.T("这轮没有记录系统提示词。"), 12, ui.Regular, colors.Muted))
		default:
			for _, text := range v.prompts {
				prompts = append(prompts, core.Text{Content: text, Selectable: core.SelectableOn, Style: core.Style{FontFamily: viewkit.MonoFont(), FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Text)})
			}
		}
		var tools []core.Node
		for _, step := range t.Steps {
			for _, run := range step.Tools {
				if len(tools) >= 80 {
					break
				}
				help := run.Detail
				if run.DurationMs > 0 {
					help += fmt.Sprintf(" · %d ms", run.DurationMs)
				}
				tools = append(tools, setRow(run.Name, help, nil))
				for i, child := range run.Nested {
					if i == 20 || len(tools) >= 80 {
						break
					}
					tools = append(tools, core.Text{Content: child, MaxLines: 2, Style: core.Style{Padding: core.Edges{Left: 14}, FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)})
				}
			}
		}
		rows := []core.Node{core.Group(metrics), setGroup("系统提示词", prompts...)}
		if len(tools) > 0 {
			rows = append(rows, setGroup("工具调用", tools...))
		}
		return core.View{Style: core.Style{Direction: core.Column, FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0)},
			Children: []core.Node{
				a.paneHeader("查看轨迹", "这一轮实际使用的系统提示词、用量与工具调用"),
				core.View{Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinHeight: core.Pt(0), Padding: core.Symmetric(10, 0)},
					Children: []core.Node{core.Scroll{Style: ui.FillRest, Children: []core.Node{
						core.View{Style: core.Style{Gap: 10, Padding: core.Edges{Bottom: 16}}, Children: rows}}}}},
			}}
	})
}

func (a *app) trajectorySetting() core.Node {
	return setRow("记录系统提示词", "在应用自己的本机 pi 会话中记录每轮实际使用的系统提示词。开启后重启 Agent 生效。",
		ui.Switch{Label: apptext.T("记录系统提示词"), TestID: "record-trajectory", Checked: func() bool { return a.cfg.RecordTrajectory }, OnChange: func(on bool) {
			a.cfg.RecordTrajectory = on
			a.st.edit(func(c *config) { c.RecordTrajectory = on })
			a.bumpSettings()
		}})
}
