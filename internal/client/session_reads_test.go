package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
)

func newSessionReadTestApp(t *testing.T) (*mobileApp, <-chan func()) {
	t.Helper()
	a, posts := newConnectionTestApp(t)
	cx := a.cx
	a.activeTitle = core.NewSignal(cx, "")
	a.sendErr = core.NewSignal(cx, "")
	a.transcriptTruncated = core.NewSignal(cx, false)
	a.messagesBefore = core.NewSignal(cx, 0)
	a.askText = core.NewSignal(cx, "")
	a.findOpen = core.NewSignal(cx, false)
	a.findText = core.NewSignal(cx, "")
	a.findSelected = core.NewSignal(cx, transcriptRowKey{})
	a.transcriptPicture = core.NewSignalFunc(cx, transcriptPicture{}, nil)
	a.options = core.NewSignalFunc(cx, remotewire.Options{}, nil)
	a.mode = core.NewSignal(cx, "")
	return a, posts
}

type sessionReadReply struct {
	status int
	body   any
}

type pendingSessionRead struct {
	path   string
	before string
	reply  chan sessionReadReply
}

// Each HTTP read waits for its own reply, so navigation and reply order are
// controlled by the test instead of a sleep or a live polling loop.
func newSessionReadServer(t *testing.T) (*remoteClient, <-chan pendingSessionRead) {
	t.Helper()
	reads := make(chan pendingSessionRead, 8)
	stop := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		read := pendingSessionRead{path: r.URL.Path, before: r.URL.Query().Get("before"), reply: make(chan sessionReadReply, 1)}
		select {
		case reads <- read:
		case <-stop:
			return
		}
		select {
		case reply := <-read.reply:
			w.WriteHeader(reply.status)
			_ = json.NewEncoder(w).Encode(reply.body)
		case <-r.Context().Done():
		case <-stop:
		}
	}))
	t.Cleanup(func() { close(stop); srv.Close() })
	return &remoteClient{base: srv.URL, source: srv.URL, token: "fixture", http: srv.Client()}, reads
}

// newSessionReadClient is a second client on the same fixture server, the
// way a reconnected phone holds a new one: a copy of a client would copy its
// locks, so the fields are rebuilt.
func newSessionReadClient(c *remoteClient) *remoteClient {
	next := &remoteClient{base: c.base, source: c.source, http: c.http}
	next.tokenMu.Lock()
	next.token = c.currentToken()
	next.tokenMu.Unlock()
	return next
}

func nextSessionRead(t *testing.T, reads <-chan pendingSessionRead) pendingSessionRead {
	t.Helper()
	select {
	case read := <-reads:
		return read
	case <-time.After(5 * time.Second):
		t.Fatal("session read did not reach the server")
		return pendingSessionRead{}
	}
}

func replySessionRead(t *testing.T, posts <-chan func(), read pendingSessionRead, status int, body any) {
	t.Helper()
	read.reply <- sessionReadReply{status: status, body: body}
	runConnectionPost(t, posts)
}

func openSessionForReadTest(t *testing.T, a *mobileApp, posts <-chan func(), reads <-chan pendingSessionRead, id string) {
	t.Helper()
	a.openSession(id, "current")
	for range 2 {
		read := nextSessionRead(t, reads)
		switch read.path {
		case "/api/session/" + id:
			replySessionRead(t, posts, read, http.StatusOK, remotewire.Transcript{
				ID: id, Title: "current", Before: 4, Messages: []remotewire.Message{{Turn: 4, Role: "user", Text: "current"}},
			})
		case "/api/session/" + id + "/options":
			replySessionRead(t, posts, read, http.StatusOK, remotewire.Options{Model: "current-model", Mode: "goal"})
		default:
			t.Fatalf("unexpected session read: %s", read.path)
		}
	}
}

func TestMobileOlderTranscriptIgnoresPreviousVisit(t *testing.T) {
	for _, navigation := range []string{"switch session", "switch back", "reopen session", "switch connection"} {
		for _, status := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusForbidden} {
			t.Run(navigation+"/"+http.StatusText(status), func(t *testing.T) {
				a, posts := newSessionReadTestApp(t)
				client, reads := newSessionReadServer(t)
				a.client = client
				a.connected.Set(true)
				openSessionForReadTest(t, a, posts, reads, "s1")
				a.loadOlderTranscript()
				old := nextSessionRead(t, reads)
				if old.before != "4" {
					t.Fatalf("history cursor = %q, want 4", old.before)
				}

				id := "s1"
				switch navigation {
				case "switch session":
					id = "s2"
				case "switch back":
					openSessionForReadTest(t, a, posts, reads, "s2")
				case "reopen session":
					a.closeSession()
				case "switch connection":
					a.disconnect()
					a.client = newSessionReadClient(client)
					a.connected.Set(true)
				}
				openSessionForReadTest(t, a, posts, reads, id)
				a.transcriptErr.Set("current notice")
				a.loadOlderTranscript()
				current := nextSessionRead(t, reads)
				replySessionRead(t, posts, old, status, remotewire.Transcript{
					Before: 1, Truncated: true, Messages: []remotewire.Message{{Turn: 1, Role: "user", Text: "stale"}},
				})
				messages := a.messages.GetUntracked()
				if !a.connected.GetUntracked() || a.active.GetUntracked() != id || !a.olderBusy.GetUntracked() ||
					len(messages) != 1 || messages[0].Text != "current" || a.messagesBefore.GetUntracked() != 4 ||
					a.transcriptTruncated.GetUntracked() || a.transcriptErr.GetUntracked() != "current notice" {
					t.Fatalf("stale history changed the current visit: connected=%v active=%q loading=%v messages=%+v before=%d truncated=%v error=%q",
						a.connected.GetUntracked(), a.active.GetUntracked(), a.olderBusy.GetUntracked(), messages,
						a.messagesBefore.GetUntracked(), a.transcriptTruncated.GetUntracked(), a.transcriptErr.GetUntracked())
				}
				replySessionRead(t, posts, current, http.StatusOK, remotewire.Transcript{
					Before: 2, Messages: []remotewire.Message{{Turn: 2, Role: "user", Text: "earlier"}},
				})
				messages = a.messages.GetUntracked()
				if a.olderBusy.GetUntracked() || a.messagesBefore.GetUntracked() != 2 || len(messages) != 2 || messages[0].Text != "earlier" {
					t.Fatalf("current history did not load: loading=%v before=%d messages=%+v", a.olderBusy.GetUntracked(), a.messagesBefore.GetUntracked(), messages)
				}
			})
		}
	}
}

func TestMobileOlderTranscriptSurvivesCurrentPoll(t *testing.T) {
	a, posts := newSessionReadTestApp(t)
	client, reads := newSessionReadServer(t)
	a.client = client
	openSessionForReadTest(t, a, posts, reads, "s1")
	a.loadOlderTranscript()
	older := nextSessionRead(t, reads)
	a.refreshTranscript()
	poll := nextSessionRead(t, reads)
	replySessionRead(t, posts, poll, http.StatusOK, remotewire.Transcript{
		Before: 4, Messages: []remotewire.Message{{Turn: 4, Role: "user", Text: "refreshed"}},
	})
	replySessionRead(t, posts, older, http.StatusOK, remotewire.Transcript{
		Before: 2, Messages: []remotewire.Message{{Turn: 2, Role: "user", Text: "earlier"}},
	})
	messages := a.messages.GetUntracked()
	if a.olderBusy.GetUntracked() || a.messagesBefore.GetUntracked() != 2 || len(messages) != 2 || messages[0].Text != "earlier" || messages[1].Text != "refreshed" {
		t.Fatalf("poll interfered with current history: loading=%v before=%d messages=%+v", a.olderBusy.GetUntracked(), a.messagesBefore.GetUntracked(), messages)
	}
}

func TestMobileOlderTranscriptReportsCurrentErrors(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			a, posts := newSessionReadTestApp(t)
			client, reads := newSessionReadServer(t)
			a.client = client
			a.connected.Set(true)
			openSessionForReadTest(t, a, posts, reads, "s1")
			a.loadOlderTranscript()
			read := nextSessionRead(t, reads)
			replySessionRead(t, posts, read, status, nil)
			if a.olderBusy.GetUntracked() {
				t.Fatal("failed history request left loading active")
			}
			if status == http.StatusUnauthorized {
				if a.connected.GetUntracked() || a.client != nil || a.err.GetUntracked() == "" {
					t.Fatal("current authentication failure did not disconnect with a reason")
				}
			} else if !a.connected.GetUntracked() || a.transcriptErr.GetUntracked() == "" || len(a.messages.GetUntracked()) != 1 {
				t.Fatal("current history failure did not preserve the transcript and report the error")
			}
		})
	}
}

func TestMobileLeavingSessionReleasesReads(t *testing.T) {
	for _, leave := range []string{"close", "disconnect"} {
		t.Run(leave, func(t *testing.T) {
			a, posts := newSessionReadTestApp(t)
			client, reads := newSessionReadServer(t)
			a.client = client
			a.connected.Set(true)
			a.active.Set("s1")
			a.messagesBefore.Set(4)
			a.refreshTranscript()
			a.loadOlderTranscript()
			first, second := nextSessionRead(t, reads), nextSessionRead(t, reads)
			wantClient, wantError := client, ""
			if leave == "close" {
				a.closeSession()
			} else {
				wantClient, wantError = nil, "left server"
				a.disconnectWith(wantError)
			}
			if a.transcriptBusy.GetUntracked() || a.olderBusy.GetUntracked() {
				t.Errorf("leaving session did not release reads: transcript=%v older=%v", a.transcriptBusy.GetUntracked(), a.olderBusy.GetUntracked())
			}
			replySessionRead(t, posts, first, http.StatusUnauthorized, nil)
			replySessionRead(t, posts, second, http.StatusUnauthorized, nil)
			if a.active.GetUntracked() != "" || a.client != wantClient || a.err.GetUntracked() != wantError ||
				a.transcriptBusy.GetUntracked() || a.olderBusy.GetUntracked() {
				t.Fatal("abandoned reads changed the current screen")
			}
		})
	}
}

func TestMobileTranscriptIgnoresPreviousConnection(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			a, posts := newSessionReadTestApp(t)
			client, reads := newSessionReadServer(t)
			a.client = client
			a.connected.Set(true)
			a.active.Set("s1")
			a.refreshTranscript()
			old := nextSessionRead(t, reads)
			a.disconnect()
			a.client = newSessionReadClient(client)
			a.connected.Set(true)
			a.active.Set("s1")
			a.activeTitle.Set("current")
			a.transcriptBusy.Set(true)
			a.transcriptErr.Set("current notice")
			replySessionRead(t, posts, old, status, remotewire.Transcript{ID: "s1", Title: "stale"})
			if a.client == client || a.client.base != client.base || !a.connected.GetUntracked() || a.activeTitle.GetUntracked() != "current" ||
				!a.transcriptBusy.GetUntracked() || a.transcriptErr.GetUntracked() != "current notice" {
				t.Fatalf("stale transcript changed current connection: connected=%v title=%q loading=%v error=%q",
					a.connected.GetUntracked(), a.activeTitle.GetUntracked(), a.transcriptBusy.GetUntracked(), a.transcriptErr.GetUntracked())
			}
		})
	}
}

func TestMobileSessionOptionsIgnorePreviousVisit(t *testing.T) {
	for _, navigation := range []string{"reopen session", "switch connection"} {
		t.Run(navigation, func(t *testing.T) {
			a, posts := newSessionReadTestApp(t)
			client, reads := newSessionReadServer(t)
			a.client = client
			a.active.Set("s1")
			a.loadOptions("s1")
			old := nextSessionRead(t, reads)
			if !strings.HasSuffix(old.path, "/options") {
				t.Fatalf("expected options request, got %s", old.path)
			}
			if navigation == "reopen session" {
				a.closeSession()
			} else {
				a.disconnect()
				a.client = newSessionReadClient(client)
			}
			openSessionForReadTest(t, a, posts, reads, "s1")
			replySessionRead(t, posts, old, http.StatusOK, remotewire.Options{Model: "stale-model", Mode: "plan"})
			if a.options.GetUntracked().Model != "current-model" || a.mode.GetUntracked() != "goal" {
				t.Fatalf("stale options changed the current visit: options=%+v mode=%q", a.options.GetUntracked(), a.mode.GetUntracked())
			}
		})
	}
}
