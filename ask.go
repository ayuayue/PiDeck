//go:build !js && !android && !ios

package main

// Parallel inquiry: ask a question in a session of its own while the main
// conversation stays where it is, then bring the answer back. The ask
// session is a normal session, so it keeps its history and can be opened
// afterwards.

import (
	"strings"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

// askBox is the dialog's state.
type askBox struct {
	Open        bool
	WithContext bool
	Busy        bool
	Answer      string
	Err         string
	SessionID   string
	Question    string
}

// askContextTurns is how many turns of the main session the question may
// carry as background.
const askContextTurns = 6

// askContextLimit bounds the background text, in runes.
const askContextLimit = 6000

// openAsk shows the dialog, empty.
func (a *app) openAsk() {
	a.askText.Set("")
	a.askBox.Set(askBox{Open: true, WithContext: true})
}

// startAsk creates a session for the question and sends it there.
func (a *app) startAsk() {
	st := a.askBox.GetUntracked()
	question := strings.TrimSpace(a.askText.GetUntracked())
	if st.Busy {
		return
	}
	if question == "" {
		a.toast(ui.ToastInfo, "先写一个问题", "")
		return
	}
	main := a.active()
	ws := ""
	if main != nil {
		ws = main.WS
	}
	if ws == "" {
		if w := a.activeWorkspace(); w != nil {
			ws = w.Path
		}
	}
	if ws == "" {
		a.toast(ui.ToastInfo, "先选一个项目", "问询会话要在项目里运行。")
		return
	}
	prompt := question
	if st.WithContext && main != nil {
		if ctx := askContextText(main, askContextTurns); ctx != "" {
			prompt = "以下是主会话最近的上下文，只作为背景，不要复述：\n\n" + ctx + "\n问题：" + question
		}
	}
	prev := a.activeID.GetUntracked()
	ns := a.newSession(ws)
	if ns == nil {
		return
	}
	ns.title.Set(T("问询") + " · " + firstLine(question, 30))
	a.askBox.Set(askBox{Open: true, WithContext: st.WithContext, Busy: true,
		SessionID: ns.ID, Question: question})
	a.submit(ns, prompt, nil)
	if prev != "" && a.byID[prev] != nil {
		a.selectSession(a.byID[prev])
	}
	a.waitAsk(ns, time.Now().Add(3*time.Minute))
}

// waitAsk checks the ask session on the UI thread until its turn ends.
func (a *app) waitAsk(ns *session, deadline time.Time) {
	a.cx.AfterFunc(400*time.Millisecond, func() {
		st := a.askBox.GetUntracked()
		if !st.Busy || st.SessionID != ns.ID {
			return
		}
		turns := ns.turns.GetUntracked()
		if len(turns) > 0 {
			last := turns[len(turns)-1]
			if !last.running() {
				answer := last.Final
				if answer == "" {
					for i := len(last.Steps) - 1; i >= 0; i-- {
						if last.Steps[i].Text != "" {
							answer = last.Steps[i].Text
							break
						}
					}
				}
				st.Busy = false
				st.Answer = strings.TrimSpace(answer)
				if last.Err != "" {
					st.Err = last.Err
				}
				if st.Answer == "" && st.Err == "" {
					st.Err = "问询没有返回内容"
				}
				a.askBox.Set(st)
				return
			}
		}
		if time.Now().After(deadline) {
			st.Busy = false
			st.Err = "问询超时（3 分钟）"
			a.askBox.Set(st)
			return
		}
		a.waitAsk(ns, deadline)
	})
}

// askContextText is the main session's recent turns as background.
func askContextText(s *session, n int) string {
	return askContextTextFrom(s.turns.GetUntracked(), n)
}

// askContextTextFrom is the pure part, for tests.
func askContextTextFrom(turns []turn, n int) string {
	start := max(0, len(turns)-n)
	var b strings.Builder
	for _, t := range turns[start:] {
		if t.Prompt != "" {
			b.WriteString("用户：" + firstLine(t.Prompt, 600) + "\n")
		}
		if t.Final != "" {
			b.WriteString("助手：" + firstLine(t.Final, 600) + "\n")
		}
	}
	out := strings.TrimSpace(b.String())
	runes := []rune(out)
	if len(runes) > askContextLimit {
		out = string(runes[len(runes)-askContextLimit:])
	}
	return out
}

// insertAskAnswer puts the answer in the main composer as a quote.
func (a *app) insertAskAnswer() {
	st := a.askBox.GetUntracked()
	answer := strings.TrimSpace(st.Answer)
	if answer == "" {
		return
	}
	s := a.active()
	if s == nil {
		a.copyText(answer, "问询答案")
		return
	}
	var b strings.Builder
	if st.Question != "" {
		b.WriteString("> 问询：" + firstLine(st.Question, 120) + "\n\n")
	}
	b.WriteString(answer)
	draft := s.draft.GetUntracked()
	if draft != "" && !strings.HasSuffix(draft, "\n") {
		draft += "\n\n"
	}
	s.draft.Set(draft + b.String())
	a.askBox.Set(askBox{})
	a.toast(ui.ToastInfo, "答案已放进输入框", "可以改完再发。")
}

// copyAskAnswer copies the answer.
func (a *app) copyAskAnswer() {
	st := a.askBox.GetUntracked()
	if strings.TrimSpace(st.Answer) == "" {
		return
	}
	a.copyText(st.Answer, "问询答案")
}

// openAskSession shows the session the question ran in.
func (a *app) openAskSession() {
	st := a.askBox.GetUntracked()
	s := a.byID[st.SessionID]
	if s == nil {
		return
	}
	a.askBox.Set(askBox{})
	a.selectSession(s)
}

// askStatus is the line under the field: busy, an error, or nothing.
func askStatus(st askBox) string {
	if st.Busy {
		return "正在另一个会话里问…"
	}
	if st.Err != "" {
		return "失败：" + st.Err
	}
	return ""
}
