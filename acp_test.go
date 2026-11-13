package main

// Checks the ACP client against a fake agent that speaks the protocol.

import (
	"bufio"
	"encoding/json"
	"os"
	"testing"
	"time"
)

// TestFakeACPAgent is the fake agent when the environment names it; the
// test binary is its own helper process.
func TestFakeACPAgent(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") != "1" {
		return
	}
	sc := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	for sc.Scan() {
		var msg struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(sc.Bytes(), &msg) != nil {
			continue
		}
		switch msg.Method {
		case "initialize":
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
				"result": map[string]any{"protocolVersion": 1}})
		case "session/new":
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
				"result": map[string]any{"sessionId": "s1"}})
		case "session/prompt":
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update",
				"params": map[string]any{"sessionId": "s1", "update": map[string]any{
					"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "hello"}}}})
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": 99, "method": "session/request_permission",
				"params": map[string]any{"sessionId": "s1", "toolCall": map[string]string{"toolCallId": "t1", "title": "run"},
					"options": []map[string]string{{"optionId": "allow", "name": "Allow", "kind": "allow_once"}}}})
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
				"result": map[string]any{"stopReason": "end_turn"}})
			os.Exit(0)
		}
	}
	os.Exit(0)
}

// TestACPClient drives the handshake, a prompt and a permission request.
func TestACPClient(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	updates := make(chan acpUpdate, 4)
	perms := make(chan acpPermission, 1)
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=TestFakeACPAgent"},
		func(u acpUpdate) { updates <- u },
		func(p acpPermission) string { perms <- p; return "allow" })
	if err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	version, err := c.initialize("PiDeck Lite", "test")
	if err != nil || version != 1 {
		t.Fatalf("initialize = %d, %v", version, err)
	}
	sid, err := c.newSession(".")
	if err != nil || sid != "s1" {
		t.Fatalf("newSession = %q, %v", sid, err)
	}
	stop, err := c.prompt(sid, "hi")
	if err != nil || stop != "end_turn" {
		t.Fatalf("prompt = %q, %v", stop, err)
	}
	select {
	case u := <-updates:
		if u.Kind != "agent_message_chunk" || u.Text != "hello" || u.SessionID != "s1" {
			t.Fatalf("update = %+v", u)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no update")
	}
	select {
	case p := <-perms:
		if p.ToolID != "t1" || len(p.Options) != 1 || p.Options[0].ID != "allow" {
			t.Fatalf("permission = %+v", p)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no permission request")
	}
}

// TestACPPresets checks the preset list is filled in.
func TestACPPresets(t *testing.T) {
	list := acpPresets()
	if len(list) < 3 {
		t.Fatalf("presets = %+v", list)
	}
	for _, p := range list {
		if p.ID == "" || p.Name == "" || p.Command == "" {
			t.Errorf("preset = %+v", p)
		}
	}
}
