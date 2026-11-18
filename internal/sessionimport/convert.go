//go:build !js && !android && !ios

package sessionimport

// Turning the parts every source has in common into pi's terms: content
// blocks, tool arguments, tool output and stop reasons. Each source's file
// differs in layout; these rules are shared so an imported session reads
// the same whichever tool wrote it.

import (
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// importImageMax is the largest base64 image worth keeping: about 256KB of
// bytes. A bigger one becomes a text placeholder, so a photo pasted into
// another agent cannot bloat the session file it lands in.
const importImageMax = 350_000

// importImageBlock is an image content block, or a text placeholder when
// the source gave no bytes or too many.
func importImageBlock(data, mime, label string) Block {
	data = stripDataURL(data)
	if data == "" || len(data) > importImageMax {
		return importPlaceholder("image", label)
	}
	if strings.TrimSpace(mime) == "" {
		mime = "image/png"
	}
	return Block{Kind: "image", Data: data, MimeType: mime}
}

// stripDataURL drops a data URL's prefix and every space in its payload.
func stripDataURL(v string) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(strings.ToLower(v), "data:") {
		if comma := strings.IndexByte(v, ','); comma >= 0 {
			v = v[comma+1:]
		}
	}
	return strings.Join(strings.Fields(v), "")
}

// importPlaceholder stands in for something that could not be kept.
func importPlaceholder(kind, label string) Block {
	label = strings.Join(strings.Fields(label), " ")
	if label == "" {
		label = kind
	}
	return Block{Kind: "text", Text: "[" + kind + ": " + label + "]"}
}

// importArguments turns a tool call's arguments into pi's JSON: pi reads a
// JSON object, so a string or a list is wrapped rather than dropped.
func importArguments(v any) json.RawMessage {
	switch v := v.(type) {
	case nil:
		return json.RawMessage("{}")
	case json.RawMessage:
		return v
	case map[string]any:
		out, err := json.Marshal(v)
		if err != nil {
			return json.RawMessage("{}")
		}
		return out
	case []any:
		out, err := json.Marshal(map[string]any{"items": v})
		if err != nil {
			return json.RawMessage("{}")
		}
		return out
	case string:
		if text := strings.TrimSpace(v); strings.HasPrefix(text, "{") || strings.HasPrefix(text, "[") {
			if json.Valid([]byte(text)) {
				return json.RawMessage(text)
			}
		}
		out, _ := json.Marshal(map[string]any{"value": v})
		return out
	default:
		out, err := json.Marshal(map[string]any{"value": v})
		if err != nil {
			return json.RawMessage("{}")
		}
		return out
	}
}

// importToolOutput is a tool result's text, whichever shape the source used.
func importToolOutput(v any) string {
	switch v := v.(type) {
	case nil:
		return ""
	case string:
		return v
	case []any:
		var parts []string
		for _, item := range v {
			switch item := item.(type) {
			case string:
				parts = append(parts, item)
			case map[string]any:
				if text, ok := item["text"].(string); ok {
					parts = append(parts, text)
				} else if content, ok := item["content"]; ok {
					parts = append(parts, importToolOutput(content))
				}
			default:
				if out, err := json.Marshal(item); err == nil {
					parts = append(parts, string(out))
				}
			}
		}
		return strings.Join(parts, "\n")
	case map[string]any:
		if text, ok := v["text"].(string); ok {
			return text
		}
		if content, ok := v["content"]; ok {
			return importToolOutput(content)
		}
		if out, err := json.MarshalIndent(v, "", "  "); err == nil {
			return string(out)
		}
	}
	out, err := json.Marshal(v)
	if err != nil {
		return ""
	}
	return string(out)
}

// importStopReason maps a source's ending to pi's: a message that asked for
// a tool is a tool use whatever the source called it.
func importStopReason(raw string, hasToolCall bool) string {
	if hasToolCall {
		return "toolUse"
	}
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(raw, "_", "-"))) {
	case "", "stop", "end-turn", "endturn", "unknown", "complete", "completed":
		return "stop"
	case "tooluse", "tool-use", "tool-calls", "toolcall":
		return "toolUse"
	case "max-tokens", "length", "max-length":
		return "length"
	case "error":
		return "error"
	case "aborted", "abort", "cancelled", "canceled":
		return "aborted"
	}
	return "stop"
}

// importTitle cleans a name a source gave a session.
func importTitle(v string) string {
	text := strings.Join(strings.Fields(metaTag.ReplaceAllString(v, " ")), " ")
	if text == "" || strings.EqualFold(text, "untitled") {
		return ""
	}
	return titleLine(text, 60)
}

// asMap reads a decoded JSON value as an object.
func asMap(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return nil
}

// asList reads a decoded JSON value as a list.
func asList(v any) []any {
	if l, ok := v.([]any); ok {
		return l
	}
	return nil
}

// asString reads a decoded JSON value as a string.
func asString(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

// asFloat reads a decoded JSON number.
func asFloat(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	}
	return 0
}

// importTime reads a timestamp in the shapes sources use: an ISO string, or
// seconds or milliseconds since the epoch.
func importTime(v any) (t importTimeValue) {
	switch v := v.(type) {
	case string:
		v = strings.TrimSpace(v)
		if v == "" {
			return t
		}
		if parsed, err := parseImportISOTime(v); err == nil {
			t.time = parsed
			t.ok = true
			return t
		}
	case float64:
		return importEpochTime(v)
	case json.Number:
		f, _ := v.Float64()
		return importEpochTime(f)
	}
	return t
}

// importTimeValue is a time read from a source, and whether it read.
type importTimeValue struct {
	time time.Time
	ok   bool
}

// importEpochTime reads seconds or milliseconds since the epoch.
func importEpochTime(f float64) importTimeValue {
	if f <= 0 {
		return importTimeValue{}
	}
	if f >= 1e12 { // milliseconds
		return importTimeValue{time: time.UnixMilli(int64(f)), ok: true}
	}
	secs := int64(f)
	return importTimeValue{time: time.Unix(secs, int64((f-float64(secs))*1e9)), ok: true}
}

// parseImportISOTime reads the timestamp strings sources write.
func parseImportISOTime(s string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05", "2006-01-02 15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t, nil
		}
	}
	return time.Time{}, fmt.Errorf("认不出这个时间：%s", s)
}

// importToolCall is a tool call a source asked for.
type importToolCall struct {
	ID   string
	Name string
}

// importToken makes a short, stable id from a seed.
func importToken(seed string) string {
	sum := sha1.Sum([]byte(seed))
	return hex.EncodeToString(sum[:4])
}

// repairToolResults gives every tool call an answer: pi reads a turn's
// tools by their results, and a source that stopped mid-call (a cancelled
// turn, a crash) leaves one without. The empty result keeps the transcript
// readable and resumable.
func repairToolResults(msgs []Message) []Message {
	answered := map[string]bool{}
	for _, m := range msgs {
		if m.Role == "toolResult" && m.ToolCallID != "" {
			answered[m.ToolCallID] = true
		}
	}
	out := make([]Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, m)
		if m.Role != "assistant" {
			continue
		}
		for _, b := range m.Blocks {
			if b.Kind != "toolCall" || b.ID == "" || answered[b.ID] {
				continue
			}
			at := m.Timestamp.Add(time.Millisecond)
			out = append(out, Message{Role: "toolResult", Timestamp: at, ToolCallID: b.ID,
				ToolName: orDefault(b.Name, "tool"), Text: ""})
			answered[b.ID] = true
		}
	}
	return out
}

// importUsageOf reads token counts in the shapes the sources use: Kimi's
// inputOther/inputCacheRead naming, or input/output with a cache object.
func importUsageOf(v any) *Usage {
	m := asMap(v)
	if m == nil {
		return nil
	}
	count := func(m map[string]any, keys ...string) int {
		for _, key := range keys {
			if n := int(asFloat(m[key])); n > 0 {
				return n
			}
		}
		return 0
	}
	u := &Usage{Input: count(m, "input", "inputOther", "inputTokens"), Output: count(m, "output", "outputTokens")}
	if cache := asMap(m["cache"]); cache != nil {
		u.CacheRead = count(cache, "read", "cacheRead")
		u.CacheWrite = count(cache, "write", "cacheWrite")
	}
	if n := count(m, "inputCacheRead", "cacheRead"); n > u.CacheRead {
		u.CacheRead = n
	}
	if n := count(m, "inputCacheCreation", "cacheWrite"); n > u.CacheWrite {
		u.CacheWrite = n
	}
	if u.Input+u.Output+u.CacheRead+u.CacheWrite == 0 {
		return nil
	}
	return u
}

// reminderBlock and metaTag are wrappers a tool puts around the user's own
// words: the agent's context and a timestamp tag are not something anyone
// typed.
var (
	reminderBlock = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>`)
	metaTag       = regexp.MustCompile(`<meta[^>]*/>`)
)

// stripInjectedReminder drops the context a tool injects into a message.
func stripInjectedReminder(text string) string {
	text = reminderBlock.ReplaceAllString(text, "")
	text = metaTag.ReplaceAllString(text, "")
	return strings.TrimSpace(text)
}
