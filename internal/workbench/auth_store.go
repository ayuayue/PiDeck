//go:build !js && !android && !ios

package workbench

// pi's own credentials file, as the settings page shows it: each provider,
// the kind of credential, where its value comes from, and how long an
// OAuth token still lasts. Only an api_key's key is written from the app;
// every other field is kept as it was.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"example.com/pideck-lite/internal/apptext"
)

// Where an api_key entry's value comes from.
const (
	keyLiteral = "literal" // the key itself, written into auth.json
	keyEnv     = "env"     // $NAME, read from the environment
	keyCommand = "command" // !command, run when the key is first needed
)

// authEntry is one provider in pi's auth.json.
type authEntry struct {
	Provider string
	// Type is pi's credential kind: "api_key", "oauth", or "" when the
	// file does not name one.
	Type string
	// Hint is the key or access token, masked to its last characters.
	Hint string
	// Source is keyLiteral, keyEnv, or keyCommand, with Name telling the
	// variable or the command.
	Source string
	Name   string
	// Env lists the extra variables the entry sets for its provider.
	Env []string
	// Expires is when an OAuth access token ends, in milliseconds since
	// the epoch; 0 when the entry does not say.
	Expires int64
	// Refreshable says the entry holds a refresh token.
	Refreshable bool
	// Editable says the app can rewrite this entry's key.
	Editable bool
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

// envRef reads a "$NAME" or "${NAME}" value reference, the way pi does.
func envRef(value string) (string, bool) {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "${") && strings.HasSuffix(value, "}") {
		name := strings.TrimSpace(value[2 : len(value)-1])
		return name, name != ""
	}
	if strings.HasPrefix(value, "$") && len(value) > 1 {
		name := strings.TrimSpace(value[1:])
		return name, name != ""
	}
	return "", false
}

// keyOrigin says where an apiKey value comes from: its literal text, an
// environment variable, or a command whose output pi caches.
func keyOrigin(value string) (source, name string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ""
	}
	if strings.HasPrefix(value, "!") {
		return keyCommand, strings.TrimSpace(value[1:])
	}
	if ref, ok := envRef(value); ok {
		return keyEnv, ref
	}
	return keyLiteral, ""
}

// envSet reports whether a variable has a non-empty value.
func envSet(name string) bool {
	return strings.TrimSpace(os.Getenv(name)) != ""
}

// compactAge is a short span, as a list writes it.
func compactAge(d time.Duration) string {
	switch {
	case d < time.Minute:
		return "<1m"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	case d < 30*24*time.Hour:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
	return fmt.Sprintf("%dmo", int(d.Hours()/24/30))
}

// authLifetime says how long an OAuth token has left, in words.
func authLifetime(expires int64, now time.Time) string {
	if expires <= 0 {
		return ""
	}
	left := time.UnixMilli(expires).Sub(now)
	if left <= 0 {
		return apptext.T("已过期 %s", compactAge(-left))
	}
	return apptext.T("剩余 %s", compactAge(left))
}

// readAuthEntries lists the providers in auth.json, by name.
func readAuthEntries() ([]authEntry, error) {
	doc, err := readAuthDoc()
	if err != nil {
		return nil, err
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
		entry.Type, _ = fields["type"].(string)
		switch entry.Type {
		case "oauth":
			entry.Hint = maskKey(strField(fields["access"]))
			entry.Refreshable = strings.TrimSpace(strField(fields["refresh"])) != ""
			entry.Expires = int64(numberField(fields["expires"]))
		default:
			key := strField(fields["key"])
			entry.Source, entry.Name = keyOrigin(key)
			// A literal key is worth a hint; a variable or a command is
			// already named by its source.
			if entry.Source == keyLiteral {
				entry.Hint = maskKey(key)
			}
			entry.Editable = entry.Type == "" || entry.Type == "api_key"
		}
		if overrides, ok := fields["env"].(map[string]any); ok {
			for key := range overrides {
				entry.Env = append(entry.Env, key)
			}
			sort.Strings(entry.Env)
		}
		out = append(out, entry)
	}
	return out, nil
}

// numberField reads a JSON number, however it was decoded.
func numberField(v any) float64 {
	f, _ := floatField(v)
	return f
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
	return writeFileAtomic(path, append(raw, '\n'), 0o600)
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
