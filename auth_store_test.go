package main

// Checks reading and writing pi's auth.json from the settings page.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/nsgotest"
)

func TestAuthEntries(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	path := filepath.Join(dir, "auth.json")
	body := `{
  "anthropic": {"type": "api_key", "key": "sk-abcdef1234"},
  "openai": {"type": "oauth", "access": "tok", "refresh": "ref"},
  "count": 3
}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := readAuthEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("entries = %+v", entries)
	}
	if entries[0].Provider != "anthropic" || entries[0].Hint != "…1234" || !entries[0].Editable {
		t.Fatalf("anthropic = %+v", entries[0])
	}
	if entries[1].Provider != "openai" || entries[1].Type != "oauth" || entries[1].Editable {
		t.Fatalf("openai = %+v", entries[1])
	}

	if err := replaceAuthKey("anthropic", "sk-new-9999"); err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	anthropic, _ := doc["anthropic"].(map[string]any)
	if anthropic["key"] != "sk-new-9999" || anthropic["type"] != "api_key" {
		t.Fatalf("anthropic after replace = %+v", doc["anthropic"])
	}
	openai, _ := doc["openai"].(map[string]any)
	if openai["refresh"] != "ref" {
		t.Fatalf("oauth entry lost: %+v", doc["openai"])
	}

	if err := replaceAuthKey("acme", "k-12345"); err != nil {
		t.Fatal(err)
	}
	if err := removeAuthEntry("openai"); err != nil {
		t.Fatal(err)
	}
	entries, err = readAuthEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[0].Provider != "acme" || entries[1].Provider != "anthropic" {
		t.Fatalf("entries after edits = %+v", entries)
	}
}

func TestAuthKeyDialog(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	path := filepath.Join(dir, "auth.json")
	body := `{"anthropic": {"type": "api_key", "key": "sk-old-1111"}, "openai": {"type": "oauth", "access": "tok"}}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	workspace := editorWorkspace(t)
	if err := os.WriteFile(filepath.Join(workspace, "note.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	app := startApp(t, workspace, 1280, 860)
	app.Press("label:设置")
	app.WaitFor("id:settings-tab-models", 5*time.Second)
	app.Press("id:settings-tab-models")
	for i := 0; i < 3; i++ {
		if len(app.Query("id:auth-replace-anthropic")) > 0 {
			break
		}
		app.Press("id:settings-tab-models")
		app.Settle()
		time.Sleep(100 * time.Millisecond)
	}
	app.WaitFor("id:auth-replace-anthropic", 20*time.Second)
	app.Press("id:auth-replace-anthropic")
	app.WaitFor("id:auth-key", 5*time.Second)
	typeAll(t, app, "id:auth-key-input", "sk-new-2222")
	app.Press("id:auth-key-save")

	deadline := time.Now().Add(10 * time.Second)
	for {
		raw, err := os.ReadFile(path)
		if err == nil && len(raw) > 0 {
			var doc map[string]map[string]any
			if json.Unmarshal(raw, &doc) == nil && doc["anthropic"]["key"] == "sk-new-2222" {
				if doc["openai"]["access"] != "tok" {
					t.Fatalf("oauth entry lost: %+v", doc["openai"])
				}
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("auth.json = %s", raw)
		}
		time.Sleep(50 * time.Millisecond)
	}
}
