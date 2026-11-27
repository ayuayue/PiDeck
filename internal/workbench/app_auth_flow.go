//go:build !js && !android && !ios

package workbench

import (
	"context"
	"strings"
	"time"

	"example.com/pideck-v2/internal/apptext"
)

func (a *app) authLoginMode(provider string, apiKey, noBrowser bool) {
	provider = strings.TrimSpace(provider)
	if provider == "" || a.authUI.Busy.GetUntracked() {
		return
	}
	if a.authUI.Cancel != nil {
		a.authUI.Cancel()
	}
	a.authUI.Generation++
	generation := a.authUI.Generation
	// The chooser unmounts when login starts; its event-owner context is too short.
	ctx, cancel := context.WithTimeout(a.authUI.Lifetime, 10*time.Minute)
	a.authUI.Cancel = cancel
	answers := make(chan authFlowCommand, 8)
	a.authUI.Answers = answers
	a.authUI.Opened = make(map[string]bool)
	a.authUI.Answer.Set("")
	a.authUI.Flow.Set(authFlowView{Open: true, Phase: "running", Provider: provider, APIKey: apiKey, NoBrowser: noBrowser})
	a.authUI.Busy.Set(true)
	a.authMethodsOpen.Set(false)
	a.authKeyText.Set("")
	piPath, dir := a.piPath(), piConfigDir()
	kind := "oauth"
	if apiKey {
		kind = "api_key"
	}
	go func() {
		err := runPiAuthFlow(ctx, piPath, dir, authFlowCommand{Cmd: "login", ProviderID: provider, Type: kind}, answers, func(message authFlowMessage) {
			a.cx.Post(func() {
				if generation != a.authUI.Generation || ctx.Err() != nil {
					return
				}
				a.receiveAuthFlow(message)
			})
		})
		a.cx.Post(func() {
			if generation != a.authUI.Generation {
				cancel()
				return
			}
			a.authUI.Busy.Set(false)
			a.authUI.Cancel = nil
			a.authUI.Answers = nil
			view := a.authUI.Flow.GetUntracked()
			view.Prompt, view.PromptID = nil, ""
			a.authUI.Answer.Set("")
			if err == nil {
				view.Phase = "succeeded"
				view.Message = apptext.T("登录成功，凭据已保存到 auth.json。")
				a.loadAuth()
				a.refreshProviders()
			} else if ctx.Err() == context.Canceled {
				view.Open = false
			} else {
				view.Phase = "failed"
				view.Message = err.Error()
				if ctx.Err() == context.DeadlineExceeded {
					view.Message = apptext.T("登录已超时，请检查网络或代理后重试。")
				}
				// A cancelled browser flow can still have completed on pi's side.
				a.loadAuth()
			}
			a.authUI.Flow.Set(view)
			cancel()
		})
	}()
}

func (a *app) receiveAuthFlow(message authFlowMessage) {
	view := a.authUI.Flow.GetUntracked()
	if view.Phase != "running" {
		return
	}
	switch message.Type {
	case "prompt":
		if message.Prompt == nil || message.ID == "" {
			return
		}
		view.Prompt, view.PromptID = message.Prompt, message.ID
		a.authUI.Answer.Set("")
	case "prompt-cancelled":
		if message.ID != view.PromptID {
			return
		}
		view.Prompt, view.PromptID = nil, ""
		a.authUI.Answer.Set("")
	case "event":
		event := message.Event
		view.Events = append(append([]authFlowEvent(nil), view.Events...), event)
		if len(view.Events) > 30 {
			view.Events = view.Events[len(view.Events)-30:]
		}
		if event.Message != "" {
			view.Message = event.Message
		}
		var target string
		shouldOpen := !view.NoBrowser
		switch event.Type {
		case "auth_url":
			view.URL = safeAuthURL(event.URL)
			view.Message = event.Instructions
			target = view.URL
		case "device_code":
			view.URL, view.Code = safeAuthURL(event.VerificationURI), event.UserCode
			target = view.URL
			shouldOpen = shouldOpen && (event.OpenBrowserOnConfirm == nil || *event.OpenBrowserOnConfirm)
		}
		if target != "" && shouldOpen && !a.authUI.Opened[target] {
			a.authUI.Opened[target] = true
			a.openAuthURL(target)
		}
	}
	a.authUI.Flow.Set(view)
}

func (a *app) openAuthURL(raw string) {
	target := safeAuthURL(raw)
	if target == "" {
		return
	}
	generation := a.authUI.Generation
	a.cx.OpenURL(target, func(opened bool) {
		a.cx.Post(func() {
			if generation != a.authUI.Generation {
				return
			}
			view := a.authUI.Flow.GetUntracked()
			view.OpenFailed = !opened
			a.authUI.Flow.Set(view)
		})
	})
}

func (a *app) answerAuthPrompt(value string) {
	view := a.authUI.Flow.GetUntracked()
	if view.Phase != "running" || view.Prompt == nil || a.authUI.Answers == nil {
		return
	}
	if view.Prompt.Kind != "text" && strings.TrimSpace(value) == "" {
		return
	}
	select {
	case a.authUI.Answers <- authFlowCommand{Cmd: "answer", ID: view.PromptID, Value: value}:
		view.Prompt, view.PromptID = nil, ""
		a.authUI.Flow.Set(view)
		a.authUI.Answer.Set("")
	default:
	}
}

func (a *app) closeAuthFlow() {
	if a.authUI.Cancel != nil {
		a.authUI.Cancel()
	}
	a.authUI.Generation++ // Drop queued prompts/results from the closed process.
	a.authUI.Cancel = nil
	a.authUI.Answers = nil
	a.authUI.Busy.Set(false)
	a.authUI.Answer.Set("")
	a.authUI.Flow.Set(authFlowView{})
	a.loadAuth()
}
