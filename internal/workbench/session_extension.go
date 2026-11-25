//go:build !js && !android && !ios

package workbench

// The app's state and the actions the screen calls. Signals hold what the
// views read; pi's events are folded in here, on the UI thread.

import (
	"encoding/json"
	"sort"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/ui"
)

// onPiUI handles an extension's request for attention.
func (a *app) onPiUI(s *session, req uiRequest) {
	a.onPiUIGeneration(s, s.piGeneration.Load(), req)
}

func (a *app) onPiUIGeneration(s *session, generation uint64, req uiRequest) {
	post := func(fn func()) {
		a.cx.Post(func() {
			if s.piGeneration.Load() == generation {
				fn()
			}
		})
	}
	switch req.Method {
	case "notify":
		kind := ui.ToastInfo
		if req.NotifyType == "warning" {
			kind = ui.ToastWarning
		} else if req.NotifyType == "error" {
			kind = ui.ToastError
		}
		post(func() { a.toast(kind, "pi 扩展", viewkit.FirstLine(req.Message, 120)) })
	case "setStatus":
		post(func() {
			if req.StatusText == nil || *req.StatusText == "" {
				delete(s.extStatus, req.StatusKey)
			} else {
				s.extStatus[req.StatusKey] = *req.StatusText
			}
			a.refreshExtStatus(s)
		})
	case "set_editor_text":
		post(func() { s.draft.Set(req.Text) })
	case "setWidget":
		post(func() {
			if s.extWidgets == nil {
				s.extWidgets = map[string][]string{}
			}
			if len(req.WidgetLines) == 0 {
				delete(s.extWidgets, req.WidgetKey)
			} else {
				s.extWidgets[req.WidgetKey] = append([]string(nil), req.WidgetLines...)
			}
			a.bumpSessionUI(s)
		})
	case "setTitle":
		// The window has its own title.
	case "select", "confirm", "input", "editor":
		post(func() {
			ask := askFromPi(req)
			a.enqueueAsk(s, ask)
			a.watchAsk(s, ask)
		})
	default:
		// A dialog method the window does not know: answer it so pi's
		// extension never blocks on a response that will not come.
		post(func() {
			if s.engine != nil {
				s.engine.uiResponse(req.ID, map[string]any{"cancelled": true})
			}
		})
	}
}

// askFromPi builds the card's request from an extension's dialog call. A
// batch envelope in the title is the extension asking several questions in
// one call.
func askFromPi(req uiRequest) *extensionAsk {
	if env, ok := parseBatchAsk(req.Title); ok {
		ask := &extensionAsk{ID: req.ID, Method: remotewire.AskMethodBatch, Timeout: time.Duration(req.Timeout) * time.Millisecond,
			Questions: env.Questions, Review: env.Review, Placeholder: req.Placeholder}
		ask.Options = askQuestionLabels(env.Questions)
		return ask
	}
	ask := &extensionAsk{ID: req.ID, Method: req.Method, Title: req.Title, Message: req.Message,
		Default: req.Prefill, Placeholder: req.Placeholder, Options: req.Options,
		Timeout: time.Duration(req.Timeout) * time.Millisecond}
	ask.PlanNext, ask.Title, ask.Message = extensionDialog(req.Title, req.Message)
	if req.Method == "select" {
		choices, other := askOptionsFromStrings(req.Options)
		ask.Choices = choices
		ask.AllowOther = other || req.AllowOther
		ask.Options = askOptionValues(choices)
		if len(choices) == 0 {
			// Nothing to pick: ask for text, as the extension does.
			ask.Method = "input"
		}
	}
	return ask
}

// extensionDialog turns PiDeck's prefixed extension dialogs into the card's
// own title and body. The prefixes are protocol, not something to show.
func extensionDialog(head, body string) (planNext bool, title, message string) {
	const (
		planPrefix     = "[PI_DECK_PLAN_NEXT]"
		securityPrefix = "[PI_DECK_SECURITY_CONFIRM]"
	)
	if strings.HasPrefix(head, planPrefix) {
		return true, strings.TrimSpace(strings.TrimPrefix(head, planPrefix)), body
	}
	if strings.HasPrefix(head, securityPrefix) {
		var payload struct{ Tool, Level, Detail string }
		if json.Unmarshal([]byte(strings.TrimPrefix(head, securityPrefix)), &payload) == nil {
			title = apptext.T("工具安全门")
			message = apptext.T("工具：%s", payload.Tool) + "\n" + apptext.T("等级：%s", payload.Level)
			if payload.Detail != "" {
				message += "\n\n" + payload.Detail
			}
			return false, title, message
		}
	}
	return false, head, body
}

// askQuestionLabels is the label list the phone shows for a batch: the
// first question's options, which is what a phone can answer.
func askQuestionLabels(questions []askQuestion) []string {
	if len(questions) == 0 {
		return nil
	}
	out := make([]string, 0, len(questions[0].Options))
	for _, opt := range questions[0].Options {
		out = append(out, opt.Label)
	}
	return out
}

// askOptionValues is a choice list's values, for the phone.
func askOptionValues(choices []askOption) []string {
	out := make([]string, 0, len(choices))
	for _, opt := range choices {
		out = append(out, opt.Label)
	}
	return out
}

// watchAsk lets a request go when its timeout passes: the extension's own
// when it set one, else the window's fallback, which also tells pi so its
// call does not hang.
func (a *app) watchAsk(s *session, ask *extensionAsk) {
	wait := askAutoTimeout
	answer := true
	if ask.Timeout > 0 {
		wait = ask.Timeout + 2*time.Second
		answer = false
	}
	a.cx.AfterFunc(wait, func() {
		if answer {
			a.respondAsk(s, ask, map[string]any{"cancelled": true})
			return
		}
		a.dropAsk(s, ask)
	})
}

// refreshExtStatus joins the extension statuses into the notice line.
func (a *app) refreshExtStatus(s *session) {
	if len(s.extStatus) == 0 {
		s.notice.Set("")
		return
	}
	var parts []string
	keys := make([]string, 0, len(s.extStatus))
	for k := range s.extStatus {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, s.extStatus[k])
	}
	s.notice.Set(strings.Join(parts, " · "))
}

// answerAsk replies to the request the card shows.
func (a *app) answerAsk(s *session, value map[string]any) {
	if s == nil {
		return
	}
	ask := s.showingAsk()
	if ask == nil {
		return
	}
	a.respondAsk(s, ask, value)
}

// answerAskFor replies to one request: to ACP when it is an ACP
// permission, else to pi by the request's id.
func (a *app) answerAskFor(s *session, ask *extensionAsk, value map[string]any) {
	if s == nil || ask == nil {
		return
	}
	if ask.ACPReply != nil || s.acpReply != nil {
		name, _ := value["value"].(string)
		if cancelled, _ := value["cancelled"].(bool); cancelled {
			name = ""
		}
		reply := ask.ACPReply
		if reply == nil {
			reply = s.acpReply
			s.acpReply = nil
		}
		reply(name)
		return
	}
	if s.engine == nil {
		return
	}
	s.engine.uiResponse(ask.ID, value)
}

// pendingAsk is the extension dialog any session is waiting on.
func (a *app) pendingAsk() (*session, *extensionAsk) {
	for _, s := range a.all {
		if ask := s.ask.Get(); ask != nil {
			return s, ask
		}
	}
	return nil, nil
}
