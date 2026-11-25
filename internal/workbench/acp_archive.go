//go:build !js && !android && !ios

package workbench

// ACP session archives: the transcript the app drew is kept under
// acp-sessions, so an ACP session can be read again after a restart even
// when the CLI's own store is gone. The CLI's session/load is tried first
// when it comes back.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// acpArchiveTurns and acpArchiveBytes bound one archive.
const (
	acpArchiveTurns = 2000
	acpArchiveBytes = 8 << 20
)

// acpArchive is one ACP session on disk.
type acpArchive struct {
	ID           string            `json:"id"`
	Preset       string            `json:"preset"`
	ACPSessionID string            `json:"acpSessionId"`
	Title        string            `json:"title"`
	Cwd          string            `json:"cwd"`
	Updated      time.Time         `json:"updated"`
	Turns        []turn            `json:"turns"`
	Permissions  map[string]string `json:"permissions,omitempty"`
}

// acpArchiveDir is where ACP transcripts live.
func (a *app) acpArchiveDir() string {
	if a.st == nil {
		return ""
	}
	return filepath.Join(a.st.dir, "acp-sessions")
}

// saveACPArchive writes a session's transcript, bounded and atomically.
func (a *app) saveACPArchive(s *session) {
	if s == nil || s.backend != "acp" || a.st == nil {
		return
	}
	dir := a.acpArchiveDir()
	if dir == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return
	}
	s.acpPermMu.Lock()
	perms := make(map[string]string, len(s.acpPerm))
	for k, v := range s.acpPerm {
		perms[k] = v
	}
	s.acpPermMu.Unlock()
	arch := acpArchive{ID: s.ID, Preset: s.acpPreset, ACPSessionID: s.acpSID,
		Title: s.title.GetUntracked(), Cwd: s.WS, Updated: s.updated.GetUntracked(),
		Turns: append([]turn(nil), s.turns.GetUntracked()...), Permissions: perms}
	data, err := marshalACPArchive(arch)
	if err != nil {
		return
	}
	_ = writeFileAtomic(filepath.Join(dir, archiveName(s.ID)), data, 0o644)
}

// marshalACPArchive bounds the transcript and encodes it.
func marshalACPArchive(arch acpArchive) ([]byte, error) {
	if len(arch.Turns) > acpArchiveTurns {
		arch.Turns = arch.Turns[len(arch.Turns)-acpArchiveTurns:]
	}
	data, err := json.Marshal(arch)
	if err != nil {
		return nil, err
	}
	for len(data) > acpArchiveBytes && len(arch.Turns) > 1 {
		arch.Turns = arch.Turns[1:]
		data, err = json.Marshal(arch)
		if err != nil {
			return nil, err
		}
	}
	if len(data) > acpArchiveBytes {
		trimACPTurnText(&arch)
		return json.Marshal(arch)
	}
	return data, nil
}

// trimACPTurnText cuts long step text and tool output in place.
func trimACPTurnText(arch *acpArchive) {
	const limit = 64 << 10
	for i := range arch.Turns {
		for j := range arch.Turns[i].Steps {
			step := &arch.Turns[i].Steps[j]
			if len(step.Text) > limit {
				step.Text = step.Text[:limit] + "\n… 已截断"
			}
			if len(step.Thinking) > limit {
				step.Thinking = step.Thinking[:limit] + "\n… 已截断"
			}
			for k := range step.Tools {
				if len(step.Tools[k].Output) > limit {
					step.Tools[k].Output = step.Tools[k].Output[:limit] + "\n… 已截断"
				}
			}
		}
	}
}

// archiveName is a session id as a safe file name.
func archiveName(id string) string {
	return strings.NewReplacer("/", "-", "\\", "-", ":", "-").Replace(id) + ".json"
}

// loadACPArchives puts archived ACP sessions back in their projects.
func (a *app) loadACPArchives() {
	dir := a.acpArchiveDir()
	if dir == "" {
		return
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".json") {
			continue
		}
		// An archived ACP session proves this install runs agents here, so
		// a spare handshake is worth paying even without pi sessions.
		a.warmOK = true
		a.loadACPArchiveFile(filepath.Join(dir, e.Name()))
	}
}

// loadACPArchiveFile restores one archive, when its project is known.
func (a *app) loadACPArchiveFile(path string) *session {
	if path == "" || !strings.HasSuffix(strings.ToLower(path), ".json") {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var arch acpArchive
	if json.Unmarshal(raw, &arch) != nil || arch.ID == "" || arch.Cwd == "" {
		return nil
	}
	if s := a.byID[arch.ID]; s != nil {
		return s
	}
	ws := a.workspaceOf(arch.Cwd)
	if ws == nil {
		return nil
	}
	s := a.blankSession(arch.ID, ws, arch.Title)
	s.backend = "acp"
	s.acpPreset = arch.Preset
	s.acpSID = arch.ACPSessionID
	if arch.Updated.IsZero() {
		arch.Updated = a.cx.Now()
	}
	s.updated.Set(arch.Updated)
	s.turns.Set(arch.Turns)
	s.acpPerm = arch.Permissions
	s.personaID = a.cfg.SessionPersonas[s.ID]
	s.loaded.Set(true)
	ws.Sessions.Update(func(ss []*session) []*session { return append([]*session{s}, ss...) })
	return s
}
