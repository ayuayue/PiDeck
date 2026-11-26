package client

import (
	"net/http"
	"reflect"
	"testing"
	"time"

	"example.com/pideck-v2/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func newTokenRotationTestApp(t *testing.T) (*nsgotest.App, *mobileApp, *remoteClient) {
	t.Helper()
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	server := newTestHTTPServer(t, "first", remotewire.Snapshot{Host: "desk"}, remotewire.Transcript{})
	t.Cleanup(server.Close)
	var a *mobileApp
	app := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = newMobileApp(cx)
		return core.View{}
	}, nsgotest.ManualFrames())
	app.Post(func() {
		a.server.Set(server.URL)
		a.token.Set("first")
		a.connect()
	})
	app.WaitUntil(5*time.Second, func() bool { return a.connected.GetUntracked() })
	app.WaitUntil(5*time.Second, func() bool { return loadMobileSaved(a.cx).Token == "first" })
	t.Cleanup(func() {
		app.Post(a.disconnect)
		app.Settle()
	})
	return app, a, a.client
}

func TestMobileRotatedTokenIgnoresPreviousConnection(t *testing.T) {
	for _, scenario := range []string{"after disconnect", "after switch", "queued before switch"} {
		t.Run(scenario, func(t *testing.T) {
			app, a, old := newTokenRotationTestApp(t)
			server := newTestHTTPServer(t, "current", remotewire.Snapshot{Host: "current desk"}, remotewire.Transcript{})
			t.Cleanup(server.Close)
			current, _, err := newRemoteClient(server.URL, "current")
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(current.close)
			rotate := func() {
				header := make(http.Header)
				header.Set(remotewire.TokenHeader, "old-rotated")
				old.rotate(&http.Response{Header: header})
			}
			before := loadMobileSaved(a.cx)
			app.Post(func() {
				if scenario == "queued before switch" {
					rotate()
				}
				a.disconnect()
				if scenario != "after disconnect" {
					a.client = current
					a.connected.Set(true)
					a.server.Set(a.client.source)
					a.token.Set("current")
					a.serverName.Set("current desk")
					a.recent.Set([]mobileRecent{{Server: a.client.source, Token: "current", Name: "current desk"}})
				}
				if scenario != "queued before switch" {
					rotate()
				}
			})
			app.Settle()
			want := "first"
			if scenario != "after disconnect" {
				want = "current"
			}
			if a.token.GetUntracked() != want {
				t.Fatal("previous connection replaced the current token")
			}
			if !reflect.DeepEqual(loadMobileSaved(a.cx), before) {
				t.Fatal("previous connection rewrote the saved connection or recent list")
			}
		})
	}
}

func TestMobileRotatedTokenPersistsCurrentConnection(t *testing.T) {
	app, a, client := newTokenRotationTestApp(t)
	header := make(http.Header)
	header.Set(remotewire.TokenHeader, "rotated")
	client.rotate(&http.Response{Header: header})
	app.WaitUntil(5*time.Second, func() bool {
		return a.token.GetUntracked() == "rotated" && loadMobileSaved(a.cx).Token == "rotated"
	})
	saved := loadMobileSaved(a.cx)
	if saved.Server != client.source || len(saved.Recent) != 1 || saved.Recent[0].Server != client.source || saved.Recent[0].Token != "rotated" {
		t.Fatal("current rotation was not kept with its server in the recent list")
	}
}
