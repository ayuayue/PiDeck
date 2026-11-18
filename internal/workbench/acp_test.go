//go:build !js && !android && !ios

package workbench

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
				"result": map[string]any{"sessionId": "s1", "modes": map[string]any{
					"currentModeId": "ask",
					"availableModes": []map[string]string{
						{"id": "ask", "name": "Ask", "description": "confirm first"},
						{"id": "code", "name": "Code"},
					}}}})
		case "session/set_mode":
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{}})
		case "session/prompt":
			ui := os.Getenv("PIDECK_FAKE_ACP_UI") == "1"
			if !ui {
				_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update",
					"params": map[string]any{"sessionId": "s1", "update": map[string]any{
						"sessionUpdate": "current_mode_update", "currentModeId": "plan"}}})
				_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update",
					"params": map[string]any{"sessionId": "s1", "update": map[string]any{
						"sessionUpdate":     "available_commands_update",
						"availableCommands": []map[string]string{{"name": "web", "description": "search"}}}}})
			}
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update",
				"params": map[string]any{"sessionId": "s1", "update": map[string]any{
					"sessionUpdate": "tool_call", "toolCallId": "t2", "title": "Editing changed.txt",
					"name": "edit_file", "kind": "edit", "status": "in_progress",
					"locations": []map[string]any{{"path": "changed.txt", "line": 1}}}}})
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update",
				"params": map[string]any{"sessionId": "s1", "update": map[string]any{
					"sessionUpdate": "tool_call_update", "toolCallId": "t2", "status": "completed",
					"content": []map[string]any{{"type": "content", "content": map[string]string{"type": "text", "text": "ok"}}}}}})
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "method": "session/update",
				"params": map[string]any{"sessionId": "s1", "update": map[string]any{
					"sessionUpdate": "agent_message_chunk", "content": map[string]string{"type": "text", "text": "hello"}}}})
			if !ui {
				_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": 99, "method": "session/request_permission",
					"params": map[string]any{"sessionId": "s1", "toolCall": map[string]string{"toolCallId": "t1", "title": "run"},
						"options": []map[string]string{{"optionId": "allow", "name": "Allow", "kind": "allow_once"}}}})
			}
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
				"result": map[string]any{"stopReason": "end_turn"}})
			if !ui {
				os.Exit(0)
			}
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
	updates := make(chan acpUpdate, 8)
	perms := make(chan acpPermission, 1)
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=TestFakeACPAgent"},
		func(u acpUpdate) { updates <- u },
		func(p acpPermission) string { perms <- p; return "allow" }, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	version, err := c.initialize("PiDeck Lite", "test")
	if err != nil || version != 1 {
		t.Fatalf("initialize = %d, %v", version, err)
	}
	sid, modes, err := c.newSession(".")
	if err != nil || sid != "s1" {
		t.Fatalf("newSession = %q, %v", sid, err)
	}
	if modes.CurrentModeID != "ask" || len(modes.AvailableModes) != 2 || modes.AvailableModes[1].Name != "Code" {
		t.Fatalf("modes = %+v", modes)
	}
	if err := c.setMode(sid, "code"); err != nil {
		t.Fatalf("setMode: %v", err)
	}
	stop, err := c.prompt(sid, "hi")
	if err != nil || stop != "end_turn" {
		t.Fatalf("prompt = %q, %v", stop, err)
	}
	var sawCommands, sawText, sawMode, sawTool, sawToolDone bool
	for !sawCommands || !sawText || !sawMode || !sawTool || !sawToolDone {
		select {
		case u := <-updates:
			switch u.Kind {
			case "current_mode_update":
				if u.Mode != "plan" {
					t.Fatalf("mode = %q", u.Mode)
				}
				sawMode = true
			case "available_commands_update":
				if len(u.Commands) != 1 || u.Commands[0].Name != "web" {
					t.Fatalf("commands = %+v", u.Commands)
				}
				sawCommands = true
			case "tool_call":
				if u.ToolKind != "edit" || u.ToolName != "edit_file" || len(u.Locations) != 1 || u.Locations[0] != "changed.txt" {
					t.Fatalf("tool call = %+v", u)
				}
				sawTool = true
			case "tool_call_update":
				if u.Status != "completed" || u.Text != "ok" {
					t.Fatalf("tool update = %+v", u)
				}
				sawToolDone = true
			case "agent_message_chunk":
				if u.Text != "hello" || u.SessionID != "s1" {
					t.Fatalf("update = %+v", u)
				}
				sawText = true
			}
		case <-time.After(3 * time.Second):
			t.Fatal("missing update")
		}
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

// TestACPExit checks a stopped agent reports its exit.
func TestACPExit(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	exits := make(chan error, 1)
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=TestFakeACPAgent"},
		func(acpUpdate) {}, nil, func(err error) { exits <- err })
	if err != nil {
		t.Fatal(err)
	}
	c.stop()
	select {
	case <-exits:
	case <-time.After(5 * time.Second):
		t.Fatal("no exit")
	}
}
