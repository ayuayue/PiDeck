//go:build !js && !android && !ios

package workbench

// Bundled extensions must never double-register tools: a copy pi already
// loads wins, and our own directory is upgraded in place.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestBundledExtensionInstallsWhenPiHasNone(t *testing.T) {
	t.Setenv("PIDECK_LITE_PI_CONFIG", t.TempDir())
	dir := t.TempDir()
	body := []byte("export default function () {}\n")

	path := installBundledExtension(dir, "test-extension.ts", body)
	if path == "" {
		t.Fatal("installBundledExtension returned no path with an empty pi config")
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read installed extension: %v", err)
	}
	if string(got) != string(body) {
		t.Fatalf("installed bytes = %q, want %q", got, body)
	}
}

func TestBundledExtensionSkipsWhatPiLoads(t *testing.T) {
	piDir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", piDir)
	piExtensions := filepath.Join(piDir, "extensions")
	if err := os.MkdirAll(piExtensions, 0o755); err != nil {
		t.Fatalf("make pi extensions dir: %v", err)
	}
	original := []byte("// the copy pi already loads\n")
	piFile := filepath.Join(piExtensions, "test-extension.ts")
	if err := os.WriteFile(piFile, original, 0o644); err != nil {
		t.Fatalf("write pi copy: %v", err)
	}

	dir := t.TempDir()
	path := installBundledExtension(dir, "test-extension.ts", []byte("// ours\n"))
	if path != "" {
		t.Fatalf("installBundledExtension path = %q, want empty when pi has the file", path)
	}
	if _, err := os.Stat(filepath.Join(dir, "extensions", "test-extension.ts")); !os.IsNotExist(err) {
		t.Fatalf("our copy exists after skip: %v", err)
	}
	got, err := os.ReadFile(piFile)
	if err != nil {
		t.Fatalf("read pi copy: %v", err)
	}
	if string(got) != string(original) {
		t.Fatalf("pi copy changed to %q, want %q", got, original)
	}
}

func TestBundledExtensionReusesMatchingCopy(t *testing.T) {
	t.Setenv("PIDECK_LITE_PI_CONFIG", t.TempDir())
	dir := t.TempDir()
	body := []byte("// same build\n")

	first := installBundledExtension(dir, "test-extension.ts", body)
	second := installBundledExtension(dir, "test-extension.ts", body)
	if first == "" || second != first {
		t.Fatalf("second install path = %q, want %q", second, first)
	}
}

func TestInstallBundledExtensionsWritesTodoAsOneGroup(t *testing.T) {
	t.Setenv("PIDECK_LITE_PI_CONFIG", t.TempDir())
	dir := t.TempDir()

	installBundledExtensions(dir)
	defer func() { bundledExtensionPaths = nil }()

	if len(bundledExtensionPaths) != len(bundledExtensions()) {
		t.Fatalf("installed %d extensions, want %d", len(bundledExtensionPaths), len(bundledExtensions()))
	}
	if _, err := os.Stat(filepath.Join(dir, "extensions", "pi-deck-todo-state.ts")); err != nil {
		t.Fatalf("todo module was not written: %v", err)
	}
	for _, path := range bundledExtensionPaths {
		if strings.HasSuffix(path, "pi-deck-todo-state.ts") {
			t.Fatalf("todo module must not be injected with -e: %s", path)
		}
	}
	args := bundledExtensionArgs()
	if len(args) != len(bundledExtensionPaths)*2 {
		t.Fatalf("args = %v, want two entries per extension", args)
	}
}

func TestInstallBundledExtensionsSkipsTodoAsOneGroup(t *testing.T) {
	piDir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", piDir)
	piExtensions := filepath.Join(piDir, "extensions")
	if err := os.MkdirAll(piExtensions, 0o755); err != nil {
		t.Fatalf("make pi extensions dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(piExtensions, "pi-deck-todo.ts"), []byte("// theirs\n"), 0o644); err != nil {
		t.Fatalf("write pi todo: %v", err)
	}

	dir := t.TempDir()
	installBundledExtensions(dir)
	defer func() { bundledExtensionPaths = nil }()

	if _, err := os.Stat(filepath.Join(dir, "extensions", "pi-deck-todo.ts")); !os.IsNotExist(err) {
		t.Fatalf("our todo exists after skip: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "extensions", "pi-deck-todo-state.ts")); !os.IsNotExist(err) {
		t.Fatalf("todo module exists without its todo: %v", err)
	}
	if len(bundledExtensionPaths) != len(bundledExtensions())-1 {
		t.Fatalf("installed %d extensions, want %d", len(bundledExtensionPaths), len(bundledExtensions())-1)
	}
}

func TestBundledExtensionArgsSkipCopyAddedAfterInstall(t *testing.T) {
	piDir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", piDir)
	dir := t.TempDir()
	installBundledExtensions(dir)
	defer func() { bundledExtensionPaths = nil }()

	shadowed := filepath.Base(bundledExtensionPaths[0])
	piExtensions := filepath.Join(piDir, "extensions")
	if err := os.MkdirAll(piExtensions, 0o755); err != nil {
		t.Fatalf("make pi extensions dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(piExtensions, shadowed), []byte("// added later\n"), 0o644); err != nil {
		t.Fatalf("write late pi copy: %v", err)
	}

	args := bundledExtensionArgs()
	for _, arg := range args {
		if filepath.Base(arg) == shadowed {
			t.Fatalf("args still inject %s after pi gained a copy: %v", shadowed, args)
		}
	}
	if len(args) != (len(bundledExtensionPaths)-1)*2 {
		t.Fatalf("args = %v, want %d entries", args, (len(bundledExtensionPaths)-1)*2)
	}
}
