//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui/chat"
)

func TestRemoteCommandDiscovery(t *testing.T) {
	a, s, screen, calls := remoteCommandFixture(t, func(command map[string]any) map[string]any {
		return map[string]any{"data": map[string]any{"commands": []map[string]any{
			{"name": "plan", "description": "Plan the task", "source": "extension", "sourceInfo": map[string]any{"path": "/private/extension.ts"}},
			{"name": "skill:review", "source": "skill"},
			{"name": "compact"}, {"name": "plan"}, {"name": "invalid name"},
		}}}
	})
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		rec := httptest.NewRecorder()
		(&remoteHost{app: a}).handleSession(rec, httptest.NewRequest(http.MethodGet, "/api/session/"+s.ID+"/commands", nil))
		done <- rec
	}()
	var rec *httptest.ResponseRecorder
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case rec = <-done:
			return true
		default:
			return false
		}
	})
	if rec.Code != http.StatusOK {
		t.Fatalf("discovery = %d: %s", rec.Code, rec.Body.String())
	}
	var result remotewire.Commands
	if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Commands) != 3 || result.Commands[0].Name != "compact" || result.Commands[1].Name != "plan" || result.Commands[2].Name != "skill:review" {
		t.Fatalf("unexpected command catalog: %+v", result)
	}
	if strings.Contains(rec.Body.String(), "private") || strings.Contains(rec.Body.String(), "sourceInfo") {
		t.Fatalf("discovery leaked command source paths: %s", rec.Body.String())
	}
	select {
	case call := <-calls:
		if call["type"] != "get_commands" {
			t.Fatalf("discovery sent %v", call)
		}
	default:
		t.Fatal("discovery did not query pi")
	}
}

func TestRemoteSlashCommandFailureAndTrust(t *testing.T) {
	for _, untrusted := range []bool{false, true} {
		name := "pi refuses"
		if untrusted {
			name = "untrusted"
		}
		t.Run(name, func(t *testing.T) {
			a, s, screen, calls := remoteCommandFixture(t, func(map[string]any) map[string]any {
				return map[string]any{"success": false, "error": "fixture command rejected"}
			})
			if untrusted {
				a.workspaces.Set([]*workspace{{Path: s.WS, Target: s.Target}})
			}
			rec := postRemoteCommand(t, a, s, screen, "/extension arg", nil)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("failure = %d: %s", rec.Code, rec.Body.String())
			}
			if !untrusted && !strings.Contains(rec.Body.String(), "fixture command rejected") {
				t.Fatalf("lost pi error: %s", rec.Body.String())
			}
			if len(s.turns.GetUntracked()) != 0 {
				t.Fatal("failed extension created a fabricated prompt turn")
			}
			if untrusted {
				select {
				case call := <-calls:
					t.Fatalf("untrusted command reached pi: %v", call)
				default:
				}
			}
		})
	}
}

func TestRemoteSessionActivityLinksAndTaskCompletion(t *testing.T) {
	a, parent, screen, _ := remoteCommandFixture(t)
	child := a.blankSession("child", &workspace{}, "Child")
	parent.File, child.File, child.Parent = "/private/parent.jsonl", "/private/child.jsonl", "/private/parent.jsonl"
	parent.loaded.Set(true)
	child.loaded.Set(true)
	child.runningSig.Set(true)
	ws := &workspace{Target: parent.Target, Sessions: core.NewSignalFunc(a.cx, []*session{parent, child}, nil), Pi: core.NewSignalFunc(a.cx, []*session(nil), nil)}
	a.workspaces.Set([]*workspace{ws})
	parent.turns.Set([]turn{
		{ID: "source", Steps: []turnStep{{Tools: []toolRun{{CallID: "review", Name: "Agent", Action: "子代理", Detail: "Review the task", Status: chat.Completed,
			Output: "Agent started in background.\nAgent ID: worker-1\nType: Explore"}}}}},
		{ID: "notice", Prompt: "<task-notification><task-id>worker-1</task-id><status>completed</status><result>Done</result></task-notification>"},
	})
	type result struct {
		transcript remotewire.Transcript
		err        error
	}
	done := make(chan result, 1)
	go func() { transcript, err := a.remoteTranscript(parent.ID, 0); done <- result{transcript, err} }()
	var got result
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case got = <-done:
			return true
		default:
			return false
		}
	})
	if got.err != nil {
		t.Fatal(got.err)
	}
	activity := got.transcript.Activity
	if activity == nil || len(activity.Children) != 1 || activity.Children[0].ID != child.ID || activity.Children[0].State != "running" {
		t.Fatalf("missing live child link: %+v", activity)
	}
	if len(activity.Delegations) != 1 || activity.Delegations[0].State != "completed" || activity.Delegations[0].Turn != 0 {
		t.Fatalf("background task did not settle: %+v", activity.Delegations)
	}
	back := a.remoteSessionActivity(child)
	if back.Parent == nil || back.Parent.ID != parent.ID {
		t.Fatalf("missing return link: %+v", back)
	}
	wire, err := json.Marshal(activity)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(wire), "/private/") {
		t.Fatalf("session links leaked file paths: %s", wire)
	}
}
