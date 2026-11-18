//go:build !js && !android && !ios

package sessionimport

// Importing sessions from other agents. A source is one tool whose history
// this app can read (Claude Code, Codex, Cursor, Kimi, …): it lists the
// sessions in its store and turns one into a pi session in this app's own
// store, so an imported session is browsable and resumable like any other.
//
// What is written is a normal pi session file, plus a marker line right
// after the header that names the source session and the version of the
// file it came from. The marker is what makes a second import a no-op, and
// a changed source (`outdated`) a re-import instead of a duplicate.

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// importMarkerBytes is how much of an imported file is read to find its
// marker: the marker sits right after the header, so this is far more than
// enough, and a session of any size costs the same.
const importMarkerBytes = 128 << 10

// importWorkerLimit caps how many sessions are converted at once: the work
// is mostly reading and writing, and more than this only makes the disk
// seek.
const WorkerLimit = 4

// importScanWorkers bounds the concurrent header reads within one source.
const importScanWorkers = 8

// importBlock is one content block of an imported message, in pi's terms.
type Block struct {
	// Kind is pi's block type: text, thinking, toolCall or image.
	Kind      string
	Text      string
	Thinking  string
	ID        string
	Name      string
	Arguments json.RawMessage
	Data      string
	MimeType  string
}

// importMessage is one message of an imported session.
type Message struct {
	// Role is pi's: user, assistant or toolResult.
	Role       string
	Blocks     []Block
	Text       string // a tool result's text
	Timestamp  time.Time
	Model      string
	Provider   string
	StopReason string
	ToolCallID string
	ToolName   string
	IsError    bool
	// Usage is what the source counted, when it counted anything: the
	// session panel's token and context numbers come from it.
	Usage *Usage
}

// importUsage is a source's token counts.
type Usage struct {
	Input      int
	Output     int
	CacheRead  int
	CacheWrite int
}

// importedSession is a foreign transcript, parsed into pi's terms.
type Session struct {
	Cwd      string
	Title    string
	Updated  time.Time
	Messages []Message
}

// importCandidate is one session a source's store holds, before it is read.
type Candidate struct {
	Source  string    // the source's key
	ID      string    // the session's id in that source
	Path    string    // the file to read
	Cwd     string    // the folder it ran in, when the store says
	Title   string    // as the source names it, when cheap to read
	Updated time.Time // last used
	Size    int64
	MTime   time.Time
	Count   int // messages, when the head knows
}

// Key identifies a candidate across scans.
func (c Candidate) Key() string { return c.Source + "|" + c.ID }

// importSource is one tool this app can read sessions from.
type Source struct {
	Key   string
	Label string
	// Version is the converter's version, written into the marker: a source
	// read by an older converter shows as outdated and is read again.
	Version int
	// Roots are the folders a scan reads, most specific first.
	Roots func() []string
	// Scan lists the sessions one root holds.
	Scan func(root string) ([]Candidate, error)
	// Read parses one session fully, for conversion.
	Read func(path string) (Session, error)
	// Sniff says whether a file looks like this source's session, for the
	// file picker and drag and drop.
	Sniff func(head []byte) bool
}

// importSources are the tools this app can import from, in the order the
// dialog lists them.
var Sources = []*Source{
	Claude,
	Qoder,
	Codex,
	Cursor,
	Kimi,
	KimiWork,
	Minimax,
	ZCode,
	OpenCode,
}

// importSourceByKey finds one source.
func SourceByKey(key string) *Source {
	for _, s := range Sources {
		if s.Key == key {
			return s
		}
	}
	return nil
}

// importState is where one source session stands in this app.
type State int

const (
	// importNew is a session this app does not hold yet.
	New State = iota
	// importCurrent is one already imported, unchanged since.
	Current
	// importOutdated is one imported from an older copy of the session.
	Outdated
)

// importRow is one session in the import dialog.
type Row struct {
	Candidate
	State  State
	Target string // the file it is (or would be) imported to
	Err    string // why the last import of it failed
}

// importMark is the line an imported file carries after its header.
type importMark struct {
	Type        string `json:"type"`
	Source      string `json:"source"`
	SourceID    string `json:"sourceID"`
	SourcePath  string `json:"sourcePath"`
	SourceSize  int64  `json:"sourceSize"`
	SourceMTime int64  `json:"sourceMtime"` // Unix milliseconds
	Version     int    `json:"version"`
	Timestamp   string `json:"timestamp"`
}

// readImportMarker reads the marker of an imported file, if it has one.
func readImportMarker(path string) (importMark, bool) {
	f, err := os.Open(path)
	if err != nil {
		return importMark{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, importMarkerBytes))
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	for i := 0; i < 16 && sc.Scan(); i++ {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		var mark importMark
		if json.Unmarshal(line, &mark) != nil || !strings.HasSuffix(mark.Type, "_import") {
			continue
		}
		return mark, true
	}
	return importMark{}, false
}

// importFileName is the file a source session is imported to: the source
// and its id, so a second import finds it without reading anything.
func FileName(source Source, id string) string {
	return importFileToken(source.Key) + "_" + importFileToken(id) + ".jsonl"
}

// importFileToken keeps a name safe for a file system, and short enough for
// a path. The hash keeps two ids that clean up the same way apart.
func importFileToken(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('-')
		}
	}
	out := strings.Trim(b.String(), "-.")
	if out == "" {
		out = "session"
	}
	if len(out) > 72 {
		out = out[:72]
	}
	if out != s {
		sum := sha1.Sum([]byte(s))
		out += "-" + hex.EncodeToString(sum[:3])
	}
	return out
}

// importStateOf says whether an imported file is up to date with its source.
func StateOf(target string, c Candidate, version int) State {
	mark, ok := readImportMarker(target)
	if !ok {
		if _, err := os.Stat(target); err != nil {
			return New
		}
		// A file with our name and no marker: not ours to overwrite.
		return Current
	}
	if mark.Source != c.Source || mark.SourceID != c.ID {
		// Same name, another session (two ids that clean up alike).
		return New
	}
	if mark.Version != version {
		return Outdated
	}
	if mark.SourceSize != c.Size || mark.SourceMTime != c.MTime.UnixMilli() {
		return Outdated
	}
	return Current
}

// scanSource lists the sessions one source's store holds, and where each
// stands in this app. The roots are read in order and a session found in
// two of them (an old and a new install) is listed once, from the first.
func Scan(source Source, index map[string]string) ([]Row, error) {
	var rows []Row
	seen := map[string]bool{}
	var firstErr error
	for _, root := range source.Roots() {
		if root == "" {
			continue
		}
		if _, err := os.Stat(root); err != nil {
			continue
		}
		cands, err := source.Scan(root)
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		for _, c := range cands {
			if c.ID == "" || c.Path == "" || seen[c.Key()] {
				continue
			}
			seen[c.Key()] = true
			target, known := index[c.Key()]
			if !known {
				target = ""
			}
			row := Row{Candidate: c, Target: target}
			if known {
				row.State = StateOf(target, c, source.Version)
			}
			rows = append(rows, row)
		}
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i].Updated.After(rows[j].Updated) })
	return rows, firstErr
}

// firstUserText is the first thing the user said, for a name.
func FirstUserText(msgs []Message) string {
	for _, m := range msgs {
		if m.Role != "user" {
			continue
		}
		for _, b := range m.Blocks {
			if b.Kind == "text" && strings.TrimSpace(b.Text) != "" {
				return b.Text
			}
		}
	}
	return ""
}

// sessionHead is a pi session file's first line.
type sessionHead struct {
	ID  string `json:"id"`
	Cwd string `json:"cwd"`
}

// readSessionHead reads the header of a pi session file.
func ReadSessionHead(path string) (sessionHead, bool) {
	f, err := os.Open(path)
	if err != nil {
		return sessionHead{}, false
	}
	defer f.Close()
	sc := bufio.NewScanner(io.LimitReader(f, 64<<10))
	sc.Buffer(make([]byte, 0, 8<<10), 1<<20)
	for i := 0; i < 4 && sc.Scan(); i++ {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var head sessionHead
		if json.Unmarshal(line, &head) == nil && head.ID != "" {
			return head, true
		}
	}
	return sessionHead{}, false
}

// writePiSession streams a parsed session out as pi's JSONL.
func WritePiSession(w io.Writer, id, cwd, title string, updated time.Time, parsed Session, source Source, c Candidate) error {
	bw := bufio.NewWriterSize(w, 256<<10)
	enc := json.NewEncoder(bw)
	when := updated.UTC().Format(time.RFC3339Nano)
	if err := enc.Encode(map[string]any{
		"type": "session", "version": 3, "id": id, "timestamp": when, "cwd": cwd,
	}); err != nil {
		return err
	}
	if err := enc.Encode(importMark{
		Type: source.Key + "_import", Source: source.Key, SourceID: c.ID, SourcePath: c.Path,
		SourceSize: c.Size, SourceMTime: c.MTime.UnixMilli(), Version: source.Version, Timestamp: when,
	}); err != nil {
		return err
	}
	parent := ""
	for i, m := range parsed.Messages {
		mid := fmt.Sprintf("m%d", i+1)
		msgID := fmt.Sprintf("%s-%d", id[:8], i+1)
		ts := m.Timestamp
		if ts.IsZero() {
			ts = updated
		}
		if err := enc.Encode(piMessageLine(m, mid, msgID, parent, ts)); err != nil {
			return err
		}
		parent = msgID
	}
	if err := enc.Encode(map[string]any{
		"type": "session_info", "name": title, "timestamp": updated.UTC().Format(time.RFC3339Nano),
	}); err != nil {
		return err
	}
	return bw.Flush()
}

// piMessageLine turns one imported message into pi's message line.
func piMessageLine(m Message, lineID, msgID, parent string, ts time.Time) map[string]any {
	msg := map[string]any{"role": m.Role, "timestamp": ts.UnixMilli()}
	line := map[string]any{"type": "message", "id": msgID, "parentId": parent,
		"timestamp": ts.UTC().Format(time.RFC3339Nano), "message": msg}
	switch m.Role {
	case "toolResult":
		msg["toolCallId"] = m.ToolCallID
		msg["toolName"] = m.ToolName
		msg["content"] = []map[string]any{{"type": "text", "text": m.Text}}
		if m.IsError {
			msg["isError"] = true
		}
		return line
	}
	blocks := make([]map[string]any, 0, len(m.Blocks))
	for _, b := range m.Blocks {
		switch b.Kind {
		case "thinking":
			blocks = append(blocks, map[string]any{"type": "thinking", "thinking": b.Thinking})
		case "toolCall":
			args := b.Arguments
			if len(args) == 0 {
				args = json.RawMessage("{}")
			}
			blocks = append(blocks, map[string]any{"type": "toolCall", "id": b.ID, "name": b.Name, "arguments": args})
		case "image":
			blocks = append(blocks, map[string]any{"type": "image", "data": b.Data, "mimeType": b.MimeType})
		default:
			blocks = append(blocks, map[string]any{"type": "text", "text": b.Text})
		}
	}
	msg["content"] = blocks
	if m.Role == "assistant" {
		msg["api"] = "import"
		msg["provider"] = orDefault(m.Provider, "import")
		msg["model"] = orDefault(m.Model, "import")
		msg["stopReason"] = orDefault(m.StopReason, "stop")
		in, out, read, write := 0, 0, 0, 0
		if m.Usage != nil {
			in, out, read, write = m.Usage.Input, m.Usage.Output, m.Usage.CacheRead, m.Usage.CacheWrite
		}
		msg["usage"] = map[string]any{"input": in, "output": out, "cacheRead": read, "cacheWrite": write,
			"totalTokens": in + out + read + write,
			"cost":        map[string]any{"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}}
	}
	return line
}

// orDefault returns s, or def when s is empty.
func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}

// homePath is a path under the user's home folder.
func homePath(parts ...string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(append([]string{home}, parts...)...)
}

// importRoot is where a source reads: the folder an environment variable
// names, else the tool's own place. A nonstandard install, or a test, can
// point a source elsewhere without touching the app's settings.
func importRoot(key string, parts ...string) string {
	if dir := strings.TrimSpace(os.Getenv("PIDECK_LITE_IMPORT_" + strings.ToUpper(key) + "_DIR")); dir != "" {
		return dir
	}
	return homePath(parts...)
}
