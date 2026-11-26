//go:build !js && !android && !ios

package workbench

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type diagFilter struct {
	Category string
	Level    string
	Text     string
	Since    time.Time
	Until    time.Time
}

type diagResult struct {
	Events  []diagEvent
	Total   int
	Ignored int
}

func (f diagFilter) matches(ev diagEvent) bool {
	if f.Category != "" && ev.Category != f.Category || f.Level != "" && ev.Level != f.Level {
		return false
	}
	if !f.Since.IsZero() && ev.Time.Before(f.Since) || !f.Until.IsZero() && ev.Time.After(f.Until) {
		return false
	}
	text := ev.Text + " " + ev.Session + " " + ev.Category + " " + ev.Level + " " + ev.Time.Format(time.RFC3339)
	return strings.Contains(strings.ToLower(text), strings.ToLower(strings.TrimSpace(f.Text)))
}

func encodeDiagEvent(ev diagEvent) ([]byte, error) {
	ev.Version = 1
	ev.Text = redactDiagText(ev.Text)
	data, err := json.Marshal(ev)
	return append(data, '\n'), err
}

func decodeDiagEvent(line string) (diagEvent, bool) {
	var ev diagEvent
	if strings.HasPrefix(line, "{") {
		if json.Unmarshal([]byte(line), &ev) != nil || ev.Version != 1 || ev.Time.IsZero() {
			return ev, false
		}
	} else {
		// Compatibility is read-only: the previous text format had no
		// category or ID. Its original files are never migrated on startup.
		stamp, rest, ok := strings.Cut(line, " [")
		if !ok {
			return ev, false
		}
		level, text, ok := strings.Cut(rest, "] ")
		at, err := time.Parse(time.RFC3339, stamp)
		if !ok || err != nil {
			return ev, false
		}
		ev = diagEvent{Version: 1, ID: "legacy-" + diagSessionKey(line), Time: at, Level: level, Text: text, Category: diagCategory(text)}
	}
	if ev.Category == "" {
		ev.Category = "app"
	}
	switch ev.Level {
	case "info", "warn", "error", "exception":
	default:
		return ev, false
	}
	ev.Text = redactDiagText(ev.Text)
	return ev, true
}

// Categories for existing free-form callers are inferred at the adapter.
// New operational records pass their category explicitly through logEvent.
func diagCategory(text string) string {
	switch {
	case strings.Contains(text, "ACP"):
		return "acp"
	case strings.Contains(strings.ToLower(text), "git"):
		return "git"
	case strings.Contains(text, "会话") || strings.Contains(text, "回合"):
		return "session"
	case strings.Contains(text, "应用启动") || strings.Contains(text, "启动参数"):
		return "startup"
	default:
		return "app"
	}
}

// Only a local correlation key is retained, never the original session ID.
func diagSessionKey(id string) string {
	if id == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(id))
	return fmt.Sprintf("%x", sum[:6])
}

var (
	diagBearer      = regexp.MustCompile(`(?i)\b(Bearer|Basic)\s+[^\s,;"']+`)
	diagSecret      = regexp.MustCompile(`(?i)((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie|webhook)(?:["']?)\s*(?:=|:|：)\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)`)
	diagURL         = regexp.MustCompile(`(?i)(?:https?|socks5h?)://[^\s"'<>]+`)
	diagPathPattern = regexp.MustCompile(`(^|[\s("'=：])((?:[A-Za-z]:[\\/]|/)[^\s"')<>]+)`)
	diagPackage     = regexp.MustCompile(`^@?[a-zA-Z0-9_.-]+(?:/[a-zA-Z0-9_.-]+)?(?:@[a-zA-Z0-9_.^~+-]+)?$`)
)

func redactDiagText(text string) string {
	text = diagURL.ReplaceAllStringFunc(text, func(raw string) string {
		u, err := url.Parse(raw)
		if err != nil {
			return "***"
		}
		u.User = nil
		if u.RawQuery != "" {
			u.RawQuery = "***"
		}
		if u.Fragment != "" {
			u.Fragment = "***"
		}
		if strings.Contains(strings.ToLower(u.Path), "hook") {
			u.Path = "/***"
			u.RawPath = ""
		}
		return u.String()
	})
	text = diagBearer.ReplaceAllString(text, "$1 ***")
	text = diagSecret.ReplaceAllString(text, "$1***")
	text = diagPathPattern.ReplaceAllStringFunc(text, func(match string) string {
		parts := diagPathPattern.FindStringSubmatch(match)
		path := strings.ReplaceAll(parts[2], "\\", "/")
		return parts[1] + "<path>/" + filepath.Base(path)
	})
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r", " "), "\n", " ")
	if len(text) > 4096 {
		text = text[:4096]
		for !utf8.ValidString(text) {
			text = text[:len(text)-1]
		}
		text += "…"
	}
	return text
}

// Unknown option values and free text are hidden. Keeping an allowlist here
// prevents prompt bodies, credentials and paths from entering launch logs.
func diagCommand(command string, args []string) string {
	out := []string{filepath.Base(strings.ReplaceAll(command, "\\", "/"))}
	safeValue := map[string]bool{"--mode": true, "--model": true, "--provider": true, "--thinking": true, "--permission-mode": true, "--profile": true}
	flags := map[string]bool{"--acp": true, "-y": true, "--no-session": true, "--no-extensions": true, "--no-skills": true, "--no-prompt-templates": true}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if strings.HasPrefix(arg, "-") {
			key, value, inline := strings.Cut(arg, "=")
			out = append(out, key)
			if flags[key] && !inline {
				continue
			}
			if !inline && i+1 < len(args) && !strings.HasPrefix(args[i+1], "-") {
				i++
				value = args[i]
			}
			if value != "" {
				if !safeValue[key] || !diagPackage.MatchString(value) {
					value = "***"
				}
				out = append(out, value)
			}
		} else if arg == "acp" || diagPackage.MatchString(arg) && strings.HasPrefix(arg, "@") {
			out = append(out, arg)
		} else {
			out = append(out, "***")
		}
	}
	return redactDiagText(strings.Join(out, " "))
}
