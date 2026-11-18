//go:build !js && !android && !ios

package workbench

// Checks for copying a session into the app's own store.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestDuplicateSession checks the copy has a new id, keeps the history
// and carries the name, while the original stays as it was.
func TestDuplicateSession(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "original.jsonl")
	body := `{"type":"session","version":3,"id":"old-id","timestamp":"2026-01-02T03:04:05Z","cwd":"C:/work"}
{"type":"message","id":"m1","parentId":null,"timestamp":"2026-01-02T03:04:06Z","message":{"role":"user","content":"原来的提问"}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-01-02T03:04:07Z","message":{"role":"assistant","content":[{"type":"text","text":"原来的回答"}]}}
`
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	meta, err := st.duplicateSession(src, "new-id", "会话 副本")
	if err != nil {
		t.Fatal(err)
	}
	if meta.ID != "new-id" || meta.Title != "会话 副本" {
		t.Fatalf("meta = %+v", meta)
	}
	raw, err := os.ReadFile(meta.File)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	var head struct {
		Type string `json:"type"`
		ID   string `json:"id"`
		Cwd  string `json:"cwd"`
	}
	if err := json.Unmarshal([]byte(lines[0]), &head); err != nil {
		t.Fatal(err)
	}
	if head.Type != "session" || head.ID != "new-id" || head.Cwd != "C:/work" {
		t.Fatalf("head = %+v", head)
	}
	if !strings.Contains(string(raw), "原来的提问") || !strings.Contains(string(raw), "原来的回答") {
		t.Fatalf("the copy lost the history: %s", raw)
	}
	orig, _ := os.ReadFile(src)
	if string(orig) != body {
		t.Fatal("the original session file changed")
	}
	// The copy lives under the app's own sessions directory.
	if !strings.HasPrefix(meta.File, st.sessions) {
		t.Fatalf("copy at %q, want under %q", meta.File, st.sessions)
	}
}

// TestDuplicateSessionRefusesGarbage checks a file that is not a pi
// session is not copied.
func TestDuplicateSessionRefusesGarbage(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	src := filepath.Join(dir, "not-session.jsonl")
	if err := os.WriteFile(src, []byte("hello\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := st.duplicateSession(src, "new", ""); err == nil {
		t.Fatal("a non-session file was copied")
	}
}

// TestConfigMigration repairs an old, hand-edited config and writes it back.
func TestConfigMigration(t *testing.T) {
	dir := t.TempDir()
	body := `{"sessionSort":"bogus","projectSort":"weird","language":"fr","terminalHeight":10,"remotePort":70000,
  "workspaces":[{"path":" /a "},{"path":"/a"},{"path":""}],"tabs":["t1","t1",""]}`
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := st.config()
	if c.Version != configVersion {
		t.Errorf("version = %d", c.Version)
	}
	if c.SessionSort != "" || c.ProjectSort != "" || c.Language != "" {
		t.Errorf("choices = %q/%q/%q", c.SessionSort, c.ProjectSort, c.Language)
	}
	if c.TerminalHeight != 0 || c.RemotePort != 0 {
		t.Errorf("sizes = %v/%d", c.TerminalHeight, c.RemotePort)
	}
	if len(c.Workspaces) != 1 || c.Workspaces[0].Path != "/a" {
		t.Errorf("workspaces = %+v", c.Workspaces)
	}
	if len(c.Tabs) != 1 || c.Tabs[0] != "t1" {
		t.Errorf("tabs = %v", c.Tabs)
	}
	if !c.ScanPi || !c.CloseToTray || !c.NotifyOnDone || !c.NotifyOnlyHidden {
		t.Errorf("legacy defaults = %+v", c)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"version": 3`) || strings.Contains(string(raw), "bogus") {
		t.Fatalf("migrated file = %s", raw)
	}
}

// TestConfigValidIsNotRewritten keeps a valid file exactly as it was.
func TestConfigValidIsNotRewritten(t *testing.T) {
	dir := t.TempDir()
	body := `{"version":3,"sessionSort":"name","scanPi":false,"scanAll":false,"closeToTray":false,"notifyOnDone":false,"notifyOnlyHidden":false}`
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if c := st.config(); c.SessionSort != "name" || c.ScanPi {
		t.Fatalf("config = %+v", c)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != body {
		t.Fatalf("a valid config was rewritten:\n%s", raw)
	}
}

// TestConfigCopyDoesNotAliasMaps keeps edits to a copy out of the store.
func TestConfigCopyDoesNotAliasMaps(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	st.edit(func(c *config) {
		c.PluginSettings = map[string]string{"p/k": "1"}
		c.SessionPersonas = map[string]string{"s": "review"}
		c.ForkParents = map[string]string{"child": "parent"}
	})
	c := st.config()
	c.PluginSettings["p/k"] = "2"
	c.SessionPersonas["s"] = "tests"
	c.ForkParents["child"] = "other"
	again := st.config()
	if again.PluginSettings["p/k"] != "1" || again.SessionPersonas["s"] != "review" || again.ForkParents["child"] != "parent" {
		t.Fatalf("copy aliased the store: %+v %+v %+v", again.PluginSettings, again.SessionPersonas, again.ForkParents)
	}
}

// TestTrustMigration trusts projects that existed before trust, and leaves
// a current config's choices alone.
func TestTrustMigration(t *testing.T) {
	dir := t.TempDir()
	body := `{"version":1,"workspaces":[{"path":"/a"},{"path":"/b","target":"wsl:Ubuntu"}]}`
	path := filepath.Join(dir, "config.json")
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	c := st.config()
	if c.Version != configVersion || len(c.TrustedProjects) != 2 {
		t.Fatalf("version/trusted = %d/%v", c.Version, c.TrustedProjects)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), `"version": 2`) || !strings.Contains(string(raw), "trustedProjects") {
		t.Fatalf("migrated config = %s", raw)
	}

	dir2 := t.TempDir()
	body2 := `{"version":2,"workspaces":[{"path":"/a"}]}`
	path2 := filepath.Join(dir2, "config.json")
	if err := os.WriteFile(path2, []byte(body2), 0o644); err != nil {
		t.Fatal(err)
	}
	st2, err := newStore(dir2)
	if err != nil {
		t.Fatal(err)
	}
	if got := st2.config().TrustedProjects; len(got) != 0 {
		t.Fatalf("a current config gained trust: %v", got)
	}
}

// TestTrustProject checks trusting and revoking reach the config.
func TestTrustProject(t *testing.T) {
	dir := t.TempDir()
	st, err := newStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	a.cfg = st.config()
	ws := &workspace{Path: "/p", Target: localTarget}
	if a.projectTrusted(ws) {
		t.Fatal("a new project is trusted")
	}
	a.trustProject(ws)
	if !a.projectTrusted(ws) {
		t.Fatal("trust did not stick")
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "config.json"))
	if !strings.Contains(string(raw), "/p") {
		t.Fatalf("config = %s", raw)
	}
	a.untrustProject(ws)
	if a.projectTrusted(ws) {
		t.Fatal("revoking did not stick")
	}
}
