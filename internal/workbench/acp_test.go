//go:build !js && !android && !ios

package workbench

// Checks the ACP client against a fake agent that speaks the protocol.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"slices"
	"strings"
	"testing"
	"time"
)

// TestFakeACPAgent is the fake agent when the environment names it; the
// test binary is its own helper process.
// fakeACPConfigTable is the option table the fake agent reports, with one
// option replaced.
func fakeACPConfigTable(changed string, value map[string]any) []map[string]any {
	table := []map[string]any{
		{"id": "mode", "name": "Mode", "category": "mode", "type": "select", "currentValue": "auto",
			"options": []map[string]string{{"value": "auto", "name": "Auto"}, {"value": "fullAccess", "name": "Full access"}}},
		{"id": "auto_approve", "name": "Auto approve", "type": "boolean", "currentValue": false},
		{"id": "model", "name": "Model", "category": "model", "type": "select", "currentValue": "sonnet",
			"options": []map[string]string{{"value": "sonnet", "name": "Sonnet"}, {"value": "opus", "name": "Opus"}}},
	}
	if os.Getenv("PIDECK_FAKE_ACP_RICH") == "1" {
		table = append(table, map[string]any{"id": "thought_level", "name": "Deep Thinking", "category": "thought_level",
			"type": "select", "currentValue": "low",
			"options": []map[string]string{{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}}})
	}
	for i, option := range table {
		if changed != "" && option["id"] == changed {
			table[i] = value
		}
	}
	return table
}

func TestFakeACPAgent(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") != "1" {
		return
	}
	sc := bufio.NewScanner(os.Stdin)
	enc := json.NewEncoder(os.Stdout)
	// A prompt waiting on a permission answer, and the request's id.
	permissionPrompt, permissionID := 0, 0
	for sc.Scan() {
		var msg struct {
			ID     int             `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(sc.Bytes(), &msg) != nil {
			continue
		}
		if msg.Method == "" {
			// The client answered the permission request: now the prompt
			// it was holding can finish, as a real agent would.
			if permissionID != 0 && msg.ID == permissionID {
				_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": permissionPrompt,
					"result": map[string]any{"stopReason": "end_turn"}})
				permissionPrompt, permissionID = 0, 0
				if os.Getenv("PIDECK_FAKE_ACP_UI") != "1" {
					os.Exit(0)
				}
			}
			continue
		}
		switch msg.Method {
		case "initialize":
			// An agent that dies before answering, and one that takes its
			// time the way a cold npx package does.
			if os.Getenv("PIDECK_FAKE_ACP_CRASH_HANDSHAKE") == "1" {
				fmt.Fprintln(os.Stderr, "boom: cannot start")
				os.Exit(9)
			}
			if os.Getenv("PIDECK_FAKE_ACP_SLOW_HANDSHAKE") == "1" {
				time.Sleep(2 * time.Second)
			}
			result := map[string]any{"protocolVersion": 1}
			if os.Getenv("PIDECK_FAKE_ACP_RESUME") == "1" {
				result["agentCapabilities"] = map[string]any{"sessionCapabilities": map[string]any{"resume": map[string]any{}}}
			}
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
				"result": result})
		case "session/resume":
			var req struct {
				SessionID string `json:"sessionId"`
			}
			if json.Unmarshal(msg.Params, &req) != nil || req.SessionID != "s1" {
				os.Exit(2)
			}
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
				"result": map[string]any{"modes": map[string]any{"currentModeId": "resumed"}, "configOptions": []map[string]any{{
					"id": "reasoning_effort", "name": "Reasoning effort", "category": "thought_level", "type": "select",
					"currentValue": "high", "options": []map[string]string{{"value": "low", "name": "Low"}, {"value": "high", "name": "High"}},
				}}}})
		case "session/new":
			options := fakeACPConfigTable("", nil)
			if os.Getenv("PIDECK_FAKE_ACP_BAD_OPTION") == "1" {
				options = append(options, map[string]any{"id": "broken", "name": 42})
			}
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
				"result": map[string]any{"sessionId": "s1", "configOptions": options, "modes": map[string]any{
					"currentModeId": "ask",
					"availableModes": []map[string]string{
						{"id": "ask", "name": "Ask", "description": "confirm first"},
						{"id": "code", "name": "Code"},
					}}}})
		case "session/set_config_option":
			var req struct {
				ConfigID string          `json:"configId"`
				Type     string          `json:"type"`
				Value    json.RawMessage `json:"value"`
			}
			if json.Unmarshal(msg.Params, &req) != nil {
				os.Exit(3)
			}
			text := strings.Trim(string(req.Value), `"`)
			if text == "true" || text == "false" {
				// CodeBuddy validates a boolean against the declared type: a
				// bare value is -32602, exactly what made every session fail.
				if req.Type != "boolean" {
					_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
						"error": map[string]any{"code": -32602, "message": "Invalid params"}})
					continue
				}
			}
			// Answer with the agent's own table, only the chosen value
			// replaced: an option keeps its category and its choices.
			table := fakeACPConfigTable("", nil)
			for i, option := range table {
				if option["id"] != req.ConfigID {
					continue
				}
				next := make(map[string]any, len(option))
				for k, v := range option {
					next[k] = v
				}
				if req.Type == "boolean" || option["type"] == "boolean" {
					next["currentValue"] = text == "true"
				} else {
					next["currentValue"] = text
				}
				table[i] = next
				break
			}
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
				"result": map[string]any{"configOptions": table}})
		case "session/set_mode":
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{}})
		case "session/prompt":
			if os.Getenv("PIDECK_FAKE_ACP_DROP") == "1" {
				os.Exit(4)
			}
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
			permission := !ui || os.Getenv("PIDECK_FAKE_ACP_PERMISSION") == "1"
			if permission {
				toolID, toolTitle := "t1", "run"
				options := []map[string]string{{"optionId": "allow", "name": "Allow", "kind": "allow_once"}}
				if os.Getenv("PIDECK_FAKE_ACP_PERMISSION") == "1" {
					// The UI test's request names no tool: the card has to read
					// the running tool row (t2, the edit) instead.
					toolID, toolTitle = "t2", ""
					options = append(options, map[string]string{"optionId": "reject", "name": "Reject", "kind": "reject_once"})
				}
				permissionID, permissionPrompt = 99, msg.ID
				_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": permissionID, "method": "session/request_permission",
					"params": map[string]any{"sessionId": "s1", "toolCall": map[string]string{"toolCallId": toolID, "title": toolTitle},
						"options": options}})
				continue
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

func TestACPDisconnectFinishesPendingPrompt(t *testing.T) {
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_DROP", "1")
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=^TestFakeACPAgent$"}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	if _, err := c.initialize(); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { _, err := c.prompt("s1", "hi"); result <- err }()
	select {
	case err := <-result:
		if err == nil {
			t.Fatal("a lost process reported success")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("disconnect left the prompt waiting for its ordinary timeout")
	}
}

func TestACPResumeWithAdvertisedCapability(t *testing.T) {
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_RESUME", "1")
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=^TestFakeACPAgent$"}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	if _, err := c.initialize(); err != nil {
		t.Fatal(err)
	}
	state, err := c.loadSession("s1", t.TempDir())
	if err != nil || state.CurrentModeID != "resumed" {
		t.Fatalf("resume state = %+v, %v", state, err)
	}
	if len(state.Options) != 1 || state.Options[0].CurrentValue.text() != "high" ||
		!slices.EqualFunc(state.Options[0].Choices(), []string{"low", "high"}, func(o acpConfigChoice, v string) bool { return o.Value == v }) {
		t.Fatalf("resume config options = %+v", state.Options)
	}
}

// TestACPClient drives the handshake, a prompt and a permission request.
func TestACPClient(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	updates := make(chan acpUpdate, 8)
	perms := make(chan acpPermission, 1)
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=TestFakeACPAgent"}, nil,
		func(u acpUpdate) { updates <- u },
		func(p acpPermission) string { perms <- p; return "allow" }, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.stop()
	version, err := c.initialize()
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
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=TestFakeACPAgent"}, nil,
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

// TestACPHandshakeWaitsForASlowAgent checks the handshake budget covers a
// cold npx package instead of failing at 30 seconds: an agent that takes
// two seconds to answer is not an error.
func TestACPHandshakeWaitsForASlowAgent(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_SLOW_HANDSHAKE", "1")
	old := acpHandshakeTimeout
	acpHandshakeTimeout = 10 * time.Second
	defer func() { acpHandshakeTimeout = old }()
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=^TestFakeACPAgent$"}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.stop)
	if version, err := c.initialize(); err != nil || version != 1 {
		t.Fatalf("initialize = %d, %v; want 1 after the agent answered late", version, err)
	}
}

// TestACPHandshakeTimeoutNamesTheWait checks a silent agent ends the wait
// with the call, the budget and what it printed, instead of a bare
// "handshake failed".
func TestACPHandshakeTimeoutNamesTheWait(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_SLOW_HANDSHAKE", "1")
	old := acpHandshakeTimeout
	acpHandshakeTimeout = 250 * time.Millisecond
	defer func() { acpHandshakeTimeout = old }()
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=^TestFakeACPAgent$"}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.stop)
	started := time.Now()
	_, err = c.initialize()
	if err == nil {
		t.Fatal("a silent agent passed the handshake")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the wait took %s, want the configured budget", elapsed)
	}
	for _, want := range []string{"initialize", "没有响应", "250 毫秒"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q lacks %q", err.Error(), want)
		}
	}
}

// TestACPHandshakeFailsFastWhenAgentExits checks a CLI that dies answers
// at once, and that its stderr reaches the failure text: a broken login or
// a missing package is what the reader needs, not a timeout.
func TestACPHandshakeFailsFastWhenAgentExits(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP") == "1" {
		t.Skip("the helper process")
	}
	t.Setenv("PIDECK_FAKE_ACP", "1")
	t.Setenv("PIDECK_FAKE_ACP_CRASH_HANDSHAKE", "1")
	old := acpHandshakeTimeout
	acpHandshakeTimeout = 30 * time.Second
	defer func() { acpHandshakeTimeout = old }()
	c, err := startACP(t.TempDir(), os.Args[0], []string{"-test.run=^TestFakeACPAgent$"}, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.stop)
	started := time.Now()
	_, err = c.initialize()
	if err == nil {
		t.Fatal("a dead agent passed the handshake")
	}
	if elapsed := time.Since(started); elapsed > 5*time.Second {
		t.Fatalf("the failure took %s, want an exit instead of the full budget", elapsed)
	}
	detail := ""
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if detail = c.stderrText(); strings.Contains(detail, "boom") {
			break
		}
	}
	if !strings.Contains(detail, "boom") {
		t.Fatalf("agent stderr = %q, want what it printed", detail)
	}
	if got := acpStartDetail(err, c); !strings.Contains(got, "boom") {
		t.Fatalf("failure text %q lacks what the agent printed", got)
	}
}
