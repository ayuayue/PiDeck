//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestWriteFileAtomicPreservesOtherTemporaryFiles(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprintf("existing_%t", existing), func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "settings.json")
			if existing {
				if err := os.WriteFile(path, []byte("original"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			other := path + ".pideck.tmp"
			if err := os.WriteFile(other, []byte("another writer's data"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := writeFileAtomic(path, []byte("complete replacement"), 0o600); err != nil {
				t.Fatal(err)
			}
			if got, err := os.ReadFile(path); err != nil || string(got) != "complete replacement" {
				t.Fatalf("saved data = %q, %v; want the complete replacement", got, err)
			}
			if got, err := os.ReadFile(other); err != nil || string(got) != "another writer's data" {
				t.Fatalf("another writer's temporary file = %q, %v; want its original contents", got, err)
			}
			entries, err := os.ReadDir(dir)
			if err != nil || len(entries) != 2 {
				t.Fatalf("directory entries = %v, %v; want the destination and the untouched temporary file", entries, err)
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
				t.Fatalf("private file permissions = %o, want 600", info.Mode().Perm())
			}
		})
	}
}

func TestWriteFileAtomicConcurrentWriters(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "shared.json")
	const writers = 24
	payloads := make([][]byte, writers)
	for i := range payloads {
		payloads[i] = []byte(strings.Repeat(fmt.Sprintf("writer-%02d\n", i), 4096))
	}
	start := make(chan struct{})
	results := make(chan error, writers)
	var wg sync.WaitGroup
	for _, payload := range payloads {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			results <- writeFileAtomic(path, payload, 0o600)
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Errorf("concurrent save failed: %v", err)
		}
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	complete := false
	for _, payload := range payloads {
		if bytes.Equal(got, payload) {
			complete = true
			break
		}
	}
	if !complete {
		t.Fatalf("final file contains mixed or incomplete data (%d bytes)", len(got))
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "shared.json" {
		t.Fatalf("directory entries = %v, %v; want only shared.json", entries, err)
	}
}

func TestWriteFileAtomicCleansUpAfterRenameFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "occupied")
	if err := os.Mkdir(path, 0o700); err != nil {
		t.Fatal(err)
	}
	original := filepath.Join(path, "keep.txt")
	if err := os.WriteFile(original, []byte("keep the original"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeFileAtomic(path, []byte("new private data"), 0o600); err == nil {
		t.Fatal("saving over a nonempty directory succeeded")
	}
	if got, err := os.ReadFile(original); err != nil || string(got) != "keep the original" {
		t.Fatalf("original = %q, %v; want unchanged contents", got, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "occupied" {
		t.Fatalf("failed save left temporary data: entries = %v, %v", entries, err)
	}
	if err := os.Remove(original); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() { result <- writeFileAtomic(path, []byte("retry succeeded"), 0o600) }()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("save after a failed rename: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("failed save blocked the next writer")
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != "retry succeeded" {
		t.Fatalf("retried save = %q, %v; want the complete replacement", got, err)
	}
}

func TestWriteFileAtomicCreationFailure(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "missing", "settings.json")
	if err := writeFileAtomic(path, []byte("private data"), 0o600); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("save without a parent = %v, want os.ErrNotExist", err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("failed creation changed the parent: entries = %v, %v", entries, err)
	}
}

func TestStoreSavePreservesOtherTemporaryFiles(t *testing.T) {
	dir := t.TempDir()
	s := &store{path: filepath.Join(dir, "config.json"), c: &config{Version: configVersion, Theme: "dark"}}
	other := s.path + ".tmp"
	if err := os.WriteFile(other, []byte("another writer's config"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.save(); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(s.path)
	if err != nil {
		t.Fatal(err)
	}
	var saved config
	if err := json.Unmarshal(raw, &saved); err != nil || saved.Version != configVersion || saved.Theme != "dark" {
		t.Fatalf("saved config = %+v, %v; want version %d and dark theme", saved, err, configVersion)
	}
	if got, err := os.ReadFile(other); err != nil || string(got) != "another writer's config" {
		t.Fatalf("another writer's config = %q, %v; want unchanged contents", got, err)
	}
}

func TestStoreSaveCleansUpAfterRenameFailure(t *testing.T) {
	dir := t.TempDir()
	s := &store{path: filepath.Join(dir, "config.json"), c: &config{Version: configVersion}}
	if err := os.Mkdir(s.path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.path, "keep.txt"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := s.save(); err == nil {
		t.Fatal("saving config over a nonempty directory succeeded")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 || entries[0].Name() != "config.json" {
		t.Fatalf("failed config save left temporary data: entries = %v, %v", entries, err)
	}
}
