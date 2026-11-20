//go:build windows

package workbench

// A .cmd pi shim has to reach cmd.exe with its quotes intact: passing a
// quoted line as one argument of /c makes Go escape the quotes, and cmd.exe
// answers `'"...\pi.cmd"' 不是内部或外部命令` for every probe and session.

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// writeShim writes a .cmd that echoes the arguments it was given. The name
// holds a space, so an unquoted path fails the same way a real one would.
func writeShim(t *testing.T, dir, body string) string {
	t.Helper()
	path := filepath.Join(dir, "pi shim.cmd")
	if err := os.WriteFile(path, []byte("@echo off\r\n"+body+"\r\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// TestBatchShimCommandLaunch checks a session's pi command runs a shim with
// its arguments intact.
func TestBatchShimCommandLaunch(t *testing.T) {
	dir := t.TempDir()
	shim := writeShim(t, dir, "echo %*")
	cmd, err := localTarget.command(shim, dir, dir, "abc", "", []string{"--mode", "rpc"})
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("running the shim: %v", err)
	}
	// The shim quotes each argument; what matters is that the line reached
	// it whole.
	got := strings.ReplaceAll(strings.TrimSpace(string(out)), `"`, "")
	for _, want := range []string{"--mode rpc", "--session-dir", "--session-id abc", filepath.Base(dir)} {
		if !strings.Contains(got, want) {
			t.Errorf("shim saw %q, want it to hold %q", got, want)
		}
	}
}

// TestBatchShimProbe checks the environment probe reads a shim's version.
func TestBatchShimProbe(t *testing.T) {
	dir := t.TempDir()
	shim := writeShim(t, dir, "echo 1.6.0")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := batchCommandContext(ctx, shim, []string{"--version"}).Output()
	if err != nil {
		t.Fatalf("running the shim: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "1.6.0" {
		t.Errorf("version = %q, want %q", got, "1.6.0")
	}
}
