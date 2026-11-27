package client

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
)

// Each test owns its graph and drains posted network results explicitly, so
// delayed replies can be tested without a clock race or a real polling loop.
func newConnectionTestApp(t *testing.T) (*mobileApp, <-chan func()) {
	t.Helper()
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	posts := make(chan func(), 16)
	cx := core.NewRoot(core.RootOptions{CheckCommits: true, Post: func(fn func()) { posts <- fn }})
	t.Cleanup(cx.Dispose)
	a := &mobileApp{
		cx:             cx,
		features:       newMobileSessionFeatures(cx),
		server:         core.NewSignal(cx, ""),
		token:          core.NewSignal(cx, "fixture"),
		recent:         core.NewSignalFunc(cx, []mobileRecent(nil), nil),
		busy:           core.NewSignal(cx, false),
		creating:       core.NewSignal(cx, false),
		err:            core.NewSignal(cx, ""),
		connected:      core.NewSignal(cx, false),
		serverName:     core.NewSignal(cx, ""),
		desktopVersion: core.NewSignal(cx, ""),
		state:          core.NewSignalFunc(cx, remotewire.Snapshot{}, nil),
		active:         core.NewSignal(cx, ""),
		messages:       core.NewSignalFunc(cx, []remotewire.Message(nil), nil),
		transcriptErr:  core.NewSignal(cx, ""),
		transcriptBusy: core.NewSignal(cx, false),
		olderBusy:      core.NewSignal(cx, false),
		ask:            core.NewSignalFunc(cx, (*remotewire.Ask)(nil), nil),
		filesOpen:      core.NewSignal(cx, false),
		filesProject:   core.NewSignal(cx, ""),
		filesName:      core.NewSignal(cx, ""),
		filesQuery:     core.NewSignal(cx, ""),
		filesList:      core.NewSignalFunc(cx, []remotewire.File(nil), nil),
		filesBusy:      core.NewSignal(cx, false),
		filesErr:       core.NewSignal(cx, ""),
		fileOpen:       core.NewSignal(cx, false),
		fileTitle:      core.NewSignal(cx, ""),
		fileText:       core.NewSignal(cx, ""),
		fileEdit:       newMobileFileEditor(cx),
		fileBusy:       core.NewSignal(cx, false),
		fileErr:        core.NewSignal(cx, ""),
		fileFind:       core.NewSignal(cx, ""),
		filesMention:   core.NewSignal(cx, false),
		refreshing:     core.NewSignal(cx, false),
		agents:         core.NewSignalFunc(cx, []remotewire.Agent(nil), nil),
		agentsBusy:     core.NewSignal(cx, false),
		agentsErr:      core.NewSignal(cx, ""),
		agentsOpen:     core.NewSignal(cx, false),
		tasks:          core.NewSignalFunc(cx, []remotewire.Task(nil), nil),
		tasksBusy:      core.NewSignal(cx, false),
		tasksErr:       core.NewSignal(cx, ""),
		tasksOpen:      core.NewSignal(cx, false),
		taskOpen:       core.NewSignal(cx, ""),
		taskBusy:       core.NewSignal(cx, ""),
		favorites:      core.NewSignalFunc(cx, []remotewire.Favorite(nil), nil),
		favoritesBusy:  core.NewSignal(cx, false),
		favoritesErr:   core.NewSignal(cx, ""),
		favoritesOpen:  core.NewSignal(cx, false),
		favOpen:        core.NewSignal(cx, ""),
		running:        core.NewSignal(cx, false),
		language:       core.NewSignal(cx, ""),
		appearance:     core.NewSignal(cx, ""),
		initProject:    core.NewSignal(cx, ""),
		soundOn:        core.NewSignal(cx, false),
		soundName:      core.NewSignal(cx, ""),
	}
	t.Cleanup(func() { a.client.close() })
	return a, posts
}

func runConnectionPost(t *testing.T, posts <-chan func()) {
	t.Helper()
	select {
	case fn := <-posts:
		fn()
	case <-time.After(5 * time.Second):
		t.Fatal("network result was not posted")
	}
}

// A blocked handler gives the test control over when the result is posted.
// Cleanup always releases it before closing the server, including on failure.
func delayedStateServer(t *testing.T, status int, host string) (*remoteClient, <-chan struct{}, func()) {
	t.Helper()
	started, release := make(chan struct{}, 1), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/ping" {
			_ = json.NewEncoder(w).Encode(remotePing{Host: host})
			return
		}
		select {
		case started <- struct{}{}:
		default:
		}
		select {
		case <-release:
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(remotewire.Snapshot{Host: host})
		case <-r.Context().Done():
		}
	}))
	finish := func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}
	t.Cleanup(srv.Close)
	t.Cleanup(finish)
	return &remoteClient{base: srv.URL, source: srv.URL, token: "fixture", http: srv.Client()}, started, finish
}

func waitConnectionRequest(t *testing.T, started <-chan struct{}) {
	t.Helper()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("state request did not reach the server")
	}
}

func TestMobileStatePollIgnoresPreviousConnection(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			a, posts := newConnectionTestApp(t)
			old, started, release := delayedStateServer(t, status, "old")
			a.client = old
			a.connected.Set(true)
			a.refreshState()
			waitConnectionRequest(t, started)
			a.disconnect()
			current, _, _ := delayedStateServer(t, http.StatusOK, "current")
			a.client = current
			a.connected.Set(true)
			a.state.Set(remotewire.Snapshot{Host: "current"})
			a.err.Set("current notice")
			release()
			runConnectionPost(t, posts)
			if a.client != current || !a.connected.GetUntracked() || a.state.GetUntracked().Host != "current" || a.err.GetUntracked() != "current notice" {
				t.Fatalf("old status %d changed current connection: connected=%v state=%+v error=%q", status, a.connected.GetUntracked(), a.state.GetUntracked(), a.err.GetUntracked())
			}
		})
	}
}

func TestMobileStatePollAfterDisconnectStaysDisconnected(t *testing.T) {
	a, posts := newConnectionTestApp(t)
	old, started, release := delayedStateServer(t, http.StatusOK, "old")
	a.client = old
	a.connected.Set(true)
	a.refreshState()
	waitConnectionRequest(t, started)
	a.disconnectWith("left server")
	release()
	runConnectionPost(t, posts)
	if a.client != nil || a.connected.GetUntracked() || a.state.GetUntracked().Host != "" || a.err.GetUntracked() != "left server" {
		t.Fatalf("late state changed disconnected screen: connected=%v state=%+v error=%q", a.connected.GetUntracked(), a.state.GetUntracked(), a.err.GetUntracked())
	}
}

func TestMobileDisconnectClearsPreviousConnectionNotice(t *testing.T) {
	a, _ := newConnectionTestApp(t)
	a.connected.Set(true)
	a.err.Set("previous connection failed")

	a.disconnect()

	if a.connected.GetUntracked() {
		t.Fatal("disconnect left the app connected")
	}
	if got := a.err.GetUntracked(); got != "" {
		t.Fatalf("disconnect left stale notice %q", got)
	}
}

func TestMobileStatePollCurrentConnection(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized, http.StatusForbidden} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			a, posts := newConnectionTestApp(t)
			current, started, release := delayedStateServer(t, status, "current")
			a.client = current
			a.connected.Set(true)
			a.state.Set(remotewire.Snapshot{Host: "before"})
			a.err.Set("previous error")
			a.refreshState()
			waitConnectionRequest(t, started)
			release()
			runConnectionPost(t, posts)
			if a.stateLoading || a.refreshing.GetUntracked() {
				t.Fatalf("current response left loading=%v refreshing=%v; want both false", a.stateLoading, a.refreshing.GetUntracked())
			}
			switch status {
			case http.StatusOK:
				if !a.connected.GetUntracked() || a.state.GetUntracked().Host != "current" || a.err.GetUntracked() != "" {
					t.Fatalf("current success: connected=%v host=%q error=%q; want true, current, empty", a.connected.GetUntracked(), a.state.GetUntracked().Host, a.err.GetUntracked())
				}
			case http.StatusUnauthorized:
				if a.connected.GetUntracked() || a.client != nil || a.err.GetUntracked() == "" {
					t.Fatalf("current auth failure: connected=%v clientPresent=%v error=%q; want disconnected with an error", a.connected.GetUntracked(), a.client != nil, a.err.GetUntracked())
				}
			default:
				if !a.connected.GetUntracked() || a.state.GetUntracked().Host != "before" || a.err.GetUntracked() == "" || a.err.GetUntracked() == "previous error" {
					t.Fatalf("current error: connected=%v host=%q error=%q; want true, before, a new error", a.connected.GetUntracked(), a.state.GetUntracked().Host, a.err.GetUntracked())
				}
			}
		})
	}
}

func TestMobileStatePollReleasesLoadingOnDisconnect(t *testing.T) {
	a, posts := newConnectionTestApp(t)
	old, oldStarted, releaseOld := delayedStateServer(t, http.StatusOK, "old")
	a.client = old
	a.connected.Set(true)
	a.refreshState()
	waitConnectionRequest(t, oldStarted)
	a.disconnect()
	if a.stateLoading || a.refreshing.GetUntracked() {
		t.Fatal("disconnected request still owns the loading state")
	}
	current, currentStarted, releaseCurrent := delayedStateServer(t, http.StatusOK, "current")
	a.client = current
	a.connected.Set(true)
	a.refreshState()
	waitConnectionRequest(t, currentStarted)
	releaseOld()
	runConnectionPost(t, posts)
	if !a.stateLoading || !a.refreshing.GetUntracked() {
		t.Fatal("old response cleared the current request's loading state")
	}
	releaseCurrent()
	runConnectionPost(t, posts)
	if a.stateLoading || a.refreshing.GetUntracked() || a.state.GetUntracked().Host != "current" {
		t.Fatalf("current refresh did not finish: loading=%v state=%+v", a.stateLoading, a.state.GetUntracked())
	}
}

func TestMobileConnectIgnoresCancelledAttempt(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusUnauthorized} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			a, posts := newConnectionTestApp(t)
			old, started, release := delayedStateServer(t, status, "old")
			a.server.Set(old.source)
			a.connect()
			waitConnectionRequest(t, started)
			a.disconnectWith("cancelled")
			release()
			runConnectionPost(t, posts)
			if a.client != nil || a.connected.GetUntracked() || a.busy.GetUntracked() || a.err.GetUntracked() != "cancelled" || len(a.recent.GetUntracked()) != 0 {
				t.Fatalf("cancelled connection was published: connected=%v busy=%v error=%q recent=%+v", a.connected.GetUntracked(), a.busy.GetUntracked(), a.err.GetUntracked(), a.recent.GetUntracked())
			}
		})
	}
}

func TestMobileScanWithoutTokenKeepsAddressAndClearsOldToken(t *testing.T) {
	a, _ := newConnectionTestApp(t)
	a.server.Set("http://old.example:8787")
	a.token.Set("old-token")

	a.connectScanned("http://new.example:8787")

	if got := a.server.GetUntracked(); got != "http://new.example:8787" {
		t.Fatalf("server = %q, want scanned address", got)
	}
	if got := a.token.GetUntracked(); got != "" {
		t.Fatalf("token = %q, want empty token for scanned address", got)
	}
	if got := a.err.GetUntracked(); got == "" {
		t.Fatal("missing token did not prompt the user")
	}
	if a.busy.GetUntracked() || a.connected.GetUntracked() {
		t.Fatal("scan without token started a connection")
	}
}

func TestMobileConnectCanRestartBeforeCancelledAttemptReturns(t *testing.T) {
	a, posts := newConnectionTestApp(t)
	old, started, releaseOld := delayedStateServer(t, http.StatusUnauthorized, "old")
	a.server.Set(old.source)
	a.connect()
	waitConnectionRequest(t, started)
	a.disconnect()
	if a.busy.GetUntracked() {
		t.Fatal("cancelled attempt still blocks a new connection")
	}
	current, currentStarted, releaseCurrent := delayedStateServer(t, http.StatusForbidden, "current")
	a.server.Set(current.source)
	a.connect()
	waitConnectionRequest(t, currentStarted)
	releaseOld()
	runConnectionPost(t, posts)
	if !a.busy.GetUntracked() || a.err.GetUntracked() != "" {
		t.Fatal("cancelled attempt changed the new connection's progress")
	}
	releaseCurrent()
	runConnectionPost(t, posts)
	if a.busy.GetUntracked() || a.connected.GetUntracked() || a.err.GetUntracked() == "" {
		t.Fatal("current connection failure was not reported")
	}
}
