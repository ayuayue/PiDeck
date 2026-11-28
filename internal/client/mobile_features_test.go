package client

import (
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestMobileCommandCandidatesAndRetry(t *testing.T) {
	for _, refuseFirst := range []bool{false, true} {
		name := "candidates"
		if refuseFirst {
			name = "retry"
		}
		t.Run(name, func(t *testing.T) {
			desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "电脑上的会话"})
			var reads atomic.Int32
			original := desk.server.Config.Handler
			desk.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.HasSuffix(r.URL.Path, "/commands") {
					original.ServeHTTP(w, r)
					return
				}
				if r.Header.Get("Authorization") != "Bearer "+desk.token {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				count := reads.Add(1)
				if refuseFirst && count == 1 {
					w.WriteHeader(http.StatusBadRequest)
					_ = json.NewEncoder(w).Encode(map[string]string{"error": "fixture command lookup failed"})
					return
				}
				_ = json.NewEncoder(w).Encode(remotewire.Commands{Commands: []remotewire.Command{
					{Name: "compact", Description: "压缩上下文"}, {Name: "plan", Description: "任务计划"}, {Name: "skill:review"},
				}})
			})
			var screen *nsgotest.App
			desk.open(t, &screen)
			screen.WaitFor("id:mobile-session", 5*time.Second)
			screen.Press("id:mobile-session")
			screen.WaitFor("text:先前的回复", 5*time.Second)
			screen.Type("id:mobile-draft", "/pl")
			if refuseFirst {
				screen.WaitFor("id:mobile-command-retry", 5*time.Second)
				if draftValue(screen) != "/pl" {
					t.Fatal("lookup failure changed the draft")
				}
				screen.Press("id:mobile-command-retry")
			}
			screen.WaitFor("id:mobile-command:plan", 5*time.Second)
			if len(screen.Query("id:mobile-command:compact")) != 0 {
				t.Fatal("command filter ignored prefix")
			}
			screen.Press("id:mobile-command:plan")
			screen.WaitUntil(5*time.Second, func() bool { return draftValue(screen) == "/plan " })
			screen.WaitForGone("id:mobile-commands", 5*time.Second)
			screen.Press("id:mobile-send")
			screen.WaitUntil(5*time.Second, func() bool { sent := desk.sentPrompts(); return len(sent) == 1 && sent[0] == "/plan" })
		})
	}
}

func TestMobileSubagentNavigation(t *testing.T) {
	desk := newComposerDesktop(t, remotewire.Session{ID: "s1", Title: "Parent"}, remotewire.Session{ID: "s2", ParentID: "s1", Title: "Child"})
	original := desk.server.Config.Handler
	desk.server.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var transcript remotewire.Transcript
		switch r.URL.Path {
		case "/api/session/s1":
			transcript = remotewire.Transcript{ID: "s1", Title: "Parent", Messages: []remotewire.Message{
				{Role: "tool", Tool: &remotewire.ToolLine{Name: "Agent", Action: "子代理", Detail: "Review source detail", Status: "done", Output: "Review finished"}},
				{Role: "assistant", Text: "Parent answer"},
			},
				Activity: &remotewire.SessionActivity{Children: []remotewire.SessionRef{{ID: "s2", Title: "Child", State: "running"}},
					Delegations: []remotewire.Delegation{{ID: "review", Name: "Review task", State: "completed", Turn: 0}}}}
		case "/api/session/s2":
			transcript = remotewire.Transcript{ID: "s2", Title: "Child", Messages: []remotewire.Message{{Role: "assistant", Text: "Child answer"}},
				Activity: &remotewire.SessionActivity{Parent: &remotewire.SessionRef{ID: "s1", Title: "Parent", State: "ready"}}}
		default:
			original.ServeHTTP(w, r)
			return
		}
		if r.Header.Get("Authorization") != "Bearer "+desk.token {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(transcript)
	})
	var screen *nsgotest.App
	desk.open(t, &screen)
	screen.WaitFor("text:Parent", 5*time.Second)
	screen.Press("text:Parent")
	screen.WaitFor("text:Parent answer", 5*time.Second)
	screen.Resize(375, 760)
	screen.WaitFor("id:mobile-subagent:session:s2 >> text:运行中", 5*time.Second)
	for _, id := range []string{"mobile-send", "mobile-subagent:session:s2"} {
		bounds := screen.Find("id:" + id).Bounds()
		if bounds.Origin.X < 0 || bounds.Origin.X+bounds.Size.Width > 375 || bounds.Size.Width <= 0 {
			t.Fatalf("%s is clipped on a phone: %+v", id, bounds)
		}
	}
	shot(screen, "mobile/subagent-narrow")
	screen.Press("id:mobile-subagents-all")
	screen.WaitFor("id:mobile-subagent-all:tool:review >> text:已完成", 5*time.Second)
	screen.Press("id:mobile-subagent-all:tool:review")
	screen.WaitForGone("id:mobile-subagents-sheet", 5*time.Second)
	screen.WaitFor("text:Review source detail", 5*time.Second)
	screen.Press("id:mobile-subagent:session:s2")
	screen.WaitFor("text:Child answer", 5*time.Second)
	screen.Press("id:mobile-subagent-parent")
	screen.WaitFor("text:Parent answer", 5*time.Second)
}

func TestMobileSessionTreeKeepsFamiliesAndOrphansVisible(t *testing.T) {
	now := time.Date(2026, time.November, 26, 12, 0, 0, 0, time.UTC)
	old := now.AddDate(0, 0, -30).UnixMilli()
	list := []remotewire.Session{
		{ID: "child", ParentID: "parent", Updated: now.UnixMilli()}, {ID: "parent", Updated: old},
		{ID: "orphan", ParentID: "missing", Updated: old},
		{ID: "cycle-a", ParentID: "cycle-b", Updated: old}, {ID: "cycle-b", ParentID: "cycle-a", Updated: old},
	}
	recent, earlier := mobileSessionBranches(list, now)
	if len(recent) != 2 || recent[0].session.ID != "parent" || recent[1].session.ID != "child" || recent[1].depth != 1 {
		t.Fatalf("active child lost its older parent: %+v", recent)
	}
	if len(earlier) != 3 {
		t.Fatalf("orphan or cycle disappeared: %+v", earlier)
	}
	for _, row := range earlier {
		if row.depth != 0 {
			t.Fatalf("invalid parent link indented a root: %+v", row)
		}
	}
}
