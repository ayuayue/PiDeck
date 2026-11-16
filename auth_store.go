//go:build !js && !android && !ios

package main

// pi's own credentials file, as the settings page shows it: each provider,
// the kind of credential, and a masked hint. Only the api_key's key is
// written from the app; every other field is kept as it was.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// authEntry is one provider in pi's auth.json.
type authEntry struct {
	Provider string
	Type     string
	Hint     string // the key's last characters, masked
	Editable bool   // an api_key entry the app can rewrite
}

// authPath is pi's auth.json.
func authPath() string {
	dir := piConfigDir()
	if dir == "" {
		return ""
	}
	return filepath.Join(dir, "auth.json")
}

// maskKey renders a credential so it can be recognized but not read.
func maskKey(key string) string {
	key = strings.TrimSpace(key)
	if key == "" {
		return ""
	}
	if len(key) <= 4 {
		return "…"
	}
	return "…" + key[len(key)-4:]
}

// readAuthEntries lists the providers in auth.json, by name.
func readAuthEntries() ([]authEntry, error) {
	path := authPath()
	if path == "" {
		return nil, fmt.Errorf("找不到 pi 的配置目录")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("auth.json 不是有效的 JSON：%w", err)
	}
	names := make([]string, 0, len(doc))
	for name := range doc {
		names = append(names, name)
	}
	sort.Strings(names)
	var out []authEntry
	for _, name := range names {
		var fields map[string]any
		if json.Unmarshal(doc[name], &fields) != nil {
			continue
		}
		entry := authEntry{Provider: name}
		if s, ok := fields["type"].(string); ok {
			entry.Type = s
		}
		key, hasKey := fields["key"].(string)
		if hasKey {
			entry.Hint = maskKey(key)
			entry.Editable = entry.Type == "" || entry.Type == "api_key"
		}
		out = append(out, entry)
	}
	return out, nil
}

// writeAuthFile replaces auth.json's contents, keeping it private.
func writeAuthFile(doc map[string]json.RawMessage) error {
	path := authPath()
	if path == "" {
		return fmt.Errorf("找不到 pi 的配置目录")
	}
	raw, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, append(raw, '\n'), 0o600)
}

// replaceAuthKey sets one provider's api key, keeping every other field.
func replaceAuthKey(provider, key string) error {
	provider, key = strings.TrimSpace(provider), strings.TrimSpace(key)
	if provider == "" || key == "" {
		return fmt.Errorf("供应商和密钥都要填")
	}
	doc, err := readAuthDoc()
	if err != nil {
		return err
	}
	var fields map[string]any
	if raw, ok := doc[provider]; ok {
		if json.Unmarshal(raw, &fields) != nil {
			return fmt.Errorf("「%s」不是一个对象，先在原始 JSON 里改", provider)
		}
	} else {
		fields = map[string]any{"type": "api_key"}
	}
	fields["key"] = key
	if _, ok := fields["type"]; !ok {
		fields["type"] = "api_key"
	}
	raw, err := json.Marshal(fields)
	if err != nil {
		return err
	}
	doc[provider] = raw
	return writeAuthFile(doc)
}

// removeAuthEntry drops one provider from auth.json.
func removeAuthEntry(provider string) error {
	doc, err := readAuthDoc()
	if err != nil {
		return err
	}
	delete(doc, provider)
	return writeAuthFile(doc)
}

// readAuthDoc reads auth.json as raw per-provider JSON.
func readAuthDoc() (map[string]json.RawMessage, error) {
	path := authPath()
	if path == "" {
		return nil, fmt.Errorf("找不到 pi 的配置目录")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]json.RawMessage{}, nil
		}
		return nil, err
	}
	doc := map[string]json.RawMessage{}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return doc, nil
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, fmt.Errorf("auth.json 不是有效的 JSON：%w", err)
	}
	return doc, nil
}
