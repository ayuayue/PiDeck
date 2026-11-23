package client

// The phone build: it connects to a desktop PiDeck V2 server and browses
// its projects, sessions and transcripts. The same package builds the
// desktop; Root picks this screen on iOS and Android (or with
// PIDECK_V2_MOBILE=1 for a preview on a desktop).

// What the phone holds while it answers a request: the answers of each
// question, the text in each field, and the envelope they make on submit.

import (
	"strings"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
)

// askQuestionSettled says one question is answered or skipped: a choice
// made, or the field it is answered in filled.
func (a *mobileApp) askQuestionSettled(q remotewire.AskQuestion) bool {
	if answer, ok := a.askAnswer(q.ID); ok {
		if answer.Skipped || (q.Type != "input" && q.Type != "editor") {
			return true
		}
	}
	switch q.Type {
	case "input", "editor":
		return strings.TrimSpace(a.askTextValue(q)) != ""
	case "select":
		return q.AllowOther && strings.TrimSpace(a.askTextValue(q)) != ""
	}
	return false
}

// askAnswer is what one question holds, answered or skipped.
func (a *mobileApp) askAnswer(id string) (remotewire.AskAnswer, bool) {
	for _, ans := range a.askPicks.Get() {
		if ans.ID == id {
			return ans, true
		}
	}
	return remotewire.AskAnswer{}, false
}

// setAskAnswer records one question's answer, replacing what it held.
func (a *mobileApp) setAskAnswer(answer remotewire.AskAnswer) {
	a.askPicks.Update(func(list []remotewire.AskAnswer) []remotewire.AskAnswer {
		out := make([]remotewire.AskAnswer, 0, len(list)+1)
		for _, one := range list {
			if one.ID != answer.ID {
				out = append(out, one)
			}
		}
		return append(out, answer)
	})
}

// clearAskAnswer drops one question's answer, so it counts as open again.
func (a *mobileApp) clearAskAnswer(id string) {
	a.askPicks.Update(func(list []remotewire.AskAnswer) []remotewire.AskAnswer {
		out := make([]remotewire.AskAnswer, 0, len(list))
		for _, one := range list {
			if one.ID != id {
				out = append(out, one)
			}
		}
		return out
	})
}

// toggleAskMulti adds or drops one choice of a multi_select question.
func (a *mobileApp) toggleAskMulti(q remotewire.AskQuestion, value, label string) {
	current, ok := a.askAnswer(q.ID)
	var values []string
	if ok && !current.Skipped {
		if list, isList := current.Value.([]string); isList {
			values = list
		}
	}
	kept := make([]string, 0, len(values)+1)
	found := false
	for _, one := range values {
		if one == value {
			found = true
			continue
		}
		kept = append(kept, one)
	}
	if !found {
		kept = append(kept, value)
	}
	if len(kept) == 0 {
		a.clearAskAnswer(q.ID)
		return
	}
	labels := make([]string, 0, len(kept))
	for _, one := range kept {
		labels = append(labels, askOptionLabelOf(q, one))
	}
	a.setAskAnswer(remotewire.AskAnswer{ID: q.ID, Type: q.Type, Value: kept, Label: strings.Join(labels, "、")})
}

// askOptionLabelOf names one choice the way the question wrote it.
func askOptionLabelOf(q remotewire.AskQuestion, value string) string {
	for _, opt := range q.Options {
		if opt.Value == value {
			return opt.Label
		}
	}
	return value
}

// toggleAskSkip lets one question go, or takes the skip back.
func (a *mobileApp) toggleAskSkip(q remotewire.AskQuestion) {
	if answer, ok := a.askAnswer(q.ID); ok && answer.Skipped {
		a.clearAskAnswer(q.ID)
		return
	}
	a.setAskAnswer(remotewire.AskAnswer{ID: q.ID, Type: q.Type, Skipped: true})
}

// askTextValue is what a question's field holds: what was typed, else the
// text the question came with.
func (a *mobileApp) askTextValue(q remotewire.AskQuestion) string {
	if text, ok := a.askTexts.Get()[q.ID]; ok {
		return text
	}
	return q.Prefill
}

// setAskText keeps one question's typed text.
func (a *mobileApp) setAskText(id, text string) {
	a.askTexts.Update(func(texts map[string]string) map[string]string {
		out := make(map[string]string, len(texts)+1)
		for k, v := range texts {
			out[k] = v
		}
		out[id] = text
		return out
	})
}

// resetAskDraft drops the answers of a request that is no longer showing:
// another turn's questions must not inherit them.
func (a *mobileApp) resetAskDraft(ask *remotewire.Ask) {
	key := askKey(ask)
	if key == a.askKey {
		return
	}
	a.askKey = key
	a.askPicks.Set(nil)
	a.askTexts.Set(nil)
	a.askText.Set("")
}

// askKey names a request, so a poll of the same one keeps what was answered.
func askKey(ask *remotewire.Ask) string {
	if ask == nil {
		return ""
	}
	parts := make([]string, 0, len(ask.Questions)+1)
	parts = append(parts, ask.Method, ask.Title)
	for _, q := range ask.Questions {
		parts = append(parts, q.ID+":"+q.Type+":"+q.Question)
	}
	return strings.Join(parts, "\x1f")
}

// cancelAsk lets the whole request go, as the desktop's close does.
func (a *mobileApp) cancelAsk() {
	a.answer(map[string]any{"cancelled": true})
}

// submitAskAnswers sends the batch's answers, after checking that every
// question was answered or skipped.
func (a *mobileApp) submitAskAnswers() {
	ask := a.ask.GetUntracked()
	if ask == nil {
		return
	}
	answers := make([]remotewire.AskAnswer, 0, len(ask.Questions))
	for _, q := range ask.Questions {
		answer, picked := a.askAnswer(q.ID)
		typed := strings.TrimSpace(a.askTextValue(q))
		if !picked {
			// A question answered by typing holds no choice, so its text is
			// the answer.
			answer = remotewire.AskAnswer{ID: q.ID, Type: q.Type, Value: typed, Label: typed}
			if typed == "" {
				a.flash(apptext.T("还有题目没回答"))
				return
			}
		} else if !answer.Skipped {
			switch q.Type {
			case "input", "editor":
				answer.Value, answer.Label = typed, typed
				if typed == "" {
					a.flash(apptext.T("还有题目没回答"))
					return
				}
			case "select":
				// What was typed instead of chosen is the custom answer.
				if typed != "" && typed != answer.Value {
					answer.Value, answer.Label, answer.WasCustom = typed, typed, true
				}
			}
		}
		answer.Type = q.Type
		answers = append(answers, answer)
	}
	a.answer(map[string]any{"answers": answers})
}
