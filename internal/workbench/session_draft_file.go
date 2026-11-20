//go:build !js && !android && !ios

package workbench

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/nsgo-dev/nsgo/ui"
)

const (
	sessionDraftDir = "session-drafts"
	sessionDraftMax = 256 << 10
)

var sessionDraftWrites sync.WaitGroup

type storedSessionDraft struct {
	ID     string `json:"id"`
	Root   string `json:"root"`
	Target string `json:"target,omitempty"`
	Title  string `json:"title,omitempty"`
	File   string `json:"file,omitempty"`
	Preset string `json:"preset,omitempty"`
	Text   string `json:"text"`
}

func sessionDraftName(id string) string {
	sum := sha256.Sum256([]byte(id))
	return hex.EncodeToString(sum[:]) + ".json"
}

func readSessionDrafts(dataDir string) map[string]storedSessionDraft {
	dir := filepath.Join(dataDir, sessionDraftDir)
	out := make(map[string]storedSessionDraft)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return out
	}
	remaining := 8 << 20
	for _, e := range entries {
		if !e.Type().IsRegular() || len(e.Name()) != 69 || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		f, err := os.Open(filepath.Join(dir, e.Name()))
		if err != nil {
			continue
		}
		raw, err := io.ReadAll(io.LimitReader(f, min(sessionDraftMax*6+8192, int64(remaining))+1))
		_ = f.Close()
		remaining -= len(raw)
		if remaining < 0 {
			break
		}
		var draft storedSessionDraft
		if err == nil && json.Unmarshal(raw, &draft) == nil && len(draft.ID) <= 128 && draft.ID != "" &&
			sessionDraftName(draft.ID) == e.Name() && len(draft.Text) <= sessionDraftMax {
			out[draft.ID] = draft
		}
	}
	return out
}

func (a *app) observeSessionDraft(s *session) {
	if a.st == nil || s.stopDraft != nil {
		return
	}
	if d := a.draftsAtStart[s.ID]; d.Root == s.WS && d.Target == s.Target.key() {
		s.draft.Set(d.Text)
	}
	last := s.draft.GetUntracked()
	var seq uint64
	var persisted uint64
	save := func() {
		if text := s.draft.GetUntracked(); text != last {
			if len(text) > sessionDraftMax {
				n := sessionDraftMax
				for !utf8.RuneStart(text[n]) {
					n--
				}
				text = text[:n]
			}
			last = text
			a.draftSeq++
			seq = a.draftSeq
		}
		if seq == persisted || a.byID[s.ID] != s {
			return
		}
		persisted = seq
		d := storedSessionDraft{ID: s.ID, Root: s.WS, Title: s.title.GetUntracked(), Target: s.Target.key(), Text: last, Preset: s.acpPreset}
		if s.Target.remote() {
			d.File = s.File
		}
		a.persistSessionDraft(d, seq)
	}
	a.cx.Cleanup(save)
	s.stopDraft = a.cx.Effect(func() {
		text := s.draft.Get()
		if text == last {
			return
		}
		if len(text) > sessionDraftMax {
			n := sessionDraftMax
			for !utf8.RuneStart(text[n]) {
				n--
			}
			text = text[:n]
		}
		last = text
		a.draftSeq++
		seq = a.draftSeq
		current := seq
		a.cx.AfterFunc(350*time.Millisecond, func() {
			if seq == current {
				save()
			}
		})
	})
}

func (a *app) persistSessionDraft(d storedSessionDraft, seq uint64) {
	sessionDraftWrites.Add(1)
	go func() {
		defer sessionDraftWrites.Done()
		if err := a.st.saveSessionDraft(d, seq); err != nil {
			a.cx.Post(func() { a.toast(ui.ToastError, "保存失败", err.Error()) })
		}
	}()
}

func (s *store) saveSessionDraft(d storedSessionDraft, seq uint64) error {
	s.draftMu.Lock()
	defer s.draftMu.Unlock()
	if s.draftSeq == nil {
		s.draftSeq = make(map[string]uint64)
	}
	if s.draftSeq[d.ID] >= seq {
		return nil
	}
	dir := filepath.Join(s.dir, sessionDraftDir)
	file := filepath.Join(dir, sessionDraftName(d.ID))
	if d.Text == "" {
		if err := os.Remove(file); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		s.draftSeq[d.ID] = seq
		return nil
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	raw, err := json.Marshal(d)
	if err != nil {
		return err
	}
	if err := writeFileAtomic(file, raw, 0o600); err != nil {
		return err
	}
	s.draftSeq[d.ID] = seq
	return nil
}

func (a *app) restoreDraftSessions() {
	for _, d := range a.draftsAtStart {
		if a.byID[d.ID] != nil || d.Text == "" {
			continue
		}
		t := parseTarget(d.Target)
		ws := a.workspaceFor(t, d.Root)
		if ws == nil {
			continue
		}
		if d.File != "" && (!t.remote() || !validTargetSessionFile(d.File)) {
			continue
		}
		s := a.makeSession(sessionMeta{ID: d.ID, Cwd: ws.Path, Title: d.Title, File: d.File, Updated: a.cx.Now()}, t)
		if d.Preset != "" {
			s.backend, s.acpPreset = "acp", d.Preset
		}
		ws.Sessions.Update(func(list []*session) []*session { return append(list, s) })
	}
}

func (a *app) forgetSessionDraft(s *session) {
	if s.stopDraft != nil {
		s.stopDraft()
		s.stopDraft = nil
	}
	delete(a.draftsAtStart, s.ID)
	if a.st != nil {
		a.draftSeq++
		a.persistSessionDraft(storedSessionDraft{ID: s.ID}, a.draftSeq)
	}
}
