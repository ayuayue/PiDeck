package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func startMobileSendLifecycle(t *testing.T, status int) (*nsgotest.App, *mobileApp, func()) {
	t.Helper()
	app, a, wait, release := newComposerLifecycleApp(t, "/api/sessions/s1/prompt", status,
		map[string]string{"error": "send failed"})
	app.Post(func() {
		a.active.Set("s1")
		a.draft.Set("first message")
		a.pending.Set([]remotewire.Image{{Name: "first.png", MimeType: "image/png", Data: []byte("first")}})
		a.sendMessage()
	})
	app.Settle()
	wait()
	return app, a, release
}

func TestMobileSendKeepsEditedComposerOnFailure(t *testing.T) {
	app, a, release := startMobileSendLifecycle(t, http.StatusBadRequest)
	defer release()
	images := []remotewire.Image{{Name: "next.png", MimeType: "image/png", Data: []byte("next")}}
	app.Post(func() {
		a.draft.Set("next message")
		a.pending.Set(images)
	})
	app.Settle()
	release()
	app.WaitUntil(5*time.Second, func() bool { return !a.sending.GetUntracked() })
	if got := a.draft.GetUntracked(); got != "next message" || !reflect.DeepEqual(a.pending.GetUntracked(), images) {
		t.Fatalf("failed send replaced current composer: draft=%q images=%+v", got, a.pending.GetUntracked())
	}
	if got := a.sendErr.GetUntracked(); got != "send failed" {
		t.Fatalf("send error = %q, want send failed", got)
	}
}

func TestMobileSendRestoresUnchangedComposerOnFailure(t *testing.T) {
	app, a, release := startMobileSendLifecycle(t, http.StatusBadRequest)
	defer release()
	release()
	app.WaitUntil(5*time.Second, func() bool { return !a.sending.GetUntracked() })
	if got := a.draft.GetUntracked(); got != "first message" {
		t.Fatalf("failed send draft = %q, want first message", got)
	}
	if got := a.pending.GetUntracked(); len(got) != 1 || got[0].Name != "first.png" {
		t.Fatalf("failed send attachments = %+v, want first.png", got)
	}
}

func TestMobileSendClearsUnchangedComposerOnSuccess(t *testing.T) {
	app, a, release := startMobileSendLifecycle(t, http.StatusOK)
	defer release()
	release()
	app.WaitUntil(5*time.Second, func() bool { return !a.sending.GetUntracked() })
	if got := a.draft.GetUntracked(); got != "" {
		t.Fatalf("successful send draft = %q, want empty", got)
	}
	if got := a.pending.GetUntracked(); len(got) != 0 {
		t.Fatalf("successful send kept attachments: %+v", got)
	}
}

func TestMobileSendPreservesEditedComposerOnSuccess(t *testing.T) {
	app, a, release := startMobileSendLifecycle(t, http.StatusOK)
	defer release()
	images := []remotewire.Image{{Name: "next.png", MimeType: "image/png", Data: []byte("next")}}
	app.Post(func() {
		a.draft.Set("next message")
		a.pending.Set(images)
	})
	app.Settle()
	release()
	app.WaitUntil(5*time.Second, func() bool { return !a.sending.GetUntracked() })
	if got := a.draft.GetUntracked(); got != "next message" || !reflect.DeepEqual(a.pending.GetUntracked(), images) {
		t.Fatalf("successful send cleared current composer: draft=%q images=%+v", got, a.pending.GetUntracked())
	}
}

func TestMobileSendResetsBusyWhenLeavingVisit(t *testing.T) {
	for _, scenario := range []string{"switch", "revisit", "disconnect"} {
		t.Run(scenario, func(t *testing.T) {
			app, a, _, release := newComposerLifecycleApp(t, "/api/unused", http.StatusOK, map[string]string{})
			defer release()
			app.Post(func() {
				a.active.Set("s1")
				a.sending.Set(true)
				switch scenario {
				case "switch":
					a.openSession("s2", "Current")
				case "revisit":
					a.openSession("s2", "Current")
					a.openSession("s1", "Source")
				case "disconnect":
					a.connected.Set(true)
					a.disconnectWith("offline")
				}
			})
			app.Settle()
			if a.sending.GetUntracked() {
				t.Fatal("leaving the previous visit kept the composer busy")
			}
		})
	}
}

func TestMobileSendIgnoresPreviousVisit(t *testing.T) {
	for _, scenario := range []string{"switch", "revisit", "reconnect"} {
		t.Run(scenario, func(t *testing.T) {
			posts := make(chan func(), 2)
			started := make(chan string, 2)
			releaseFirst, releaseCurrent := make(chan struct{}), make(chan struct{})
			var releaseFirstOnce, releaseCurrentOnce sync.Once
			release := func() {
				releaseFirstOnce.Do(func() { close(releaseFirst) })
				releaseCurrentOnce.Do(func() { close(releaseCurrent) })
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request struct {
					Text string `json:"text"`
				}
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					http.Error(w, err.Error(), http.StatusBadRequest)
					return
				}
				started <- request.Text
				gate := releaseFirst
				if request.Text == "current message" {
					gate = releaseCurrent
				}
				<-gate
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusBadRequest)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": "send failed"})
			}))
			cx := core.NewRoot(core.RootOptions{CheckCommits: true, Post: func(fn func()) { posts <- fn }})
			t.Cleanup(cx.Dispose)
			t.Cleanup(server.Close)
			t.Cleanup(release)
			client := &remoteClient{base: server.URL, http: server.Client()}
			firstImage := []remotewire.Image{{Name: "first.png", MimeType: "image/png", Data: []byte("first")}}
			currentImage := []remotewire.Image{{Name: "current.png", MimeType: "image/png", Data: []byte("current")}}
			a := &mobileApp{
				cx:      cx,
				client:  client,
				active:  core.NewSignal(cx, "s1"),
				draft:   core.NewSignal(cx, "first message"),
				pending: core.NewSignalFunc(cx, firstImage, nil),
				sending: core.NewSignal(cx, false),
				sendErr: core.NewSignal(cx, ""),
				mode:    core.NewSignal(cx, modeGoal),
			}

			a.sendMessage()
			waitMobileSendRequest(t, started, "first message")
			switch scenario {
			case "switch":
				a.sessionSeq++
				a.active.Set("s2")
			case "revisit":
				a.sessionSeq++
				a.active.Set("s2")
				a.sessionSeq++
				a.active.Set("s1")
			case "reconnect":
				a.sessionSeq++
				a.client = nil
				a.active.Set("")
				a.client = &remoteClient{base: server.URL, http: server.Client()}
				a.active.Set("s2")
			}
			a.sending.Set(false)
			a.draft.Set("current message")
			a.pending.Set(currentImage)
			a.sendMessage()
			waitMobileSendRequest(t, started, "current message")
			a.sendErr.Set("current notice")

			releaseFirstOnce.Do(func() { close(releaseFirst) })
			nextMobileSendPost(t, posts)()
			if !a.sending.GetUntracked() {
				t.Fatal("previous visit released the current send")
			}
			if a.draft.GetUntracked() != "" || len(a.pending.GetUntracked()) != 0 {
				t.Fatalf("previous visit restored into the current send: draft=%q images=%+v", a.draft.GetUntracked(), a.pending.GetUntracked())
			}
			if got := a.sendErr.GetUntracked(); got != "current notice" {
				t.Fatalf("previous visit replaced the current notice: %q", got)
			}

			releaseCurrentOnce.Do(func() { close(releaseCurrent) })
			nextMobileSendPost(t, posts)()
			if a.sending.GetUntracked() || a.draft.GetUntracked() != "current message" || !reflect.DeepEqual(a.pending.GetUntracked(), currentImage) {
				t.Fatalf("current failure was not restored: sending=%v draft=%q images=%+v", a.sending.GetUntracked(), a.draft.GetUntracked(), a.pending.GetUntracked())
			}
		})
	}
}

func waitMobileSendRequest(t *testing.T, started <-chan string, want string) {
	t.Helper()
	select {
	case got := <-started:
		if got != want {
			t.Fatalf("send request text = %q, want %q", got, want)
		}
	case <-time.After(5 * time.Second):
		t.Fatalf("send request %q did not reach the server", want)
	}
}

func nextMobileSendPost(t *testing.T, posts <-chan func()) func() {
	t.Helper()
	select {
	case fn := <-posts:
		return fn
	case <-time.After(5 * time.Second):
		t.Fatal("send completion was not posted")
		return nil
	}
}
