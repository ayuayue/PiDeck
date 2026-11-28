//go:build !js && !android && !ios

package workbench

import (
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"example.com/pideck/internal/apptext"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestPiReleaseNewer(t *testing.T) {
	for _, tt := range []struct {
		installed, latest string
		want              bool
	}{
		{"1.6.1", "1.7.0", true},
		{"1.9.9", "1.10.0", true},
		{"1.7.0", "1.7.0", false},
		{"2.0.0", "1.7.0", false},
		{"1.7.0-rc.2", "1.7.0", true},
		{"1.7.0-rc.2", "1.7.0-rc.10", true},
		{"1.7.0", "1.7.0-rc.2", false},
		{"v1.7.0+local", "1.7.0", false},
		{"unknown", "1.7.0", false},
		{"1.6.1", "invalid", false},
	} {
		t.Run(tt.installed+"/"+tt.latest, func(t *testing.T) {
			if got := piReleaseNewer(tt.installed, tt.latest); got != tt.want {
				t.Fatalf("piReleaseNewer(%q, %q) = %v, want %v", tt.installed, tt.latest, got, tt.want)
			}
		})
	}
	state := piUpdateState{Path: "custom-pi", Installed: "1.6.1", Latest: "1.7.0"}
	if !state.available(envInfo{PiPath: "custom-pi", PiVersion: "1.6.1"}) {
		t.Fatal("selected runtime lost its update")
	}
	for _, info := range []envInfo{{PiPath: "another-pi", PiVersion: "1.6.1"}, {PiPath: "custom-pi", PiVersion: "1.8.0"}} {
		if state.available(info) {
			t.Fatalf("a stale query offered an update for %+v", info)
		}
	}
}

func piSelfUpdateFixture(t *testing.T) string {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "custom runtime with spaces")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	name := "pi"
	body := `#!/bin/sh
root=$(dirname "$0")
if [ "$1" = --version ]; then
  cat "$root/version.txt"
  exit 0
fi
[ "$*" = 'update --self --no-approve' ] || exit 9
printf '%s\n' "$*" > "$root/args.txt"
if [ -f "$root/fail.txt" ]; then
  echo 'Installing pi...'
  echo 'native module is locked' >&2
  exit 7
fi
printf '1.7.0\n' > "$root/version.txt"
`
	if runtime.GOOS == "windows" {
		name = "pi.cmd"
		body = "@echo off\r\n" +
			"if \"%~1\"==\"--version\" (\r\n type \"%~dp0version.txt\"\r\n exit /b 0\r\n)\r\n" +
			"if not \"%~1\"==\"update\" exit /b 9\r\nif not \"%~2\"==\"--self\" exit /b 9\r\nif not \"%~3\"==\"--no-approve\" exit /b 9\r\nif not \"%~4\"==\"\" exit /b 9\r\n" +
			"echo %~1 %~2 %~3>\"%~dp0args.txt\"\r\n" +
			"if exist \"%~dp0fail.txt\" (\r\n echo Installing pi...\r\n echo native module is locked 1>&2\r\n exit /b 7\r\n)\r\n" +
			"echo 1.7.0>\"%~dp0version.txt\"\r\nexit /b 0\r\n"
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "version.txt"), []byte("1.6.1\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

type piUpdateTestTransport struct{ unavailable *atomic.Bool }

func (tr piUpdateTestTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	status := http.StatusOK
	if tr.unavailable.Load() {
		status = http.StatusServiceUnavailable
	}
	return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"version":"1.7.0"}`)), Request: req}, nil
}

func TestSettingsRuntimePiUpdate(t *testing.T) {
	program := piSelfUpdateFixture(t)
	var unavailable atomic.Bool
	unavailable.Store(true)
	previous := appHTTPClient
	appHTTPClient = &http.Client{Transport: piUpdateTestTransport{&unavailable}}
	t.Cleanup(func() { appHTTPClient = previous })
	screen, built := settingsEnvironmentFixture(t, false, apptext.LangZhCN)
	screen.Post(func() {
		built.cfg.PiExecutable = program
		info := built.env.GetUntracked()
		info.PiPath, info.PiVersion = program, "1.6.1"
		built.env.Set(info)
	})
	screen.WaitFor("text:pi 1.6.1", 5*time.Second)
	screen.Press("id:pi-version-check")
	screen.WaitFor("text:npm HTTP 503", 5*time.Second)
	if len(screen.Query("id:pi-version-update")) != 0 {
		t.Fatal("failed query exposed an update action")
	}
	unavailable.Store(false)
	screen.Press("id:pi-version-check")
	screen.WaitFor("id:pi-version-update", 5*time.Second)
	screen.WaitFor("text:"+apptext.T("已安装 %s，npm 最新版 %s。", "1.6.1", "1.7.0"), 5*time.Second)
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-runtime-pi-update-available")
	}
	failPath := filepath.Join(filepath.Dir(program), "fail.txt")
	if err := os.WriteFile(failPath, []byte("fail"), 0o600); err != nil {
		t.Fatal(err)
	}
	screen.Press("id:pi-version-update")
	screen.WaitFor("text:native module is locked", 5*time.Second)
	failure := screen.Find("id:pi-update-error").Text
	if !strings.Contains(failure, "Installing pi...") || !strings.Contains(failure, "native module is locked") {
		t.Fatalf("update hid the original error output: %q", failure)
	}
	if built.env.GetUntracked().PiVersion != "1.6.1" {
		t.Fatal("failed update changed the installed version")
	}
	if err := os.Remove(failPath); err != nil {
		t.Fatal(err)
	}
	screen.Press("id:pi-version-update")
	screen.WaitFor("text:pi 1.7.0", 5*time.Second)
	screen.WaitUntil(5*time.Second, func() bool { return !built.piUpdate.GetUntracked().busy() })
	if len(screen.Query("id:pi-version-update")) != 0 || len(screen.Query("id:pi-update-error")) != 0 {
		t.Fatal("successful update kept its action or error")
	}
	if got := built.env.GetUntracked().PiPath; got != program || built.cfg.PiExecutable != program {
		t.Fatalf("updated a different runtime: path=%q configured=%q", got, built.cfg.PiExecutable)
	}
	args, err := os.ReadFile(filepath.Join(filepath.Dir(program), "args.txt"))
	if err != nil || strings.TrimSpace(string(args)) != "update --self --no-approve" {
		t.Fatalf("self-update command = %q, %v", args, err)
	}
	if nsgotest.Target() != "" {
		screen.Screenshot("settings-runtime-pi-update-complete")
	}
}

func TestPiSelfUpdateCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := runPiSelfUpdate(ctx, piSelfUpdateFixture(t)); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled update returned %v", err)
	}
}
