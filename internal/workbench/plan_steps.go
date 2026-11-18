//go:build !js && !android && !ios

package workbench

// Step-by-step plan execution: a plan's numbered steps are sent one at a
// time, and the user decides between steps whether to go on. The decision
// comes from the turn.done event, so it works for pi and ACP alike.

import (
	"fmt"
	"regexp"
	"strings"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/base"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

// planStepLine matches a numbered or bulleted step.
var planStepLine = regexp.MustCompile(`^\s*(?:\d{1,2}[.、)]|[-*•])\s+(.+)$`)

// planSteps pulls the steps out of a plan's Markdown.
func planSteps(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		m := planStepLine.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil {
			continue
		}
		step := strings.TrimSpace(m[1])
		step = strings.TrimPrefix(step, "**")
		step = strings.TrimSuffix(step, "**")
		step = strings.TrimSpace(step)
		if step == "" {
			continue
		}
		out = append(out, viewkit.FirstLine(step, 400))
		if len(out) >= 20 {
			break
		}
	}
	return out
}

// planAdvance says what follows a plan step's turn.
type planAdvance int

const (
	planGoOn planAdvance = iota
	planFinished
	planStopped
)

// planNext decides what follows a step given the turn's status.
func planNext(s *session, status string) planAdvance {
	if s == nil || !s.planActive {
		return planStopped
	}
	if status != "completed" {
		return planStopped
	}
	if s.planIndex+1 >= len(s.planSteps) {
		return planFinished
	}
	return planGoOn
}

// planStepPrompt wraps one step with its place in the plan.
func planStepPrompt(s *session) string {
	if s == nil || s.planIndex < 0 || s.planIndex >= len(s.planSteps) {
		return ""
	}
	return apptext.T("按计划执行第 %d/%d 步，只做这一步，完成后停下：", s.planIndex+1, len(s.planSteps)) +
		"\n\n" + s.planSteps[s.planIndex]
}

// executePlanSteps starts a plan one step at a time.
func (a *app) executePlanSteps(s *session, t turn) {
	if s == nil || t.running() || t.Final == "" {
		return
	}
	steps := planSteps(t.Final)
	if len(steps) < 2 {
		a.toast(ui.ToastInfo, "这个计划没有可逐步执行的步骤", "计划里至少要有两条编号或列表项。")
		return
	}
	s.planSteps, s.planIndex, s.planActive = steps, 0, true
	a.bumpSessionUI(s)
	a.runPlanStep(s)
}

// runPlanStep sends the current step.
func (a *app) runPlanStep(s *session) {
	if s == nil || !s.planActive {
		return
	}
	if s.planIndex < 0 || s.planIndex >= len(s.planSteps) {
		return
	}
	a.submitTurn(s, planStepPrompt(s), nil, false)
}

// onPlanTurn moves the plan along when a step's turn ends.
func (a *app) onPlanTurn(ev appEvent) {
	s := ev.Session
	if s == nil || !s.planActive {
		return
	}
	switch planNext(s, ev.Data["status"]) {
	case planStopped:
		s.planActive = false
		s.planSteps = nil
		a.bumpSessionUI(s)
		a.emit(eventPlanFinished, appEvent{Session: s, Data: map[string]string{"status": "stopped"}})
		a.toast(ui.ToastWarning, "逐步执行已停止", "这一轮没有完成。")
	case planFinished:
		steps := s.planIndex + 1
		s.planActive = false
		s.planSteps = nil
		a.bumpSessionUI(s)
		a.emit(eventPlanFinished, appEvent{Session: s, Data: map[string]string{"status": "finished", "steps": fmt.Sprintf("%d", steps)}})
		a.toast(ui.ToastSuccess, "计划执行完毕", fmt.Sprintf("共 %d 步。", steps))
	case planGoOn:
		a.planAskSession = s
		a.planAskOpen.Set(true)
	}
}

// continuePlan sends the next step.
func (a *app) continuePlan() {
	s := a.planAskSession
	a.planAskSession = nil
	a.planAskOpen.Set(false)
	if s == nil || !s.planActive {
		return
	}
	s.planIndex++
	a.bumpSessionUI(s)
	a.runPlanStep(s)
}

// stopPlan ends step-by-step execution.
func (a *app) stopPlan() {
	if s := a.planAskSession; s != nil {
		s.planActive = false
		s.planSteps = nil
		a.bumpSessionUI(s)
	}
	a.planAskSession = nil
	a.planAskOpen.Set(false)
	a.toast(ui.ToastInfo, "已停止逐步执行", "")
}

// planAskDialog asks whether to run the next step.
func (a *app) planAskDialog() core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		colors := ui.ColorsOf(cx)
		s := a.planAskSession
		step, next, total := "", 0, 0
		if s != nil {
			next = s.planIndex + 2
			total = len(s.planSteps)
			if s.planIndex+1 < len(s.planSteps) {
				step = s.planSteps[s.planIndex+1]
			}
		}
		return ui.Dialog{
			Open:         a.planAskOpen.Get,
			OnOpenChange: func(open bool, _ base.Reason) { a.planAskOpen.Set(open) },
			Title:        apptext.T("继续下一步？"),
			TestID:       "plan-ask",
			Style:        core.Style{Width: core.Pt(460)},
			Children: []core.Node{core.View{Style: core.Style{Gap: 8}, Children: []core.Node{
				core.Text{Content: apptext.T("第 %d 步完成，共 %d 步。下一步：", next-1, total),
					Style: core.Style{FontSize: 11, LineHeight: 16}, StyleFunc: ui.Colored(colors.Faint)},
				core.View{StyleFunc: func() core.Style {
					return core.Style{Padding: core.Symmetric(8, 10), CornerRadius: 8, Background: colors.Inset(),
						BorderWidth: 1, BorderColor: colors.Line()}
				}, Children: []core.Node{
					core.Text{Content: step, MaxLines: 6, EllipsizeMode: core.EllipsizeTail,
						Style: core.Style{FontSize: 12.5, LineHeight: 19}, StyleFunc: ui.Colored(colors.Text)},
				}},
			}}},
			Footer: []core.Node{
				ui.Button{Text: apptext.T("停止"), Variant: ui.ButtonGhost, Size: ui.SizeSmall, TestID: "plan-stop", OnPress: a.stopPlan},
				ui.Button{Text: apptext.T("继续"), Variant: ui.ButtonPrimary, Size: ui.SizeSmall, TestID: "plan-continue", OnPress: a.continuePlan},
			},
		}
	})
}
