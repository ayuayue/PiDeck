//go:build !js && !android && !ios

package workbench

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestACPUsageUpdateAndCompactEligibility(t *testing.T) {
	stats, ok := updateACPContextUsage(sessionStats{}, 79, 100)
	if !ok || acpContextAboveThreshold(stats.ContextTokens, stats.ContextWindow) {
		t.Fatalf("79%% usage = %+v, valid=%t", stats, ok)
	}
	stats, ok = updateACPContextUsage(stats, 80, 100)
	if !ok || !acpContextAboveThreshold(stats.ContextTokens, stats.ContextWindow) {
		t.Fatalf("80%% usage = %+v, valid=%t", stats, ok)
	}
	if _, ok := updateACPContextUsage(stats, 1, 0); ok {
		t.Fatal("accepted a usage update with no context window")
	}

	commands := []acpCommand{{Name: "compact"}}
	for _, tc := range []struct {
		name     string
		preset   string
		stats    sessionStats
		commands []acpCommand
		pending  bool
		want     bool
	}{
		{name: "codex compact available", preset: "codex", stats: stats, commands: commands, pending: true, want: true},
		{name: "other agent", preset: "claude", stats: stats, commands: commands, pending: true},
		{name: "command absent", preset: "codex", stats: stats, pending: true},
		{name: "not pending", preset: "codex", stats: stats, commands: commands},
		{name: "below threshold", preset: "codex", stats: sessionStats{ContextTokens: 79, ContextWindow: 100}, commands: commands, pending: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := acpShouldAutoCompact(tc.preset, tc.stats, tc.commands, tc.pending); got != tc.want {
				t.Fatalf("acpShouldAutoCompact() = %t, want %t", got, tc.want)
			}
		})
	}
}

func TestACPDispatchUsageUpdateAndCompactionSuppression(t *testing.T) {
	var got []acpUpdate
	c := &acpClient{}
	c.setHooks(acpHooks{update: func(u acpUpdate) { got = append(got, u) }})
	c.dispatchUpdate(json.RawMessage(`{"sessionId":"s1","update":{"sessionUpdate":"usage_update","used":800,"size":1000}}`))
	c.compacting.Store(true)
	c.dispatchUpdate(json.RawMessage(`{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"summary"}}}`))
	if len(got) != 2 || got[0].Kind != "usage_update" || got[0].UsageUsed != 800 || got[0].UsageSize != 1000 {
		t.Fatalf("usage updates = %+v", got)
	}
	if got[0].SuppressContent || !got[1].SuppressContent || got[1].Text != "summary" {
		t.Fatalf("compaction projection flags = %+v", got)
	}
}

func TestFakeACPAutoCompactAgent(t *testing.T) {
	if os.Getenv("PIDECK_FAKE_ACP_AUTO_COMPACT") != "1" {
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
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{"protocolVersion": 1}})
		case "session/new":
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{"sessionId": "s-auto"}})
		case "session/prompt":
			var params struct {
				Prompt []struct {
					Text string `json:"text"`
				} `json:"prompt"`
			}
			if json.Unmarshal(msg.Params, &params) != nil || len(params.Prompt) == 0 {
				os.Exit(3)
			}
			text := params.Prompt[0].Text
			f, err := os.OpenFile(os.Getenv("PIDECK_FAKE_ACP_AUTO_COMPACT_LOG"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			if err != nil {
				os.Exit(4)
			}
			_, _ = f.WriteString(text + "\n")
			_ = f.Close()
			if text == "/compact" && os.Getenv("PIDECK_FAKE_ACP_COMPACT_ERROR") == "1" {
				_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID,
					"error": map[string]any{"code": -32000, "message": "compact failed"}})
				continue
			}
			stopReason := "end_turn"
			if text == "/compact" && os.Getenv("PIDECK_FAKE_ACP_COMPACT_CANCEL") == "1" {
				stopReason = "cancelled"
			}
			_ = enc.Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": map[string]any{"stopReason": stopReason}})
		}
	}
}

func TestACPPromptWithAutoCompactRunsNativeCommandFirst(t *testing.T) {
	for _, tc := range []struct {
		name          string
		env           string
		want          []string
		wantCompacted bool
		wantStop      string
	}{
		{name: "success", want: []string{"/compact", "next prompt"}, wantCompacted: true, wantStop: "end_turn"},
		{name: "compact error keeps user prompt", env: "PIDECK_FAKE_ACP_COMPACT_ERROR", want: []string{"/compact", "next prompt"}, wantStop: "end_turn"},
		{name: "cancel does not send user prompt", env: "PIDECK_FAKE_ACP_COMPACT_CANCEL", want: []string{"/compact"}, wantStop: "cancelled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if os.Getenv("PIDECK_FAKE_ACP_AUTO_COMPACT") == "1" {
				t.Skip("the helper process")
			}
			dir := t.TempDir()
			logPath := filepath.Join(dir, "prompts.log")
			t.Setenv("PIDECK_FAKE_ACP_AUTO_COMPACT", "1")
			t.Setenv("PIDECK_FAKE_ACP_AUTO_COMPACT_LOG", logPath)
			t.Setenv("PIDECK_FAKE_ACP_COMPACT_ERROR", "")
			t.Setenv("PIDECK_FAKE_ACP_COMPACT_CANCEL", "")
			if tc.env != "" {
				t.Setenv(tc.env, "1")
			}
			c, err := startACP(dir, os.Args[0], []string{"-test.run=^TestFakeACPAutoCompactAgent$"}, nil, nil, nil, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer c.stop()
			if _, err := c.initialize(); err != nil {
				t.Fatal(err)
			}
			sid, _, err := c.newSession(dir)
			if err != nil {
				t.Fatal(err)
			}
			result := make(chan struct {
				stop       string
				promptErr  error
				compactErr error
				compacted  bool
			}, 1)
			go func() {
				stop, promptErr, compactErr, compacted := c.promptWithAutoCompact(sid, "next prompt", nil, true, nil)
				result <- struct {
					stop       string
					promptErr  error
					compactErr error
					compacted  bool
				}{stop, promptErr, compactErr, compacted}
			}()
			var gotResult struct {
				stop       string
				promptErr  error
				compactErr error
				compacted  bool
			}
			select {
			case gotResult = <-result:
			case <-time.After(10 * time.Second):
				c.stop()
				t.Fatal("automatic compaction prompt did not finish within 10 seconds")
			}
			if gotResult.promptErr != nil || gotResult.stop != tc.wantStop {
				t.Fatalf("prompt result = %q, %v", gotResult.stop, gotResult.promptErr)
			}
			if tc.env == "PIDECK_FAKE_ACP_COMPACT_ERROR" && gotResult.compactErr == nil {
				t.Fatal("compact error was lost")
			}
			if gotResult.compacted != tc.wantCompacted {
				t.Fatalf("compacted = %t, want %t", gotResult.compacted, tc.wantCompacted)
			}
			data, err := os.ReadFile(logPath)
			if err != nil {
				t.Fatal(err)
			}
			got := strings.Split(strings.TrimSpace(string(data)), "\n")
			if len(got) != len(tc.want) {
				t.Fatalf("prompt sequence = %q, want %q", got, tc.want)
			}
			for i := range tc.want {
				if got[i] != tc.want[i] {
					t.Fatalf("prompt sequence = %q, want %q", got, tc.want)
				}
			}
		})
	}
}
