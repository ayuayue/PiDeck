//go:build !js && !android && !ios

package workbench

// The ask card's state: which question is showing, what was typed in each
// field, what was answered or skipped, and how the answers go back to the
// extension. The card shows one request at a time and keeps the others
// behind it, as PiDeck does: answering one brings the next up.

import (
	"encoding/json"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/ui"
)

// askAutoTimeout is how long a request waits when the extension set none.
// pi itself blocks on it, so the window lets it go after long enough for
// anyone to read the question.
const askAutoTimeout = 30 * time.Minute

// ask is the request the session shows, nil when none.
func (s *session) showingAsk() *extensionAsk {
	if s == nil || s.ask == nil {
		return nil
	}
	return s.ask.Get()
}

// enqueueAsk shows ask now when nothing else is up, else keeps it behind
// what is.
func (a *app) enqueueAsk(s *session, ask *extensionAsk) {
	if s == nil || ask == nil {
		return
	}
	if s.showingAsk() == nil {
		a.showAsk(s, ask)
	} else {
		s.asks = append(s.asks, ask)
	}
	a.countAsks(s)
}

// showAsk puts ask on the card with an empty answer sheet.
func (a *app) showAsk(s *session, ask *extensionAsk) {
	state := askUIState{Answers: map[string]askAnswer{}}
	if ask.Title == "" && ask.Method == remotewire.AskMethodBatch && len(ask.Questions) > 0 {
		ask.Title = ask.Questions[0].Question
	}
	texts := map[string]string{}
	for _, q := range ask.Questions {
		if q.Prefill != "" {
			// A prefill is a starting point, not an answer: it counts
			// only once the user edits or submits the field.
			texts[q.ID] = q.Prefill
		}
	}
	s.askTexts.Set(texts)
	s.askUI.Set(state)
	s.ask.Set(ask)
	a.bumpAsk()
}

// countAsks keeps the rail's badge in step with what is waiting.
func (a *app) countAsks(s *session) {
	if s == nil || s.askPending == nil {
		return
	}
	n := len(s.asks)
	if s.showingAsk() != nil {
		n++
	}
	s.askPending.Set(n)
}

// bumpAsk redraws the card after its own state changed.
func (a *app) bumpAsk() {
	a.askSeq.Update(func(n int) int { return n + 1 })
}

// popAsk clears the request showing and brings the next one up.
func (a *app) popAsk(s *session, ask *extensionAsk) {
	if s == nil {
		return
	}
	if cur := s.showingAsk(); cur == nil || ask == nil || cur.ID != ask.ID {
		return
	}
	s.ask.Set(nil)
	if len(s.asks) > 0 {
		next := s.asks[0]
		s.asks = s.asks[1:]
		a.showAsk(s, next)
	} else {
		s.askUI.Set(askUIState{})
		s.askTexts.Set(nil)
		a.bumpAsk()
	}
	a.countAsks(s)
}

// dropAsk lets a request go without an answer, after its extension's own
// timeout ended it.
func (a *app) dropAsk(s *session, ask *extensionAsk) {
	if s == nil || ask == nil {
		return
	}
	if cur := s.showingAsk(); cur != nil && cur.ID == ask.ID {
		a.popAsk(s, ask)
		return
	}
	for i, q := range s.asks {
		if q.ID == ask.ID {
			s.asks = append(append([]*extensionAsk(nil), s.asks[:i]...), s.asks[i+1:]...)
			break
		}
	}
	a.countAsks(s)
}

// cancelAsks answers every request a session waits on as cancelled, so pi
// and ACP are never left blocked when the turn is stopped.
func (a *app) cancelAsks(s *session) {
	if s == nil {
		return
	}
	cur := s.showingAsk()
	queued := append([]*extensionAsk(nil), s.asks...)
	s.asks = nil
	if cur != nil {
		s.ask.Set(nil)
		a.answerAskFor(s, cur, map[string]any{"cancelled": true})
	}
	for _, ask := range queued {
		a.answerAskFor(s, ask, map[string]any{"cancelled": true})
	}
	s.askUI.Set(askUIState{})
	s.askTexts.Set(nil)
	a.countAsks(s)
	a.bumpAsk()
}

// chooseAskOption answers a select with one choice.
func (a *app) chooseAskOption(s *session, ask *extensionAsk, opt askOption) {
	if s == nil || ask == nil {
		return
	}
	if ask.Method == remotewire.AskMethodBatch {
		q := askQuestionAt(ask, a.askTab(s))
		if q == nil {
			return
		}
		a.answerBatchQuestion(s, ask, *q, askAnswer{Value: opt.Value, Label: opt.Label})
		return
	}
	a.respondAsk(s, ask, map[string]any{"value": opt.Value})
}

// answerCustom answers a select with text the user wrote instead.
func (a *app) answerCustom(s *session, ask *extensionAsk, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		return
	}
	if ask.Method == remotewire.AskMethodBatch {
		q := askQuestionAt(ask, a.askTab(s))
		if q == nil {
			return
		}
		a.answerBatchQuestion(s, ask, *q, askAnswer{Value: text, Label: text, WasCustom: true})
		return
	}
	a.respondAsk(s, ask, map[string]any{"value": text})
}

// answerConfirm answers a yes/no.
func (a *app) answerConfirm(s *session, ask *extensionAsk, yes bool) {
	if s == nil || ask == nil {
		return
	}
	if ask.Method == remotewire.AskMethodBatch {
		q := askQuestionAt(ask, a.askTab(s))
		if q == nil {
			return
		}
		label := apptext.T("否")
		if yes {
			label = apptext.T("是")
		}
		a.answerBatchQuestion(s, ask, *q, askAnswer{Value: yes, Label: label})
		return
	}
	a.respondAsk(s, ask, map[string]any{"confirmed": yes, "value": yes})
}

// askTab is the question the card shows.
func (a *app) askTab(s *session) int {
	if s == nil || s.askUI == nil {
		return 0
	}
	return s.askUI.GetUntracked().Tab
}

// askQuestionAt is the question at an index, nil when there is none.
func askQuestionAt(ask *extensionAsk, tab int) *askQuestion {
	if ask == nil || tab < 0 || tab >= len(ask.Questions) {
		return nil
	}
	return &ask.Questions[tab]
}

// setAskTab switches the card to a question (or the review page when
// index == len(questions)).
func (a *app) setAskTab(s *session, index int) {
	if s == nil || s.askUI == nil {
		return
	}
	state := s.askUI.GetUntracked()
	if index < 0 {
		index = 0
	}
	if ask := s.showingAsk(); ask != nil {
		total := len(ask.Questions)
		if index > total {
			index = total
		}
		state.Review = index == total && total > 0 && ask.Review
		if index == total && !state.Review {
			index = max(0, total-1)
		}
	}
	state.Tab = index
	s.askUI.Set(state)
	a.bumpAsk()
}

// askText is what a field holds for a question now. It reads the text
// signal, so only the field that shows it redraws as the user types.
func askText(s *session, id string) string {
	if s == nil || s.askTexts == nil {
		return ""
	}
	return s.askTexts.Get()[id]
}

// setAskText records text typed in a question's field.
func (a *app) setAskText(s *session, id, text string) {
	if s == nil || s.askTexts == nil {
		return
	}
	cur := s.askTexts.GetUntracked()
	texts := make(map[string]string, len(cur)+1)
	for k, v := range cur {
		texts[k] = v
	}
	texts[id] = text
	s.askTexts.Set(texts)
}

// toggleMultiSelect flips one choice of a multi_select question.
func (a *app) toggleMultiSelect(s *session, ask *extensionAsk, q askQuestion, opt askOption) {
	if s == nil || s.askUI == nil {
		return
	}
	state := s.askUI.GetUntracked()
	answers := cloneAnswers(state.Answers)
	cur := answers[q.ID]
	var values []string
	if list, ok := cur.Value.([]string); ok {
		values = append(values, list...)
	}
	kept := values[:0]
	found := false
	for _, v := range values {
		if v == opt.Value {
			found = true
			continue
		}
		kept = append(kept, v)
	}
	values = kept
	if !found {
		values = append(values, opt.Value)
	}
	if len(values) == 0 {
		delete(answers, q.ID)
	} else {
		labels := make([]string, 0, len(values))
		for _, v := range values {
			labels = append(labels, askOptionLabel(q, v))
		}
		answers[q.ID] = askAnswer{Value: append([]string(nil), values...), Label: strings.Join(labels, "、")}
	}
	state.Answers = answers
	s.askUI.Set(state)
	a.bumpAsk()
}

// askOptionLabel names one multi_select value for the review page.
func askOptionLabel(q askQuestion, value string) string {
	for _, opt := range q.Options {
		if opt.Value == value {
			return opt.Label
		}
	}
	return value
}

// answerBatchQuestion records one answer and moves on as the type says.
func (a *app) answerBatchQuestion(s *session, ask *extensionAsk, q askQuestion, ans askAnswer) {
	if s == nil || s.askUI == nil {
		return
	}
	state := s.askUI.GetUntracked()
	answers := cloneAnswers(state.Answers)
	answers[q.ID] = ans
	state.Answers = answers
	s.askUI.Set(state)
	if askAutoAdvances(q.Type) {
		a.advanceAsk(s, ask)
	}
	a.bumpAsk()
}

// cloneAnswers copies the answer map so a change is one signal write.
func cloneAnswers(in map[string]askAnswer) map[string]askAnswer {
	out := make(map[string]askAnswer, len(in)+1)
	for k, v := range in {
		out[k] = v
	}
	return out
}

// askAutoAdvances reports whether an answered question moves on by itself.
// Typing questions that keep their field open do not.
func askAutoAdvances(kind string) bool {
	switch kind {
	case askSelect, askConfirm, askInput:
		return true
	}
	return false
}

// advanceAsk moves to the next question, the review page, or the model.
func (a *app) advanceAsk(s *session, ask *extensionAsk) {
	if s == nil || ask == nil {
		return
	}
	tab := a.askTab(s)
	if tab < len(ask.Questions)-1 {
		a.setAskTab(s, tab+1)
		return
	}
	if ask.Review {
		a.setAskTab(s, len(ask.Questions))
		return
	}
	a.submitBatch(s, ask, false)
}

// skipAsk marks the question skipped and always moves on, as PiDeck does.
func (a *app) skipAsk(s *session, ask *extensionAsk) {
	if s == nil || ask == nil || ask.Method != remotewire.AskMethodBatch {
		return
	}
	q := askQuestionAt(ask, a.askTab(s))
	if q == nil {
		return
	}
	state := s.askUI.GetUntracked()
	answers := cloneAnswers(state.Answers)
	answers[q.ID] = askAnswer{Skipped: true}
	state.Answers = answers
	s.askUI.Set(state)
	if tab := a.askTab(s); tab < len(ask.Questions)-1 {
		a.setAskTab(s, tab+1)
	} else if ask.Review {
		a.setAskTab(s, len(ask.Questions))
	} else {
		a.submitBatch(s, ask, false)
	}
	a.bumpAsk()
}

// submitAskField answers an input, editor or custom field with what it
// holds, when it holds anything.
func (a *app) submitAskField(s *session, ask *extensionAsk) {
	if s == nil || ask == nil {
		return
	}
	tab := a.askTab(s)
	q := askQuestionAt(ask, tab)
	if q == nil {
		return
	}
	text := strings.TrimSpace(askText(s, q.ID))
	if text == "" {
		return
	}
	ans := askAnswer{Value: text, Label: text}
	if q.Type == askSelect {
		ans.WasCustom = true
	}
	a.answerBatchQuestion(s, ask, *q, ans)
}

// askAnswered is how many questions are settled, by answer or skip.
func askAnswered(ask *extensionAsk, state askUIState) int {
	n := 0
	for _, q := range ask.Questions {
		if state.Answers[q.ID].answered() {
			n++
		}
	}
	return n
}

// askSettled reports whether every question is answered or skipped.
func askSettled(ask *extensionAsk, state askUIState) bool {
	return len(ask.Questions) > 0 && askAnswered(ask, state) == len(ask.Questions)
}

// askFirstUnanswered is the index of the first question still open, -1
// when all are settled.
func askFirstUnanswered(ask *extensionAsk, state askUIState) int {
	for i, q := range ask.Questions {
		if !state.Answers[q.ID].answered() {
			return i
		}
	}
	return -1
}

// askWire turns the card's answers into the envelope the extension reads.
// Text still sitting in a field counts, as PiDeck folds it in.
func askWire(ask *extensionAsk, state askUIState, texts map[string]string, cancelled bool) askResponseWire {
	out := askResponseWire{Cancelled: cancelled, Answers: make([]askAnswerWire, 0, len(ask.Questions))}
	for _, q := range ask.Questions {
		ans := state.Answers[q.ID]
		if !ans.Skipped {
			if text := strings.TrimSpace(texts[q.ID]); text != "" && (q.Type == askInput || q.Type == askEditor) {
				if !ans.answered() {
					ans = askAnswer{Value: text, Label: text}
				}
			}
			if text := strings.TrimSpace(texts[q.ID]); text != "" && q.Type == askSelect && !ans.answered() {
				ans = askAnswer{Value: text, Label: text, WasCustom: true}
			}
		}
		out.Answers = append(out.Answers, askAnswerWire{ID: q.ID, Type: q.Type, Value: ans.Value,
			Label: ans.Label, WasCustom: ans.WasCustom, Skipped: ans.Skipped})
	}
	return out
}

// submitBatch sends every answer, or shows the first question still open.
func (a *app) submitBatch(s *session, ask *extensionAsk, cancelled bool) {
	if s == nil || ask == nil {
		return
	}
	state := s.askUI.GetUntracked()
	if !cancelled && !askSettled(ask, state) {
		if i := askFirstUnanswered(ask, state); i >= 0 {
			a.setAskTab(s, i)
		}
		a.toast(ui.ToastInfo, "还有题目没回答", "答完或跳过每一题再提交。")
		return
	}
	wire := askWire(ask, state, s.askTexts.GetUntracked(), cancelled)
	data, err := json.Marshal(wire)
	if err != nil {
		a.toast(ui.ToastError, "答案没有发出去", err.Error())
		return
	}
	a.respondAsk(s, ask, map[string]any{"value": string(data)})
}

// closeAsk closes the card: answers already given still reach the model,
// and a card with nothing answered is a plain cancel.
func (a *app) closeAsk(s *session, ask *extensionAsk) {
	if s == nil || ask == nil {
		return
	}
	if ask.Method != remotewire.AskMethodBatch {
		a.respondAsk(s, ask, map[string]any{"cancelled": true})
		return
	}
	state := s.askUI.GetUntracked()
	if askAnswered(ask, state) == 0 {
		a.respondAsk(s, ask, map[string]any{"cancelled": true})
		return
	}
	a.submitBatch(s, ask, true)
}

// respondAsk settles one request and brings the next up. ACP requests go
// to their own reply function.
func (a *app) respondAsk(s *session, ask *extensionAsk, value map[string]any) {
	if s == nil || ask == nil {
		return
	}
	a.answerAskFor(s, ask, value)
	a.popAsk(s, ask)
}
