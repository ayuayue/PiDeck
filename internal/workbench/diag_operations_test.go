//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/ui"
)

func TestDiagOperationsExcludeConversationContent(t *testing.T) {
	a := &app{}
	s := &session{ID: "private-session-id"}
	secret := "private-conversation-body"
	a.recordAppEvent(eventSessionCreated, appEvent{Session: s, Data: map[string]string{"title": secret, "text": secret}})
	a.recordAppEvent(eventTurnStart, appEvent{Session: s, Data: map[string]string{"prompt": secret}})
	a.recordToast(ui.ToastInfo, "已复制", secret)
	a.recordToast(ui.ToastWarning, "请求失败", "token=private-token")
	a.recordACPCall(s.ID, "session/prompt", time.Second, errors.New(secret))
	a.recordACPUpdate(s.ID, acpUpdate{Kind: "agent_message_chunk", Text: secret})
	a.recordACPUpdate(s.ID, acpUpdate{Kind: "tool_call_update", Status: secret, Text: secret})
	a.recordACPUpdate(s.ID, acpUpdate{Kind: "tool_call_update", Status: "failed", Text: secret})
	events := a.diagSnapshot()
	if len(events) != 7 {
		t.Fatalf("events = %d, want 7 (streamed text must be excluded)", len(events))
	}
	for _, ev := range events {
		if strings.Contains(ev.Text, secret) || strings.Contains(ev.Text, "private-token") || ev.Session == s.ID {
			t.Fatalf("private content in log: %+v", ev)
		}
	}
	if events[0].Category != "session" || events[0].Session != diagSessionKey(s.ID) || events[3].Level != "warn" || events[4].Level != "error" || events[6].Level != "error" {
		t.Fatalf("categories, correlation or severity incorrect: %+v", events)
	}
}

func TestDiagACPProtocolOutcomes(t *testing.T) {
	t.Setenv("PIDECK_FAKE_ACP", "1")
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=TestFakeACPAgent"}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	a := &app{}
	c.setHooks(acpHooks{protocol: func(method string, elapsed time.Duration, err error) {
		a.recordACPCall("protocol-test", method, elapsed, err)
	}})
	if _, err := c.initialize(); err != nil {
		t.Fatal(err)
	}
	if err := c.call("unsupported/logging-test", map[string]any{"prompt": "private-prompt-body"}, nil, 3*time.Second); err == nil {
		t.Fatal("unknown protocol method unexpectedly succeeded")
	}
	events := a.diagSnapshot()
	if len(events) != 2 || events[0].Level != "info" || events[1].Level != "error" {
		t.Fatalf("protocol outcomes = %+v", events)
	}
	if !strings.Contains(events[0].Text, "initialize") || !strings.Contains(events[1].Text, "unsupported/logging-test") {
		t.Fatalf("protocol methods missing: %+v", events)
	}
	for _, ev := range events {
		if strings.Contains(ev.Text, "private-prompt-body") {
			t.Fatalf("protocol payload in log: %+v", ev)
		}
	}
}
