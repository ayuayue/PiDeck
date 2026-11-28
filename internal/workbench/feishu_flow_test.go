//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFeishuSourceChatsAreIsolatedFromActiveProject(t *testing.T) {
	a, screen, active := startSessionLifecycleApp(t)
	h := &remoteHost{app: a}
	onNativeUI(t, screen, a, func() {
		first := h.feishuSession("chat-one")
		second := h.feishuSession("chat-two")
		if first == nil || second == nil || first == second || first == active || second == active {
			t.Error("source chats were not isolated")
			return
		}
		if ws := a.workspaceFor(first.Target, first.WS); ws == nil || !ws.Chat || !a.projectTrusted(ws) {
			t.Error("incoming chat is not in the trusted built-in chat workspace")
		}
		a.selectSession(active)
		if got := h.feishuSession("chat-one"); got != first || a.activeID.GetUntracked() != active.ID {
			t.Error("switching projects changed the source chat's destination")
		}
		first.deleting = true
		if got := h.feishuSession("chat-one"); got == first || got == nil {
			t.Error("deleted destination was reused")
		}
	})
}

func TestFeishuCallbackSubmitsOnceAndRepliesOnce(t *testing.T) {
	sent := make(chan string, 2)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Content struct {
				Text string `json:"text"`
			} `json:"content"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		sent <- body.Content.Text
		_, _ = w.Write([]byte(`{"code":0}`))
	}))
	defer srv.Close()
	a, screen, active := startSessionLifecycleApp(t)
	h := &remoteHost{app: a}
	var source *session
	onNativeUI(t, screen, a, func() {
		a.cfg.FeishuInbound, a.cfg.FeishuReply, a.cfg.FeishuEnabled = true, true, true
		a.cfg.FeishuWebhook = srv.URL
		a.st.mu.Lock()
		a.st.c.FeishuInbound, a.st.c.FeishuVerifyToken = true, "fixture-token"
		a.st.mu.Unlock()
		source = h.feishuSession("chat-one")
		// Queue startup without invoking a real CLI or model provider.
		source.starting = true
		a.selectSession(active)
	})
	post := func(id string) {
		t.Helper()
		body := `{"header":{"event_type":"im.message.receive_v1","token":"fixture-token"},"event":{"sender":{"sender_type":"user"},"message":{"message_id":"` + id + `","chat_id":"chat-one","message_type":"text","content":"{\"text\":\"@_user_1 hello\"}"}}}`
		rec := httptest.NewRecorder()
		h.handleFeishu(rec, httptest.NewRequest(http.MethodPost, "/api/feishu", strings.NewReader(body)))
		if rec.Code != http.StatusOK {
			t.Fatalf("callback rejected: %d %s", rec.Code, rec.Body.String())
		}
	}
	post("message-one")
	post("message-one")
	post("message-two") // Busy destination must not acquire a second turn.
	onNativeUI(t, screen, a, func() {
		turns := source.turns.GetUntracked()
		if len(turns) != 1 || turns[0].Prompt != "hello" || len(active.turns.GetUntracked()) != 1 {
			t.Errorf("dispatch source turns=%d active turns=%d", len(turns), len(active.turns.GetUntracked()))
			return
		}
		a.notifyFeishu(source, "已完成", "fixture answer")
		a.onFeishuTurn(appEvent{Session: source, Data: map[string]string{"status": "completed", "answer": "fixture answer"}})
		a.onFeishuTurn(appEvent{Session: source, Data: map[string]string{"status": "completed", "answer": "duplicate answer"}})
	})
	var answer string
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case answer = <-sent:
			return true
		default:
			return false
		}
	})
	if !strings.Contains(answer, "fixture answer") {
		t.Fatalf("wrong reply %q", answer)
	}
	select {
	case duplicate := <-sent:
		t.Fatalf("duplicate reply %q", duplicate)
	default:
	}
}

func TestFeishuReplyFailureIsVisible(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"code":19021,"msg":"sign match fail"}`))
	}))
	defer srv.Close()
	a, screen, s := startSessionLifecycleApp(t)
	onNativeUI(t, screen, a, func() {
		a.cfg.FeishuReply, a.cfg.FeishuWebhook = true, srv.URL
		a.feishuMu.Lock()
		a.feishuPending = map[string]bool{s.ID: true}
		a.feishuMu.Unlock()
		a.onFeishuTurn(appEvent{Session: s, Data: map[string]string{"status": "completed", "answer": "fixture answer"}})
	})
	screen.WaitFor("text:飞书返回 19021：sign match fail", 5*time.Second)
}
