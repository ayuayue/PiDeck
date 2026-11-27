//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
)

func TestAuthKeyReplacesOAuthWithoutRetainingTokens(t *testing.T) {
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	body := `{"anthropic":{"type":"oauth","access":"old-access","refresh":"old-refresh","expires":123,"env":{"REGION":"test"},"custom":true},"other":{"type":"api_key","key":"untouched"}}`
	if err := os.WriteFile(authPath(), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := replaceAuthKey("anthropic", "new-key"); err != nil {
		t.Fatal(err)
	}
	var doc map[string]map[string]any
	raw, err := os.ReadFile(authPath())
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	got := doc["anthropic"]
	if got["type"] != "api_key" || got["key"] != "new-key" {
		t.Fatalf("key was not made active: %v", got["type"])
	}
	for _, field := range []string{"access", "refresh", "expires"} {
		if _, ok := got[field]; ok {
			t.Errorf("retained obsolete OAuth field %s", field)
		}
	}
	if got["custom"] != true || got["env"] == nil || doc["other"]["key"] != "untouched" {
		t.Fatal("unrelated credential fields changed")
	}
}

func TestAuthConcurrentKeySavesKeepEveryProvider(t *testing.T) {
	t.Setenv("PIDECK_V2_PI_CONFIG", t.TempDir())
	var wg sync.WaitGroup
	errs := make(chan error, 12)
	for i := range 12 {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- replaceAuthKey(string(rune('a'+i)), "test-key") }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	entries, err := readAuthEntries()
	if err != nil || len(entries) != 12 {
		t.Fatalf("saved %d providers, want 12: %v", len(entries), err)
	}
	if _, err := os.Stat(filepath.Join(piConfigDir(), "auth.json.lock")); !os.IsNotExist(err) {
		t.Fatalf("credential lock not released: %v", err)
	}
}
