//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func marketLifecycleApp(cx *core.Scope, st *store) *app {
	return &app{cx: cx, lifetime: cx.Context(), st: st, cfg: st.config(),
		marketOpen: core.NewSignal(cx, false), marketURL: core.NewSignal(cx, ""),
		marketBusy: core.NewSignal(cx, false), marketErr: core.NewSignal(cx, ""),
		marketList: core.NewSignalFunc(cx, []marketEntry(nil), nil), pluginFileBusy: core.NewSignal(cx, false),
		chatWidthPctSig: core.NewSignal(cx, 80)}
}

func TestMarketCloseCancelsRequestAndReopenKeepsExamples(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	started, canceled, release := make(chan struct{}), make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
			close(canceled)
		case <-release:
			_, _ = w.Write([]byte(`{"plugins":[{"id":"old","name":"Old","url":"https://example.com/old.json"}]}`))
		}
	}))
	defer srv.Close()
	defer close(release)
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = marketLifecycleApp(cx, st)
		a.openPluginMarket()
		return a.pluginMarketDialog()
	}, nsgotest.Size(1000, 800))
	screen.Type("id:market-url", srv.URL)
	screen.Press("id:market-load")
	screen.WaitUntil(5*time.Second, func() bool { return channelClosed(started) })
	screen.Press("id:market-close")
	screen.WaitUntil(5*time.Second, func() bool { return channelClosed(canceled) })
	a.cx.Post(a.openPluginMarket)
	screen.WaitFor("id:market-examples", 5*time.Second)
	if a.marketBusy.GetUntracked() || a.marketErr.GetUntracked() != "" {
		t.Fatalf("closed request changed reopened state: busy=%v, err=%q", a.marketBusy.GetUntracked(), a.marketErr.GetUntracked())
	}
	if got := a.marketList.GetUntracked(); len(got) != 3 || !got[0].Builtin {
		t.Fatalf("closed request replaced builtin examples: %+v", got)
	}
	if got := st.config().PluginIndexURL; got != "" {
		t.Fatalf("closed request persisted URL=%q", got)
	}
}

func channelClosed(ch <-chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestMarketNewRequestCancelsPreviousAndKeepsLatestResult(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { waitPluginConfigWrites(t) })
	oldStarted, oldCanceled := make(chan struct{}), make(chan struct{})
	newStarted, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/old" {
			close(oldStarted)
			select {
			case <-r.Context().Done():
				close(oldCanceled)
			case <-release:
			}
			return
		}
		close(newStarted)
		select {
		case <-release:
			_, _ = w.Write([]byte(`{"plugins":[{"id":"latest","name":"Latest","url":"https://example.com/latest.json"}]}`))
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer func() {
		if !channelClosed(release) {
			close(release)
		}
	}()
	var a *app
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = marketLifecycleApp(cx, st)
		a.openPluginMarket()
		return a.pluginMarketDialog()
	}, nsgotest.Size(1000, 800))
	// Cancel before httptest.Close even when an assertion fails.
	ctx, cancel := context.WithCancel(a.lifetime)
	a.lifetime = ctx
	defer cancel()
	screen.Type("id:market-url", srv.URL+"/old")
	screen.Press("id:market-load")
	screen.WaitUntil(5*time.Second, func() bool { return channelClosed(oldStarted) })
	a.cx.Post(func() { a.marketURL.Set(srv.URL + "/new"); a.loadPluginIndex() })
	screen.WaitUntil(5*time.Second, func() bool { return channelClosed(newStarted) && channelClosed(oldCanceled) })
	if !a.marketBusy.GetUntracked() || a.marketErr.GetUntracked() != "" {
		t.Fatalf("previous completion cleared current state: busy=%v, err=%q", a.marketBusy.GetUntracked(), a.marketErr.GetUntracked())
	}
	close(release)
	screen.WaitUntil(5*time.Second, func() bool {
		list := a.marketList.GetUntracked()
		return !a.marketBusy.GetUntracked() && len(list) == 1 && list[0].ID == "latest"
	})
	if got := st.config().PluginIndexURL; got != srv.URL+"/new" {
		t.Fatalf("saved index=%q, want latest URL", got)
	}
	waitPluginConfigSaved(t, screen, st)
}

func TestMarketReopenPreservesInstallationGuard(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a := marketLifecycleApp(cx, st)
		a.pluginFileBusy.Set(true)
		a.openPluginMarket()
		if !a.pluginFileBusy.GetUntracked() {
			t.Fatal("reopen cleared active installation")
		}
		return nil
	})
}

func TestMarketStaleCompletionCannotOverwriteReopenedRequest(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a := marketLifecycleApp(cx, st)
		a.openPluginMarket()
		old, gen := a.startPluginMarketRequest()
		a.closePluginMarket()
		a.openPluginMarket()
		current, currentGen := a.startPluginMarketRequest()
		if old.Err() == nil {
			t.Fatal("closed request was not canceled")
		}
		for _, resultErr := range []error{nil, errors.New("obsolete failure")} {
			if a.finishPluginMarketRequest(gen, []marketEntry{{ID: "old"}}, resultErr) {
				t.Error("accepted an obsolete completion")
			}
			if current.Err() != nil || !a.marketBusy.GetUntracked() || a.marketErr.GetUntracked() != "" {
				t.Fatalf("obsolete completion changed current ownership: ctx=%v, busy=%v, err=%q", current.Err(), a.marketBusy.GetUntracked(), a.marketErr.GetUntracked())
			}
			list := a.marketList.GetUntracked()
			if len(list) != 3 || !list[0].Builtin {
				t.Fatalf("obsolete result replaced examples: %+v", list)
			}
		}
		if !a.finishPluginMarketRequest(currentGen, []marketEntry{{ID: "latest"}}, nil) || current.Err() == nil || a.marketBusy.GetUntracked() {
			t.Fatal("current completion did not release its request")
		}
		return nil
	})
}

func TestMarketInstallCanceledWithAppLifetimePreservesManifest(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := &app{st: st, cfg: st.config(), lifetime: ctx}
	if err := os.MkdirAll(a.pluginsDir(), 0o755); err != nil {
		t.Fatal(err)
	}
	previous := `{"id":"team","name":"Team","version":"1.0.0","contributes":{"agents":[{"id":"a","name":"A","prompt":"Hi"}]}}`
	path := filepath.Join(a.pluginsDir(), "team.json")
	if err := os.WriteFile(path, []byte(previous), 0o644); err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		select {
		case <-r.Context().Done():
		case <-release:
			_, _ = w.Write([]byte(`{"id":"team","name":"Team","version":"2.0.0"}`))
		}
	}))
	defer srv.Close()
	defer close(release)
	result := make(chan error, 1)
	go func() {
		_, err := a.installMarketPlugin(marketEntry{ID: "team", Name: "Team", Version: "2.0.0", URL: srv.URL})
		result <- err
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("install did not start its download")
	}
	cancel()
	select {
	case err := <-result:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("install error=%v, want context cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("install did not stop after app cancellation")
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != previous {
		t.Fatalf("canceled update changed previous manifest: %q, err=%v", got, err)
	}
}
