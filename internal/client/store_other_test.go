//go:build !js

package client

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestMobileStoreWritesPrivateFile(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	path := filepath.Join(home, "remote.json")
	if err := os.WriteFile(path, []byte(`{"token":"old"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	want := `{"server":"http://desktop","token":"new"}`
	if err := writeMobileStore(nil, []byte(want)); err != nil {
		t.Fatal(err)
	}
	got, err := os.ReadFile(path)
	if err != nil || string(got) != want {
		t.Fatalf("saved store = %q, %v; want %q", got, err, want)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("saved store permissions = %o, want 600", info.Mode().Perm())
	}
	entries, err := os.ReadDir(home)
	if err != nil || len(entries) != 1 || entries[0].Name() != "remote.json" {
		t.Fatalf("store directory entries = %v, %v; want only remote.json", entries, err)
	}
}

func TestSaveMobileSavedPreservesDataOnReplaceFailure(t *testing.T) {
	home := t.TempDir()
	t.Setenv("PIDECK_V2_HOME", home)
	path := filepath.Join(home, "remote.json")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(path, "keep.json")
	if err := os.WriteFile(original, []byte(`{"token":"keep"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := saveMobileSaved(nil, mobileSaved{Token: "replacement"}); err == nil {
		t.Fatal("saving over a nonempty directory succeeded")
	}
	if got, err := os.ReadFile(original); err != nil || string(got) != `{"token":"keep"}` {
		t.Fatalf("existing data = %q, %v; want unchanged contents", got, err)
	}
	entries, err := os.ReadDir(home)
	if err != nil || len(entries) != 1 || entries[0].Name() != "remote.json" {
		t.Fatalf("failed save left temporary data: entries = %v, %v", entries, err)
	}
}
