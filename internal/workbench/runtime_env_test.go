//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func runtimePiFixture(t *testing.T, version string, fail bool) string {
	t.Helper()
	dir := t.TempDir()
	name, body := "pi", "#!/bin/sh\necho "+version+"\n"
	if fail {
		body = "#!/bin/sh\necho broken-runtime >&2\nexit 1\n"
	}
	searchPath := dir
	if runtime.GOOS == "windows" {
		name, body = "pi.cmd", "@echo off\r\necho "+version+"\r\n"
		if fail {
			body = "@echo off\r\necho broken-runtime 1>&2\r\nexit /b 1\r\n"
		}
		if shell, err := exec.LookPath("cmd.exe"); err == nil {
			searchPath += string(os.PathListSeparator) + filepath.Dir(shell)
		}
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", searchPath)
	return path
}

func TestProbePiKeepsResolvedPathOnFailure(t *testing.T) {
	want := runtimePiFixture(t, "", true)
	path, version, err := probePi("", "")
	if path != want || version != "" || err == nil || !strings.Contains(err.Error(), "broken-runtime") {
		t.Fatalf("probePi() = %q, %q, %v; want resolved path %q and the launch error", path, version, err, want)
	}
}

func TestRuntimeCustomPiAndInvalidOverride(t *testing.T) {
	path := runtimePiFixture(t, "fixture-1.2.3", false)
	custom := filepath.Join(t.TempDir(), "custom runtime"+filepath.Ext(path))
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(custom, raw, 0o755); err != nil {
		t.Fatal(err)
	}
	got, version, err := probePiWithExecutable("", "", custom)
	if err != nil || got != custom || version != "fixture-1.2.3" {
		t.Fatalf("custom pi = %q, %q, %v", got, version, err)
	}
	missing := filepath.Join(t.TempDir(), "missing-pi")
	if _, err := resolvePiExecutable(missing); err == nil {
		t.Fatal("invalid explicit path fell back to the available PATH executable")
	}
	// An explicit installation must reach the actual session launcher too,
	// even when automatic detection can no longer find an executable.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	client, err := startPi(target{}, custom, t.TempDir(), t.TempDir(), "runtime-fixture", "", nil, nil, func(error) { close(done) })
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.stop)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("fixture pi did not exit")
	}
}

func TestRuntimePreferencesMigrationAndEmptyEditors(t *testing.T) {
	raw := []byte(`{"version":6,"editorCommand":"code"}`)
	var c config
	if err := json.Unmarshal(raw, &c); err != nil {
		t.Fatal(err)
	}
	if !migrateConfig(&c, raw) || c.Version != configVersion || c.EditorCommand != "code" || c.ExternalEditors != nil {
		t.Fatalf("legacy editor preference was not retained: %+v", c)
	}
	c.EditorCommand, c.ExternalEditors = "", []extEditor{}
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	var loaded config
	if err := json.Unmarshal(data, &loaded); err != nil {
		t.Fatal(err)
	}
	migrateConfig(&loaded, data)
	if loaded.ExternalEditors == nil {
		t.Fatal("explicit empty list reverted to automatic discovery")
	}
	st := &store{c: &config{ExternalEditors: []extEditor{{"Custom", "/editor"}}}}
	copy := st.config()
	copy.ExternalEditors[0].Name = "Changed"
	if st.config().ExternalEditors[0].Name != "Custom" {
		t.Fatal("config snapshot shares editor storage")
	}
}

func TestRuntimeEditorNormalizationAndDiscovery(t *testing.T) {
	program := runtimePiFixture(t, "fixture", false)
	command := "code" + filepath.Ext(program)
	path := filepath.Join(filepath.Dir(program), command)
	raw, err := os.ReadFile(program)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o755); err != nil {
		t.Fatal(err)
	}
	found := scanExternalEditors()
	if len(found) == 0 || found[0].Name != "VS Code" || found[0].Command != path {
		t.Fatalf("scanner did not retain the resolved executable: %+v", found)
	}
	c := config{ExternalEditors: []extEditor{{" ", " code "}, {"Duplicate", path}, {"Empty", " "}}}
	if !normalizeExternalEditors(&c) || len(c.ExternalEditors) != 1 || c.ExternalEditors[0].Name != "VS Code" {
		t.Fatalf("editor list was not normalized: %+v", c.ExternalEditors)
	}
	other := filepath.Join(t.TempDir(), command)
	if sameEditorCommand(path, other) {
		t.Fatal("different installations were merged")
	}
}
