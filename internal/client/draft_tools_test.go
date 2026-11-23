package client

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func TestMobileDraftToolPreservesConcurrentInput(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless HTTP regression")
	}
	for _, action := range []string{"edit", "send", "switch", "predict"} {
		t.Run(action, func(t *testing.T) {
			t.Setenv("PIDECK_V2_HOME", t.TempDir())
			release := make(chan struct{})
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				<-release
				w.Header().Set("Content-Type", "application/json")
				w.Write([]byte(`{"text":"model result"}`))
			}))
			defer srv.Close()
			var a *mobileApp
			screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
				a = newMobileApp(cx)
				a.client = &remoteClient{base: srv.URL, http: srv.Client()}
				a.active.Set("source")
				return core.View{Style: ui.FillRest, Children: []core.Node{a.draftChangeBar()}}
			}, nsgotest.Size(390, 800))
			a.draft.Set("original")
			tool := "prompt"
			if action == "predict" {
				tool = "predict"
			}
			a.runDraftTool(tool)
			next := "typed while waiting"
			if action == "send" {
				next = ""
			}
			if action == "switch" {
				a.active.Set("another session")
				next = "original"
			}
			a.draft.Set(next)
			close(release)
			screen.WaitUntil(5*time.Second, func() bool { return a.aiBusy.GetUntracked() == "" })
			if got := a.draft.GetUntracked(); got != next {
				t.Fatalf("late result after %s overwrote input: got %q, want %q", action, got, next)
			}
			change := a.draftChange.GetUntracked()
			if change == nil || change.Applied || a.draftChangeOwner != "source" {
				t.Fatalf("late result was not retained for source: %+v", change)
			}
			a.active.Set("source")
			screen.WaitFor("id:draft-change-apply", time.Second)
			screen.Press("id:draft-change-apply")
			if a.draft.GetUntracked() != change.After {
				t.Fatal("explicit apply lost the result")
			}
			screen.Press("id:draft-change-undo")
			if a.draft.GetUntracked() != next {
				t.Fatal("undo did not restore the latest input")
			}
		})
	}
}

func TestMobileDraftChangeDoesNotCrossConnections(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("headless state regression")
	}
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	var a *mobileApp
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node { a = newMobileApp(cx); return core.View{} }, nsgotest.Size(390, 800))
	old, next := &remoteClient{}, &remoteClient{}
	a.client = next
	a.active.Set("same-id")
	a.draft.Set("new connection draft")
	a.offerDraftChange(old, "same-id", "new connection draft", "old server result")
	screen.Settle()
	if a.draft.GetUntracked() != "new connection draft" || a.draftChange.GetUntracked() != nil {
		t.Fatal("old connection result reached a new connection")
	}
	a.offerDraftChange(next, "same-id", "new connection draft", "enhanced")
	a.draft.Set("keep typing")
	a.undoDraftChange()
	if a.draft.GetUntracked() != "keep typing" {
		t.Fatal("undo overwrote later mobile input")
	}
}
