//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAuthRejectsNonObjectDocuments(t *testing.T) {
	for _, body := range []string{"null", "[]", "42", `"text"`, "true", "{"} {
		t.Run(body, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
			path := filepath.Join(dir, "auth.json")
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			operations := []struct {
				name string
				run  func() error
			}{
				{"read document", func() error { _, err := readAuthDoc(); return err }},
				{"list entries", func() error { _, err := readAuthEntries(); return err }},
				{"replace key", func() error { return replaceAuthKey("acme", "new-api-key") }},
				{"remove entry", func() error { return removeAuthEntry("acme") }},
			}
			for _, op := range operations {
				t.Run(op.name, func(t *testing.T) {
					if err := op.run(); err == nil {
						t.Errorf("%s accepted a non-object auth.json: %s", op.name, body)
					}
					raw, err := os.ReadFile(path)
					if err != nil {
						t.Fatal(err)
					}
					if string(raw) != body {
						t.Errorf("%s changed invalid auth.json: got %q, want %q", op.name, raw, body)
					}
				})
			}
		})
	}
}

func TestAuthEntriesIgnoreNonObjectProviders(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
	body := `{
		"acme": {"type":"api_key", "key":"existing-api-key"},
		"null": null, "array": [], "number": 42, "string": "text", "boolean": true
	}`
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	entries, err := readAuthEntries()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Provider != "acme" || !entries[0].Editable {
		t.Fatalf("entries = %+v, want only the valid acme entry", entries)
	}
}

func TestReplaceAuthKeyRejectsNonObjectProviders(t *testing.T) {
	for _, value := range []string{"null", "[]", "42", `"text"`, "true"} {
		t.Run(value, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
			path := filepath.Join(dir, "auth.json")
			body := `{"acme": ` + value + `, "other":{"type":"oauth","refresh":"retained-token"}}`
			if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := replaceAuthKey("acme", "new-api-key"); err == nil {
				t.Error("replacing a non-object provider should fail")
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if string(raw) != body {
				t.Fatalf("rejected key replacement changed auth.json: got %q, want %q", raw, body)
			}
		})
	}
}

func TestAuthEmptyDocumentsAcceptKey(t *testing.T) {
	for _, body := range []string{"missing", "", " \n\t", "{}"} {
		t.Run(body, func(t *testing.T) {
			dir := t.TempDir()
			t.Setenv("PIDECK_LITE_PI_CONFIG", dir)
			if body != "missing" {
				if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(body), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if err := replaceAuthKey("acme", "new-api-key"); err != nil {
				t.Fatal(err)
			}
			entries, err := readAuthEntries()
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 1 || entries[0].Provider != "acme" || entries[0].Type != "api_key" || !entries[0].Editable {
				t.Fatalf("entries after adding key = %+v, want one editable acme api_key", entries)
			}
		})
	}
}
