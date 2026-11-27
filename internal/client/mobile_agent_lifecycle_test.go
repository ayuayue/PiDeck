package client

import (
	"net/http"
	"testing"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
)

func newAgentCreationTestApp(t *testing.T) (*mobileApp, <-chan func()) {
	t.Helper()
	a, posts := newSessionReadTestApp(t)
	a.features = newMobileSessionFeatures(a.cx)
	a.agentsOpen = core.NewSignal(a.cx, false)
	a.agentsErr = core.NewSignal(a.cx, "")
	a.notice = core.NewSignal(a.cx, "")
	a.state.Set(remotewire.Snapshot{Projects: []remotewire.Project{{Path: "/project"}}})
	return a, posts
}

func finishAgentCreationReads(t *testing.T, posts <-chan func(), reads <-chan pendingSessionRead, id string) {
	t.Helper()
	for range 3 {
		read := nextSessionRead(t, reads)
		var reply any
		switch read.path {
		case "/api/session/" + id:
			reply = remotewire.Transcript{ID: id, Title: "Current"}
		case "/api/session/" + id + "/options":
			reply = remotewire.Options{}
		case "/api/state":
			reply = remotewire.Snapshot{Projects: []remotewire.Project{{Path: "/project"}}}
		default:
			t.Fatalf("unexpected request after creation: %s", read.path)
		}
		replySessionRead(t, posts, read, http.StatusOK, reply)
	}
}

func TestMobileAgentCreationIgnoresPreviousVisit(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
		for _, scenario := range []string{"disconnect", "switch", "revisit"} {
			t.Run(http.StatusText(status)+"/"+scenario, func(t *testing.T) {
				a, posts := newAgentCreationTestApp(t)
				client, reads := newSessionReadServer(t)
				a.client = client
				a.connected.Set(true)
				a.startAgent(remotewire.Agent{ID: "old", Name: "Old"})
				request := nextSessionRead(t, reads)
				switch scenario {
				case "disconnect":
					a.disconnectWith("left server")
					if a.creating.GetUntracked() {
						t.Error("disconnect kept the previous creation busy")
					}
				default:
					openSessionForReadTest(t, a, posts, reads, "current")
					if scenario == "revisit" {
						a.closeSession()
					}
				}
				wantID := a.active.GetUntracked()
				a.agentsErr.Set("current error")
				a.notice.Set("current notice")
				replySessionRead(t, posts, request, status, map[string]string{"id": "old-created", "title": "Old", "error": "old request failed"})
				if a.active.GetUntracked() != wantID || a.agentsErr.GetUntracked() != "current error" || a.notice.GetUntracked() != "current notice" {
					t.Fatalf("old creation changed current page: active=%q error=%q notice=%q", a.active.GetUntracked(), a.agentsErr.GetUntracked(), a.notice.GetUntracked())
				}
				if a.creating.GetUntracked() {
					t.Fatal("old creation did not release its busy state")
				}
			})
		}
	}
}

func TestMobileAgentCreationCannotFinishNewConnectionRequest(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			a, posts := newAgentCreationTestApp(t)
			old, oldReads := newSessionReadServer(t)
			a.client = old
			a.connected.Set(true)
			a.startAgent(remotewire.Agent{ID: "old", Name: "Old"})
			oldRequest := nextSessionRead(t, oldReads)
			a.disconnect()
			current, reads := newSessionReadServer(t)
			a.client = current
			a.connected.Set(true)
			a.state.Set(remotewire.Snapshot{Projects: []remotewire.Project{{Path: "/project"}}})
			a.startAgent(remotewire.Agent{ID: "current", Name: "Current"})
			request := nextSessionRead(t, reads)
			a.agentsErr.Set("current error")
			a.notice.Set("current notice")
			replySessionRead(t, posts, oldRequest, status, map[string]string{"id": "old-created", "title": "Old", "error": "old request failed"})
			if !a.creating.GetUntracked() || a.active.GetUntracked() != "" || a.agentsErr.GetUntracked() != "current error" || a.notice.GetUntracked() != "current notice" {
				t.Fatal("old creation changed the new connection's pending request")
			}
			replySessionRead(t, posts, request, http.StatusOK, map[string]string{"id": "current-created", "title": "Current"})
			if a.creating.GetUntracked() || a.active.GetUntracked() != "current-created" || a.activeTitle.GetUntracked() != "Current" {
				t.Fatal("current creation did not open its session")
			}
			finishAgentCreationReads(t, posts, reads, "current-created")
		})
	}
}

func TestMobileAgentCreationCurrentErrorAllowsRetry(t *testing.T) {
	a, posts := newAgentCreationTestApp(t)
	client, reads := newSessionReadServer(t)
	a.client = client
	a.startAgent(remotewire.Agent{ID: "current", Name: "Current"})
	request := nextSessionRead(t, reads)
	replySessionRead(t, posts, request, http.StatusBadRequest, map[string]string{"error": "current request failed"})
	if a.creating.GetUntracked() || a.active.GetUntracked() != "" || a.agentsErr.GetUntracked() == "" {
		t.Fatal("current error did not release creation and report the failure")
	}
	a.startAgent(remotewire.Agent{ID: "retry", Name: "Retry"})
	request = nextSessionRead(t, reads)
	replySessionRead(t, posts, request, http.StatusOK, map[string]string{"id": "retried", "title": "Retry"})
	if a.creating.GetUntracked() || a.active.GetUntracked() != "retried" {
		t.Fatal("retry did not open its session")
	}
	finishAgentCreationReads(t, posts, reads, "retried")
}
