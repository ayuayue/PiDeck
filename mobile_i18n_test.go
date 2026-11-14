package main

// Checks the phone follows its language setting.

import (
	"testing"
	"time"

	"github.com/oneo-me/nsgo/nsgotest"
)

func TestMobileLanguage(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	t.Cleanup(func() { setUILanguage(langZhCN) })
	t.Setenv("PIDECK_LITE_MOBILE", "1")
	t.Setenv("PIDECK_LITE_LANG", "en-US")
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	app := nsgotest.Start(t, Root, nsgotest.Size(420, 860))
	app.WaitFor("text:Connect", 5*time.Second)
	app.WaitFor("text:Desktop address", 5*time.Second)
	app.WaitFor("text:Scan to connect", 5*time.Second)
}

func TestSessionStatsLabel(t *testing.T) {
	if got := sessionStatsLabel(1234, 1234, 128000, 0.02); got != "1k / 128k · $0.02" {
		t.Fatalf("label = %q", got)
	}
	if got := sessionStatsLabel(900, 0, 0, 0); got != "900 tokens" {
		t.Fatalf("tokens only = %q", got)
	}
	if got := sessionStatsLabel(0, 0, 0, 0); got != "" {
		t.Fatalf("empty = %q", got)
	}
}
