//go:build !js && !android && !ios

package workbench

import (
	"errors"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func pluginFileActionApp(cx *core.Scope, st *store) *app {
	return &app{cx: cx, st: st, cfg: st.config(),
		pluginFileBusy: core.NewSignal(cx, false),
		plugins:        core.NewSignalFunc(cx, []plugin(nil), nil),
		themes:         core.NewSignalFunc(cx, []themeSpec(nil), nil),
		pluginArchive:  core.NewSignalFunc(cx, pluginArchiveSnapshot{}, nil),
		theme:          core.NewSignal(cx, "system"), boundKeys: map[string]bool{}}
}

func TestPluginFileChangePublishesInventoryBeforeAcceptingNextChange(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	started, release, rejected := make(chan struct{}), make(chan struct{}), make(chan struct{})
	defer func() {
		if !channelClosed(release) {
			close(release)
		}
	}()
	var a *app
	var completed, published, remainedBusy bool
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = pluginFileActionApp(cx, st)
		a.changePluginFiles(func() error {
			close(started)
			<-release
			_, err := a.createPlugin("my-tools", "Tools", "")
			return err
		}, func(err error) {
			if err != nil {
				t.Errorf("plugin change: %v", err)
			}
			published = a.installedPlugin("my-tools") != nil
			remainedBusy = a.pluginFileBusy.GetUntracked()
			completed = true
		})
		return nil
	})
	screen.WaitUntil(5*time.Second, func() bool { return channelClosed(started) })
	a.cx.Post(func() {
		a.changePluginFiles(func() error { close(rejected); return nil }, func(error) {})
		// An unrelated refresh must not release a file operation still in flight.
		a.reloadAddons()
	})
	screen.Settle()
	if !a.pluginFileBusy.GetUntracked() {
		t.Fatal("reload released an ongoing file operation")
	}
	close(release)
	screen.WaitUntil(5*time.Second, func() bool { return completed })
	if channelClosed(rejected) || !published || remainedBusy {
		t.Fatalf("completion: concurrent write=%v, inventory published=%v, busy=%v", channelClosed(rejected), published, remainedBusy)
	}
}

func TestPluginFileChangeFailureReleasesGuardAndAllowsRetry(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	failure := errors.New("write refused")
	var a *app
	var result error
	var completed bool
	screen := nsgotest.Start(t, func(cx *core.Scope) core.Node {
		a = pluginFileActionApp(cx, st)
		a.changePluginFiles(func() error { return failure }, func(err error) { result, completed = err, true })
		return nil
	})
	screen.WaitUntil(5*time.Second, func() bool { return completed })
	if !errors.Is(result, failure) || a.pluginFileBusy.GetUntracked() {
		t.Fatalf("failed change: err=%v, busy=%v", result, a.pluginFileBusy.GetUntracked())
	}
	completed = false
	a.cx.Post(func() {
		a.changePluginFiles(func() error {
			_, err := a.createPlugin("my-tools", "Tools", "")
			return err
		}, func(err error) { result, completed = err, true })
	})
	screen.WaitUntil(5*time.Second, func() bool { return completed })
	if result != nil || a.installedPlugin("my-tools") == nil || a.pluginFileBusy.GetUntracked() {
		t.Fatalf("retry: err=%v, plugins=%+v, busy=%v", result, a.plugins.GetUntracked(), a.pluginFileBusy.GetUntracked())
	}
}
