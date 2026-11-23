//go:build !js && !android && !ios

package workbench

// The strips above the composer: the to-do list the agent keeps, a plan's
// steps while it runs, and the lines extensions publish as widgets; and
// the goal the session is working toward, with its rounds and its pause.

import (
	"fmt"
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/icons/lucide"
	"github.com/nsgo-dev/nsgo/ui"
)

// widgetTodoKeys are the widget keys whose lines are a to-do list.
var widgetTodoKeys = []string{"pi-deck-todo", "pi-deck-plan-todos"}

// widgetGoalKey is the widget key a goal publishes.
const widgetGoalKey = "pi-deck-goal"

// bumpSessionUI redraws what reads the session's plain fields, such as a
// plan's progress or an extension's widget lines.
func (a *app) bumpSessionUI(s *session) {
	if s != nil && s.uiSeq != nil {
		s.uiSeq.Update(func(n int) int { return n + 1 })
	}
}

// sessionTodos is what the strip shows: the agent's own task list, the
// plan's steps while it runs, and the lines extensions publish.
func (a *app) sessionTodos(s *session) []todoItem {
	if s == nil {
		return nil
	}
	var out []todoItem
	seen := map[string]bool{}
	add := func(items []todoItem) {
		for _, it := range items {
			key := it.Text + "\x00" + it.Status
			if it.Text == "" || seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, it)
		}
	}
	// An extension that publishes the list itself owns it: its lines are
	// the plan as it stands now, where the calls the app read may only
	// have patched a single item. Without one, the calls are all there is.
	published := false
	for _, key := range widgetTodoKeys {
		items := parseWidgetTodos(s.extWidgets[key])
		if len(items) == 0 {
			continue
		}
		published = true
		add(items)
	}
	if !published {
		add(s.todos.Get())
	}
	add(planTodos(s))
	return out
}

// planTodos is the plan the session is stepping through, as task lines:
// the steps behind it are done, the next one is in progress.
func planTodos(s *session) []todoItem {
	if s == nil || !s.planActive || len(s.planSteps) == 0 {
		return nil
	}
	out := make([]todoItem, 0, len(s.planSteps))
	for i, step := range s.planSteps {
		status := "pending"
		switch {
		case i <= s.planIndex:
			status = "completed"
		case i == s.planIndex+1:
			status = "in_progress"
		}
		out = append(out, todoItem{Text: step, Status: status})
	}
	return out
}

// parseWidgetTodos reads a widget's lines: ☑ done, ◐ running, ☐ waiting,
// with the progress and section lines PiDeck's extensions write left out.
func parseWidgetTodos(lines []string) []todoItem {
	var out []todoItem
	for _, raw := range lines {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "[[") {
			continue
		}
		if strings.HasPrefix(line, "计划进度") || strings.HasPrefix(line, "计划草案") ||
			strings.HasPrefix(line, "──") || strings.HasPrefix(line, "Plan:") || strings.HasPrefix(line, "计划：") {
			continue
		}
		if isRatioLine(line) {
			continue
		}
		status := "pending"
		switch {
		case strings.HasPrefix(line, "☑") || strings.HasPrefix(line, "[x]") || strings.HasPrefix(line, "[X]"):
			status = "completed"
		case strings.HasPrefix(line, "◐") || strings.HasPrefix(line, "⏳"):
			status = "in_progress"
		}
		line = strings.TrimLeft(line, "☑☐◐⏳[]xX ")
		line = strings.TrimSpace(line)
		// "#3 " and "3. " are how the publishers number their lines.
		if strings.HasPrefix(line, "#") {
			if _, rest, ok := strings.Cut(line, " "); ok {
				line = strings.TrimSpace(rest)
			}
		}
		line = strings.TrimLeft(line, "0123456789")
		line = strings.TrimLeft(line, ".)、: ")
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		out = append(out, todoItem{Text: line, Status: status})
	}
	return out
}

// isRatioLine reports whether a line is just a progress count, such as
// "1/3".
func isRatioLine(line string) bool {
	left, right, ok := strings.Cut(line, "/")
	if !ok {
		return false
	}
	if left == "" || right == "" {
		return false
	}
	for _, r := range left + right {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// currentTodoText names what the list is on now: the running item, else
// the first waiting one.
func currentTodoText(items []todoItem) string {
	for _, it := range items {
		if it.Status == "in_progress" {
			return it.Text
		}
	}
	for _, it := range items {
		if it.Status == "pending" {
			return it.Text
		}
	}
	return ""
}

// todoProgressText counts the list by status, the way PiDeck says it.
func todoProgressText(items []todoItem) string {
	done, running, pending := 0, 0, 0
	for _, it := range items {
		switch it.Status {
		case "completed":
			done++
		case "in_progress":
			running++
		case "cancelled":
		default:
			pending++
		}
	}
	var parts []string
	if done > 0 {
		parts = append(parts, fmt.Sprintf(apptext.T("%d 完成"), done))
	}
	if running > 0 {
		parts = append(parts, fmt.Sprintf(apptext.T("%d 进行中"), running))
	}
	if pending > 0 {
		parts = append(parts, fmt.Sprintf(apptext.T("%d 待处理"), pending))
	}
	return strings.Join(parts, " · ")
}

// todoFingerprint names a list so a dismissed strip stays away until the
// list changes again.
func todoFingerprint(items []todoItem) string {
	var b strings.Builder
	for _, it := range items {
		b.WriteString(it.Status)
		b.WriteString("\x00")
		b.WriteString(it.Text)
		b.WriteString("\x01")
	}
	return b.String()
}

// goalStrip is the goal a session works toward: its phase, how many rounds
// it has run, and the way to pause, resume or clear it.
func (a *app) goalStrip(s *session) core.Node {
	return core.Dynamic(func(cx *core.Scope) core.Node {
		if s == nil {
			return nil
		}
		_ = s.uiSeq.Get()
		if modeOf(s) != modeGoal || (s.goalRounds == 0 && !s.goalPaused.Get()) {
			return nil
		}
		colors := ui.ColorsOf(cx)
		paused := s.goalPaused.Get()
		phase := apptext.T("目标进行中")
		tint := colors.Accent
		if paused {
			phase = apptext.T("目标已暂停")
			tint = colors.Warn
		}
		objective := s.goalText
		if q := strings.TrimSpace(objective); q == "" {
			objective = s.draft.Get()
		}
		var controls []core.Node
		if paused {
			controls = append(controls, ui.Button{Text: apptext.T("继续"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "goal-resume", OnPress: func() { a.resumeGoal(s) }})
		} else {
			controls = append(controls, ui.Button{Text: apptext.T("暂停"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
				TestID: "goal-pause", OnPress: func() { a.pauseGoal(s) }})
		}
		controls = append(controls, ui.Button{Text: apptext.T("清除"), Variant: ui.ButtonGhost, Size: ui.SizeSmall,
			TestID: "goal-clear", OnPress: func() {
				a.askConfirm("清除目标", "将停止自动推进并清除这个目标。", "清除", func() {
					a.setAgentMode(s, modeNormal)
					s.goalText = ""
				})
			}})
		return core.View{TestID: "goal-strip", Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 8,
			Margin: core.Edges{Bottom: 6}, Padding: core.Symmetric(5, 10), CornerRadius: 9,
			BorderWidth: 1, BorderColor: colors.Border(), Background: colors.Surface()}, Children: []core.Node{
			ui.Icon(lucide.Target, 12, tint),
			ui.Text(phase, 10.5, ui.Medium, tint),
			ui.Textf(func() string { return apptext.T("%d/%d 轮", s.goalRounds, goalMaxRounds) }, 9.5, ui.Regular, colors.Faint),
			core.Text{Content: viewkit.FirstLine(objective, 72), MaxLines: 1, EllipsizeMode: core.EllipsizeTail,
				Style: core.Style{FlexGrow: 1, FlexShrink: 1, MinWidth: core.Pt(0), FontSize: 11}, StyleFunc: ui.Colored(colors.Muted)},
			core.View{Style: core.Style{Direction: core.Row, AlignItems: core.AlignCenter, Gap: 2, FlexShrink: 0},
				Children: controls},
		}}
	})
}
