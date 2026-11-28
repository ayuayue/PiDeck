//go:build !js && !android && !ios

package workbench

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestWechatRejectsUnavailableSessionWithoutPendingReply(t *testing.T) {
	for _, state := range []string{"stopping", "loading", "retrying"} {
		t.Run(state, func(t *testing.T) {
			a, screen, s := startSessionLifecycleApp(t)
			screen.WaitUntil(5*time.Second, func() bool { return a.wechat.ready.GetUntracked() })
			onNativeUI(t, screen, a, func() {
				a.trustProject(a.activeWorkspace())
				a.wechat.connection.Owner = "owner"
				a.wechat.connection.Session = s.ID
				switch state {
				case "stopping":
					s.agentStopping = true
				case "loading":
					s.historyLoading = true
				case "retrying":
					s.retrying.Set(true)
				}
				var m wechatMessage
				if err := json.Unmarshal([]byte(`{"message_id":1,"from_user_id":"owner","message_type":1,"context_token":"reply-context","item_list":[{"type":1,"text_item":{"text":"hello"}}]}`), &m); err != nil {
					t.Fatal(err)
				}
				a.receiveWechat(wechatClient{}, m)
				if a.wechat.pending != nil || len(s.turns.GetUntracked()) != 1 {
					t.Fatalf("unavailable session consumed a message: pending=%+v turns=%d", a.wechat.pending, len(s.turns.GetUntracked()))
				}
			})
		})
	}
}

func TestWechatMessageSubmitsAndRepliesToItsOwner(t *testing.T) {
	type reply struct{ to, context, text string }
	sent := make(chan reply, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/ilink/bot/sendmessage" {
			t.Errorf("unexpected API %s", r.URL.Path)
		}
		var raw struct {
			Msg struct {
				To      string `json:"to_user_id"`
				Context string `json:"context_token"`
				Items   []struct {
					Text struct {
						Text string `json:"text"`
					} `json:"text_item"`
				} `json:"item_list"`
			} `json:"msg"`
		}
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			t.Error(err)
		}
		if len(raw.Msg.Items) != 1 {
			t.Errorf("reply has %d text items", len(raw.Msg.Items))
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		sent <- reply{raw.Msg.To, raw.Msg.Context, raw.Msg.Items[0].Text.Text}
		_, _ = w.Write([]byte(`{"ret":0}`))
	}))
	defer srv.Close()
	a, screen, s := startSessionLifecycleApp(t)
	screen.WaitUntil(5*time.Second, func() bool { return a.wechat.ready.GetUntracked() })
	onNativeUI(t, screen, a, func() {
		a.trustProject(a.activeWorkspace())
		a.cfg.WeChatEnabled = true
		a.wechat.connection = wechatConnection{Base: srv.URL, Token: "fixture", Owner: "owner", Session: s.ID}
		a.wechat.runContext, a.wechat.runCancel = context.WithCancel(a.cx.Context())
		// Keep engine startup queued; this test never runs an external agent.
		s.starting = true
		var m wechatMessage
		if err := json.Unmarshal([]byte(`{"message_id":7,"from_user_id":"owner","message_type":1,"context_token":"reply-context","item_list":[{"type":1,"text_item":{"text":"hello"}}]}`), &m); err != nil {
			t.Fatal(err)
		}
		a.receiveWechat(wechatClient{}, m)
		a.receiveWechat(wechatClient{}, m)
		turns := s.turns.GetUntracked()
		if len(turns) != 2 || turns[1].Prompt != "hello" || a.wechat.pending == nil {
			t.Fatalf("message dispatch: turns=%d pending=%+v", len(turns), a.wechat.pending)
		}
		a.onWechatTurn(appEvent{Session: s, Data: map[string]string{"status": "completed", "answer": "fixture answer"}})
	})
	var got reply
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case got = <-sent:
			return true
		default:
			return false
		}
	})
	if got.to != "owner" || got.context != "reply-context" || got.text != "fixture answer" {
		t.Fatalf("reply lost source context: %+v", got)
	}
	screen.WaitUntil(5*time.Second, func() bool { return a.wechat.status.GetUntracked() == "回答已发送到微信。" })
}
