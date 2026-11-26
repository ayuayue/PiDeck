package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

// Hold one response until the test has navigated, without delaying the
// transcript and options requests made by opening the destination session.
func newComposerLifecycleApp(t *testing.T, path string, status int, reply any) (*nsgotest.App, *mobileApp, func(), func()) {
	t.Helper()
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	started, release := make(chan struct{}, 1), make(chan struct{})
	var once sync.Once
	finish := func() { once.Do(func() { close(release) }) }
	snap := remotewire.Snapshot{Projects: []remotewire.Project{{Path: "/tmp/project", Sessions: []remotewire.Session{
		{ID: "s1", Title: "Source", Mode: modeGoal}, {ID: "s2", Title: "Current", Mode: modeGoal},
	}}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == path:
			select {
			case started <- struct{}{}:
			default:
			}
			select {
			case <-release:
				w.WriteHeader(status)
				_ = json.NewEncoder(w).Encode(reply)
			case <-r.Context().Done():
			}
		case r.URL.Path == "/api/state":
			_ = json.NewEncoder(w).Encode(snap)
		case strings.HasSuffix(r.URL.Path, "/options"):
			_ = json.NewEncoder(w).Encode(remotewire.Options{Mode: modeGoal})
		case strings.HasSuffix(r.URL.Path, "/image"):
			_ = json.NewEncoder(w).Encode(remotewire.Pictures{Images: []remotewire.Picture{{Mime: "image/png", Data: testPixel}}})
		default:
			_ = json.NewEncoder(w).Encode(map[string]string{})
		}
	}))
	t.Cleanup(srv.Close)
	var a *mobileApp
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newMobileApp(cx)
		a.client = &remoteClient{base: srv.URL, http: srv.Client()}
		a.state.Set(snap)
		return core.View{}
	}, nsgotest.ManualFrames())
	t.Cleanup(finish)
	wait := func() {
		app.WaitUntil(5*time.Second, func() bool { return len(started) > 0 })
	}
	return app, a, wait, finish
}

func moveComposerVisit(a *mobileApp, scenario string) string {
	switch scenario {
	case "switch":
		a.openSession("s2", "Current")
	case "revisit":
		id, title := a.active.GetUntracked(), a.activeTitle.GetUntracked()
		a.openSession("s2", "Current")
		if id == "" {
			a.closeSession()
		} else {
			a.openSession(id, title)
		}
	case "reconnect":
		old := a.client
		a.client = &remoteClient{base: old.base, http: old.http}
	}
	return a.active.GetUntracked()
}

func TestMobileInitOptionsIgnoresPreviousVisit(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
		for _, scenario := range []string{"switch", "revisit", "reconnect"} {
			t.Run(http.StatusText(status)+"/"+scenario, func(t *testing.T) {
				var reply any = map[string]string{"id": "created", "title": "Created"}
				if status != http.StatusOK {
					reply = map[string]string{"error": "old request failed"}
				}
				app, a, wait, release := newComposerLifecycleApp(t, "/api/sessions", status, reply)
				app.Post(a.openInitOptions)
				app.Settle()
				wait()
				var wantID string
				images := []remotewire.Image{{Name: "keep.png", Data: []byte("keep")}}
				app.Post(func() {
					wantID = moveComposerVisit(a, scenario)
					a.draft.Set("current draft")
					a.pending.Set(images)
					a.initDraft.Set("next starting draft")
					a.initPending.Set(images)
					a.err.Set("current notice")
				})
				app.Settle()
				release()
				app.WaitUntil(5*time.Second, func() bool { return !a.initSending.GetUntracked() })
				if a.active.GetUntracked() != wantID || a.optionsOpen.GetUntracked() {
					t.Fatalf("late creation changed page: active=%q optionsOpen=%v; want %q, false", a.active.GetUntracked(), a.optionsOpen.GetUntracked(), wantID)
				}
				if a.draft.GetUntracked() != "current draft" || a.initDraft.GetUntracked() != "next starting draft" ||
					!reflect.DeepEqual(a.pending.GetUntracked(), images) || !reflect.DeepEqual(a.initPending.GetUntracked(), images) {
					t.Fatal("late creation replaced or cleared current input")
				}
				if got := a.err.GetUntracked(); got != "current notice" {
					t.Fatalf("late creation replaced current notice: %q", got)
				}
			})
		}
	}
}

func TestMobileInitOptionsKeepsCurrentDraft(t *testing.T) {
	app, a, wait, release := newComposerLifecycleApp(t, "/api/sessions", http.StatusOK, map[string]string{"id": "created", "title": "Created"})
	images := []remotewire.Image{{Name: "keep.png", Data: []byte("keep")}}
	app.Post(func() {
		a.initDraft.Set("initial draft")
		a.openInitOptions()
		a.initDraft.Set("typed while waiting")
		a.initPending.Set(images)
	})
	app.Settle()
	wait()
	release()
	app.WaitUntil(5*time.Second, func() bool { return !a.initSending.GetUntracked() && a.optionsOpen.GetUntracked() })
	if a.active.GetUntracked() != "created" || a.draft.GetUntracked() != "typed while waiting" || !reflect.DeepEqual(a.pending.GetUntracked(), images) {
		t.Fatal("current creation did not open the new session with the latest input")
	}
	if a.initDraft.GetUntracked() != "" || len(a.initPending.GetUntracked()) != 0 {
		t.Fatal("current creation left a duplicate starting draft")
	}
	app.WaitUntil(5*time.Second, func() bool { return loadMobileSaved(a.cx).Project == "/tmp/project" })
}

func TestMobileImageIgnoresPreviousVisit(t *testing.T) {
	for _, phase := range []string{"image", "mode"} {
		for _, status := range []int{http.StatusOK, http.StatusBadRequest} {
			for _, scenario := range []string{"switch", "revisit", "reconnect"} {
				t.Run(phase+"/"+http.StatusText(status)+"/"+scenario, func(t *testing.T) {
					var reply any = remotewire.Pictures{Images: []remotewire.Picture{{Mime: "image/png", Data: testPixel}}}
					if phase == "mode" {
						reply = map[string]string{"mode": ""}
					}
					if status != http.StatusOK {
						reply = map[string]string{"error": "old image request failed"}
					}
					app, a, wait, release := newComposerLifecycleApp(t, "/api/sessions/s1/"+phase, status, reply)
					app.Post(func() {
						a.active.Set("s1")
						a.draft.Set("draw this")
						a.mode.Set(modeImage)
						a.drawImage()
					})
					app.Settle()
					wait()
					images := []remotewire.Image{{Name: "keep.png", Data: []byte("keep")}}
					var wantID string
					app.Post(func() {
						wantID = moveComposerVisit(a, scenario)
						a.draft.Set("current draft")
						a.pending.Set(images)
						a.mode.Set(modeGoal)
						a.sendErr.Set("current notice")
					})
					app.Settle()
					release()
					app.WaitUntil(5*time.Second, func() bool { return a.aiBusy.GetUntracked() == "" })
					if a.active.GetUntracked() != wantID || a.draft.GetUntracked() != "current draft" || !reflect.DeepEqual(a.pending.GetUntracked(), images) || a.mode.GetUntracked() != modeGoal {
						t.Fatal("late image changed the current session's input or mode")
					}
					if got := a.sendErr.GetUntracked(); got != "current notice" {
						t.Fatalf("late image replaced current notice: %q", got)
					}
				})
			}
		}
	}
}

func TestMobileImagePreservesConcurrentInput(t *testing.T) {
	for _, action := range []string{"unchanged", "edit", "send", "mode"} {
		t.Run(action, func(t *testing.T) {
			app, a, wait, release := newComposerLifecycleApp(t, "/api/sessions/s1/image", http.StatusOK,
				remotewire.Pictures{Images: []remotewire.Picture{{Mime: "image/png", Data: testPixel}}})
			wantDraft, wantMode := "", ""
			app.Post(func() {
				a.active.Set("s1")
				a.draft.Set(" draw this ")
				a.mode.Set(modeImage)
				a.drawImage()
				switch action {
				case "edit":
					wantDraft = "next message"
					a.draft.Set(wantDraft)
				case "send":
					a.draft.Set("")
				case "mode":
					wantMode = modeGoal
					a.mode.Set(wantMode)
				}
				a.pending.Set([]remotewire.Image{{Name: "keep.png", Data: []byte("keep")}})
			})
			app.Settle()
			wait()
			release()
			app.WaitUntil(5*time.Second, func() bool { return a.aiBusy.GetUntracked() == "" })
			if got := a.draft.GetUntracked(); got != wantDraft {
				t.Fatalf("image completion replaced concurrent input: got %q, want %q", got, wantDraft)
			}
			if got := a.mode.GetUntracked(); got != wantMode {
				t.Fatalf("image completion replaced chosen mode: got %q, want %q", got, wantMode)
			}
			images := a.pending.GetUntracked()
			if len(images) != 2 || images[0].Name != "keep.png" || images[1].Name != "generated.png" || len(images[1].Data) == 0 {
				t.Fatalf("current image was not added alongside the existing attachment: %+v", images)
			}
		})
	}
}

func TestMobileImageReportsCurrentFailure(t *testing.T) {
	for _, phase := range []string{"image", "mode"} {
		t.Run(phase, func(t *testing.T) {
			app, a, wait, release := newComposerLifecycleApp(t, "/api/sessions/s1/"+phase, http.StatusBadRequest,
				map[string]string{"error": "current request failed"})
			app.Post(func() {
				a.active.Set("s1")
				a.draft.Set("draw this")
				a.mode.Set(modeImage)
				a.drawImage()
			})
			app.Settle()
			wait()
			release()
			app.WaitUntil(5*time.Second, func() bool { return a.aiBusy.GetUntracked() == "" })
			if a.mode.GetUntracked() != modeImage || a.sendErr.GetUntracked() != "current request failed" {
				t.Fatalf("current failure was not retained: mode=%q error=%q", a.mode.GetUntracked(), a.sendErr.GetUntracked())
			}
			wantDraft, wantImages := "draw this", 0
			if phase == "mode" {
				wantDraft, wantImages = "", 1
			}
			if a.draft.GetUntracked() != wantDraft || len(a.pending.GetUntracked()) != wantImages {
				t.Fatal("failure did not preserve the prompt or the successfully generated image")
			}
		})
	}
}
