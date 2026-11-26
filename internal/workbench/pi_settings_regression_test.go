//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestPiSettingsKeepsRuntimeDefaults(t *testing.T) {
	for _, body := range []string{"", `{}`, `{"retry":{"maxRetries":7},"compaction":{"reserveTokens":4096}}`} {
		t.Run(body, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PIDECK_V2_PI_CONFIG", dir)
			if body != "" {
				if err := os.WriteFile(filepath.Join(dir, "settings.json"), []byte(body), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			s, err := readPiSettings()
			if err != nil || !s.RetryEnabled || !s.CompactionEnabled {
				t.Fatalf("missing switches must follow pi's enabled defaults: %+v, %v", s, err)
			}
		})
	}
}

func TestPiSettingsSavesOnlyEditedFields(t *testing.T) {
	for _, body := range []string{
		`{}`,
		`{"retry":{"provider":{"maxRetries":2}},"compaction":{"reserveTokens":0},"unknown":{"keep":true}}`,
		`{"retry":{"enabled":false,"maxRetries":0},"compaction":{"enabled":false},"defaultThinkingLevel":"high"}`,
	} {
		t.Run(body, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PIDECK_V2_PI_CONFIG", dir)
			path := filepath.Join(dir, "settings.json")
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			s, err := readPiSettings()
			if err != nil {
				t.Fatal(err)
			}
			before := s
			s.QuietStartup = true
			if err := savePiSettings(before, s); err != nil {
				t.Fatal(err)
			}
			var want map[string]any
			if err := json.Unmarshal([]byte(body), &want); err != nil {
				t.Fatal(err)
			}
			want["quietStartup"] = true
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var got map[string]any
			if err := json.Unmarshal(raw, &got); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("editing quiet startup changed unrelated settings:\ngot  %s\nwant %v", raw, want)
			}
		})
	}
}

func TestPiSettingsPreservesLaterFileEdits(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_V2_PI_CONFIG", dir)
	path := filepath.Join(dir, "settings.json")
	if err := os.WriteFile(path, []byte(`{"retry":{"maxRetries":7}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	before, err := readPiSettings()
	if err != nil {
		t.Fatal(err)
	}
	later := []byte(`{"retry":{"enabled":false,"maxRetries":9},"custom":"keep"}`)
	if err := os.WriteFile(path, later, 0o600); err != nil {
		t.Fatal(err)
	}
	s := before
	s.QuietStartup = true
	if err := savePiSettings(before, s); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"quietStartup": true, "retry": map[string]any{"enabled": false, "maxRetries": float64(9)}, "custom": "keep"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("saving an unrelated switch replaced a later file edit: %s", raw)
	}
}
