package main

// Config and session storage. The app keeps its own JSON config beside a
// private pi session directory, so browsing history never touches the
// sessions a terminal pi or PiDeck may have open.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// workspaceCfg is one project folder.
type workspaceCfg struct {
	Path     string `json:"path"`
	Name     string `json:"name,omitempty"`
	Expanded bool   `json:"expanded"`
	// Target is where its agents run: "" here, "wsl:<distro>",
	// "ssh:<host>".
	Target string `json:"target,omitempty"`
}

// modelChoice remembers a provider/model across runs.
type modelChoice struct {
	Provider string `json:"provider,omitempty"`
	ID       string `json:"id,omitempty"`
}

// config is everything the app restores at startup.
type config struct {
	Version     int               `json:"version"`
	Workspaces  []workspaceCfg    `json:"workspaces"`
	LastSession string            `json:"lastSession,omitempty"`
	Tabs        []string          `json:"tabs,omitempty"`
	Theme       string            `json:"theme,omitempty"` // system, light, dark
	SidebarOpen bool              `json:"sidebarOpen"`
	DrawerOpen  bool              `json:"drawerOpen"`
	Model       modelChoice       `json:"model"`
	Thinking    string            `json:"thinking,omitempty"`
	Titles      map[string]string `json:"titles,omitempty"`
	// Pinned are the sessions kept at the top of the rail, and FavModels
	// the "provider/id" of the models offered first.
	Pinned    []string `json:"pinned,omitempty"`
	FavModels []string `json:"favModels,omitempty"`
	// ProviderOrder is the order suppliers are listed in, pinned ones
	// first; providers it does not name follow alphabetically.
	ProviderOrder []string `json:"providerOrder,omitempty"`
	// ScanPi lists pi's own sessions under the projects that own them, and
	// ScanAll lists every folder pi has ever run in.
	ScanPi  bool `json:"scanPi"`
	ScanAll bool `json:"scanAll"`
	// SessionSort orders a project's sessions: "updated" (default) or
	// "name".
	SessionSort string `json:"sessionSort,omitempty"`
	// TerminalOpen and TerminalHeight restore the bottom terminal panel.
	TerminalOpen   bool    `json:"terminalOpen,omitempty"`
	TerminalHeight float64 `json:"terminalHeight,omitempty"`
	// Remote is the phone server: whether it listens, its port and token,
	// and the EasyTier address when its CLI cannot be read.
	RemoteEnabled    bool   `json:"remoteEnabled,omitempty"`
	RemotePort       int    `json:"remotePort,omitempty"`
	RemoteToken      string `json:"remoteToken,omitempty"`
	RemoteEasyTierIP string `json:"remoteEasyTierIP,omitempty"`
	// DisabledPlugins are the plugin ids the user turned off; everything
	// else under plugins/ runs.
	DisabledPlugins []string `json:"disabledPlugins,omitempty"`
	// Keybindings replaces a command's default key, by command id. An
	// empty key removes the binding.
	Keybindings map[string]string `json:"keybindings,omitempty"`
	// CloseToTray keeps the app running in the tray when its window is
	// closed. NotifyOnDone posts a desktop notification when a turn
	// finishes, and NotifyOnlyHidden keeps it quiet while the window
	// shows.
	CloseToTray      bool `json:"closeToTray"`
	NotifyOnDone     bool `json:"notifyOnDone"`
	NotifyOnlyHidden bool `json:"notifyOnlyHidden"`
	// Language is the interface's language: "" follows the system, else
	// zh-CN, zh-TW or en-US.
	Language string `json:"language,omitempty"`
}

// store holds the config file and the session directory.
type store struct {
	dir      string // app data
	sessions string // private pi session directory
	path     string // config.json
	mu       sync.Mutex
	c        *config
}

func newStore(dataDir string) (*store, error) {
	s := &store{
		dir:      dataDir,
		sessions: filepath.Join(dataDir, "sessions"),
		path:     filepath.Join(dataDir, "config.json"),
		c: &config{Version: 1, SidebarOpen: true, Theme: "system", Titles: map[string]string{}, ScanPi: true,
			CloseToTray: true, NotifyOnDone: true, NotifyOnlyHidden: true},
	}
	if err := os.MkdirAll(s.sessions, 0o755); err != nil {
		return nil, err
	}
	if raw, err := os.ReadFile(s.path); err == nil {
		var c config
		if json.Unmarshal(raw, &c) == nil {
			if c.Titles == nil {
				c.Titles = map[string]string{}
			}
			// A config written before these fields existed reads pi's own
			// sessions under their projects: it is the useful default.
			if !bytes.Contains(raw, []byte(`"scanPi"`)) && !bytes.Contains(raw, []byte(`"scanAll"`)) {
				c.ScanPi = true
			}
			// Older configs did not know the tray or notifications: keep
			// them on, as a fresh install has them.
			if !bytes.Contains(raw, []byte(`"closeToTray"`)) {
				c.CloseToTray = true
			}
			if !bytes.Contains(raw, []byte(`"notifyOnDone"`)) {
				c.NotifyOnDone = true
			}
			if !bytes.Contains(raw, []byte(`"notifyOnlyHidden"`)) {
				c.NotifyOnlyHidden = true
			}
			c.Version = 1
			s.c = &c
		}
	}
	return s, nil
}

// config returns a copy safe to read on the UI thread.
func (s *store) config() config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := *s.c
	c.Workspaces = append([]workspaceCfg(nil), s.c.Workspaces...)
	c.Tabs = append([]string(nil), s.c.Tabs...)
	c.Pinned = append([]string(nil), s.c.Pinned...)
	c.FavModels = append([]string(nil), s.c.FavModels...)
	c.ProviderOrder = append([]string(nil), s.c.ProviderOrder...)
	c.DisabledPlugins = append([]string(nil), s.c.DisabledPlugins...)
	c.Keybindings = make(map[string]string, len(s.c.Keybindings))
	for k, v := range s.c.Keybindings {
		c.Keybindings[k] = v
	}
	c.Titles = make(map[string]string, len(s.c.Titles))
	for k, v := range s.c.Titles {
		c.Titles[k] = v
	}
	return c
}

// edit changes the config and writes it.
func (s *store) edit(fn func(*config)) {
	s.mu.Lock()
	fn(s.c)
	raw, err := json.MarshalIndent(s.c, "", "  ")
	path := s.path
	s.mu.Unlock()
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if os.WriteFile(tmp, raw, 0o644) == nil {
		_ = os.Rename(tmp, path)
	}
}

// sessionMeta is a session as the sidebar and tabs need it before its
// process starts.
type sessionMeta struct {
	ID      string
	Cwd     string
	File    string
	Title   string
	Updated time.Time
	Count   int
	Target  string
	// External marks a session in pi's own store, which the app opens in
	// place rather than owning.
	External bool
}

// scanSessions reads the headers and names of the session files in the
// app's store, newest first.
func (s *store) scanSessions(titles map[string]string) []sessionMeta {
	var metas []sessionMeta
	_ = filepath.WalkDir(s.sessions, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		if m, ok := readSessionMeta(path, titles); ok {
			metas = append(metas, m)
		}
		if len(metas) > 2000 {
			return filepath.SkipAll
		}
		return nil
	})
	sort.Slice(metas, func(i, j int) bool { return metas[i].Updated.After(metas[j].Updated) })
	return metas
}

// scanPiSessions reads pi's own session store, keeping the sessions of the
// folders keep allows, at most limit of them.
func (s *store) scanPiSessions(root string, titles map[string]string, keep func(cwd string) bool, limit int) []sessionMeta {
	if root == "" || filepath.Clean(root) == filepath.Clean(s.sessions) {
		return nil
	}
	var metas []sessionMeta
	_ = filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || !strings.HasSuffix(strings.ToLower(d.Name()), ".jsonl") {
			return nil
		}
		m, ok := readSessionMeta(path, titles)
		if !ok || (keep != nil && !keep(m.Cwd)) {
			return nil
		}
		m.External = true
		metas = append(metas, m)
		if limit > 0 && len(metas) >= limit {
			return filepath.SkipAll
		}
		return nil
	})
	sort.Slice(metas, func(i, j int) bool { return metas[i].Updated.After(metas[j].Updated) })
	return metas
}

// readSessionMeta reads as much of one session file as a listing needs.
func readSessionMeta(path string, titles map[string]string) (sessionMeta, bool) {
	f, err := os.Open(path)
	if err != nil {
		return sessionMeta{}, false
	}
	defer f.Close()
	meta := sessionMeta{File: path}
	if info, err := f.Stat(); err == nil {
		meta.Updated = info.ModTime()
	}
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64<<10), 4<<20)
	firstUser := ""
	for sc.Scan() {
		line := sc.Bytes()
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var entry struct {
			Type      string          `json:"type"`
			Timestamp string          `json:"timestamp"`
			Cwd       string          `json:"cwd"`
			ID        string          `json:"id"`
			Name      string          `json:"name"`
			Message   json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &entry) != nil {
			continue
		}
		if entry.Type == "session" {
			meta.Cwd, meta.ID = entry.Cwd, entry.ID
			continue
		}
		if entry.Type == "session_info" && entry.Name != "" {
			meta.Title = entry.Name
		}
		if t, err := time.Parse(time.RFC3339Nano, entry.Timestamp); err == nil {
			meta.Updated = t
		}
		if entry.Type != "message" || len(entry.Message) == 0 {
			continue
		}
		var msg piMessage
		if json.Unmarshal(entry.Message, &msg) != nil {
			continue
		}
		meta.Count++
		if msg.Role == "user" && firstUser == "" {
			if text := strings.TrimSpace(msg.text()); text != "" && !strings.HasPrefix(text, "/") {
				firstUser = text
			} else if text != "" {
				firstUser = text
			}
		}
	}
	if meta.ID == "" {
		return sessionMeta{}, false
	}
	meta.Cwd = filepath.Clean(meta.Cwd)
	if t := titles[meta.ID]; t != "" {
		meta.Title = t
	}
	if meta.Title == "" && firstUser != "" {
		meta.Title = firstLine(firstUser, 48)
	}
	if meta.Title == "" {
		meta.Title = "未命名会话"
	}
	return meta, true
}

// importSession copies a session file into the app's own store, so it can
// be resumed here without sharing a file with another app.
func (s *store) importSession(src string) (sessionMeta, error) {
	f, err := os.Open(src)
	if err != nil {
		return sessionMeta{}, err
	}
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Cwd  string `json:"cwd"`
	}
	err = json.NewDecoder(bufio.NewReader(f)).Decode(&head)
	f.Close()
	if err != nil || head.Type != "session" || head.ID == "" {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	existing, _ := filepath.Glob(filepath.Join(s.sessions, "*", "*_"+head.ID+".jsonl"))
	if len(existing) > 0 {
		return sessionMeta{}, fmt.Errorf("这个会话已经导入过了")
	}
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(head.Cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, err
	}
	dst := filepath.Join(dir, time.Now().UTC().Format("2006-01-02T15-04-05-000Z")+"_"+head.ID+".jsonl")
	data, err := os.ReadFile(src)
	if err != nil {
		return sessionMeta{}, err
	}
	if err := os.WriteFile(dst, data, 0o644); err != nil {
		return sessionMeta{}, err
	}
	m, ok := readSessionMeta(dst, nil)
	if !ok {
		return sessionMeta{}, fmt.Errorf("导入后无法读取该会话")
	}
	return m, nil
}

// duplicateSession copies a session file under a new id, so the copy can
// be resumed without sharing a file with the original.
func (s *store) duplicateSession(src, id, title string) (sessionMeta, error) {
	if src == "" || id == "" {
		return sessionMeta{}, fmt.Errorf("没有可复制的会话文件")
	}
	raw, err := os.ReadFile(src)
	if err != nil {
		return sessionMeta{}, err
	}
	nl := bytes.IndexByte(raw, '\n')
	if nl < 0 {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	var head map[string]any
	if json.Unmarshal(raw[:nl], &head) != nil || head["type"] != "session" {
		return sessionMeta{}, fmt.Errorf("不是有效的 pi 会话文件")
	}
	cwd, _ := head["cwd"].(string)
	now := time.Now().UTC()
	head["id"] = id
	head["timestamp"] = now.Format(time.RFC3339Nano)
	headRaw, err := json.Marshal(head)
	if err != nil {
		return sessionMeta{}, err
	}
	var out bytes.Buffer
	out.Write(headRaw)
	out.WriteByte('\n')
	out.Write(raw[nl+1:])
	if title != "" {
		info, _ := json.Marshal(map[string]any{
			"type":      "session_info",
			"name":      title,
			"timestamp": now.Format(time.RFC3339Nano),
		})
		out.Write(info)
		out.WriteByte('\n')
	}
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, err
	}
	dst := filepath.Join(dir, now.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	if err := os.WriteFile(dst, out.Bytes(), 0o644); err != nil {
		return sessionMeta{}, err
	}
	m, ok := readSessionMeta(dst, nil)
	if !ok {
		return sessionMeta{}, fmt.Errorf("复制后无法读取该会话")
	}
	return m, nil
}

// deleteSession moves a session file out of the way rather than erasing
// it. A process that just closed can hold the file a moment longer, so the
// move is retried before it is reported as failed.
func (s *store) deleteSession(file, id string) error {
	if file == "" {
		return nil
	}
	trash := filepath.Join(s.dir, "trash")
	if err := os.MkdirAll(trash, 0o755); err != nil {
		return err
	}
	stamp := time.Now().Format("20060102-150405")
	dst := filepath.Join(trash, stamp+"-"+id+".jsonl")
	var err error
	for i := 0; i < 12; i++ {
		if err = os.Rename(file, dst); err == nil {
			return nil
		}
		if _, statErr := os.Stat(file); statErr != nil {
			return nil // already gone
		}
		dst = filepath.Join(trash, fmt.Sprintf("%s-%s-%d.jsonl", stamp, id, i+1))
		time.Sleep(time.Duration(60*(i+1)) * time.Millisecond)
	}
	return fmt.Errorf("文件被占用，稍后再试：%w", err)
}

// encodeCwd is pi's session folder name for a working directory: the
// path with its separator, drive colon and slashes flattened.
func encodeCwd(cwd string) string {
	if cwd == "" {
		return "--unknown--"
	}
	r := strings.NewReplacer(":", "-", "\\", "-", "/", "-")
	return "--" + strings.Trim(r.Replace(filepath.Clean(cwd)), "-") + "--"
}

// newSessionID makes a UUID v4, the ID pi uses for a session.
func newSessionID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(b[0:4]), hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]), hex.EncodeToString(b[8:10]), hex.EncodeToString(b[10:16]))
}

// firstLine shortens text to one line of at most n runes.
func firstLine(text string, n int) string {
	text = strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	text = strings.TrimSpace(strings.TrimLeft(text, "#>*-+ "))
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n]) + "…"
}

// shortPath shortens an absolute path for a label, keeping its end.
func shortPath(path string, n int) string {
	runes := []rune(path)
	if len(runes) <= n {
		return path
	}
	return "…" + string(runes[len(runes)-n+1:])
}

// forkSession copies a session up to the user message at turn, writes it
// under a new id, and returns the prompt that was left out so the app can
// put it back in the composer. The original file is not touched.
func (s *store) forkSession(src, id string, turn int, title string) (sessionMeta, string, error) {
	if src == "" || id == "" {
		return sessionMeta{}, "", fmt.Errorf("没有可分叉的会话文件")
	}
	raw, err := os.ReadFile(src)
	if err != nil {
		return sessionMeta{}, "", err
	}
	lines := bytes.Split(raw, []byte("\n"))
	if len(lines) == 0 {
		return sessionMeta{}, "", fmt.Errorf("不是有效的 pi 会话文件")
	}
	var head map[string]any
	if json.Unmarshal(lines[0], &head) != nil || head["type"] != "session" {
		return sessionMeta{}, "", fmt.Errorf("不是有效的 pi 会话文件")
	}
	cwd, _ := head["cwd"].(string)
	now := time.Now().UTC()
	head["id"] = id
	head["timestamp"] = now.Format(time.RFC3339Nano)
	headRaw, err := json.Marshal(head)
	if err != nil {
		return sessionMeta{}, "", err
	}
	var out bytes.Buffer
	out.Write(headRaw)
	out.WriteByte('\n')
	seenUser, prompt, found := 0, "", false
	for _, line := range lines[1:] {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var entry struct {
			Type    string          `json:"type"`
			Message json.RawMessage `json:"message"`
		}
		if json.Unmarshal(line, &entry) == nil && entry.Type == "message" && len(entry.Message) > 0 {
			var msg piMessage
			if json.Unmarshal(entry.Message, &msg) == nil && msg.Role == "user" {
				if seenUser == turn {
					prompt = msg.text()
					found = true
					break
				}
				seenUser++
			}
		}
		out.Write(line)
		out.WriteByte('\n')
	}
	if !found {
		return sessionMeta{}, "", fmt.Errorf("找不到要分叉的那一轮")
	}
	if title != "" {
		info, _ := json.Marshal(map[string]any{
			"type": "session_info", "name": title, "timestamp": now.Format(time.RFC3339Nano),
		})
		out.Write(info)
		out.WriteByte('\n')
	}
	dir := filepath.Join(s.sessions, encodeCwd(filepath.Clean(cwd)))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return sessionMeta{}, "", err
	}
	dst := filepath.Join(dir, now.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	if err := os.WriteFile(dst, out.Bytes(), 0o644); err != nil {
		return sessionMeta{}, "", err
	}
	m, ok := readSessionMeta(dst, nil)
	if !ok {
		return sessionMeta{}, "", fmt.Errorf("分叉后无法读取该会话")
	}
	return m, prompt, nil
}
