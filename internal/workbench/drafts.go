//go:build !js && !android && !ios

package workbench

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"

	"example.com/pideck-lite/internal/apptext"
	"example.com/pideck-lite/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
)

const (
	draftsFile      = "drafts.json"
	draftCountLimit = 128
	draftBodyLimit  = 32 << 10
	draftFileLimit  = 8 << 20
)

type savedDraft struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Text    string `json:"text"`
	Project string `json:"project,omitempty"`
	Quick   bool   `json:"quick,omitempty"`
}

func (d savedDraft) valid() bool {
	return d.ID != "" && len(d.ID) <= 80 && strings.TrimSpace(d.Title) != "" && utf8.RuneCountInString(d.Title) <= 100 &&
		strings.TrimSpace(d.Text) != "" && len(d.Text) <= draftBodyLimit && len(d.Project) <= 4096
}

func readDraftLibrary(dir string) []savedDraft {
	f, err := os.Open(filepath.Join(dir, draftsFile))
	if err != nil {
		return nil
	}
	defer f.Close()
	var file struct {
		Version int          `json:"version"`
		Drafts  []savedDraft `json:"drafts"`
	}
	raw, err := io.ReadAll(io.LimitReader(f, draftFileLimit+1))
	if err != nil || len(raw) > draftFileLimit || json.Unmarshal(raw, &file) != nil || file.Version != 1 {
		return nil
	}
	seen := make(map[string]bool)
	list := slices.DeleteFunc(file.Drafts, func(d savedDraft) bool {
		if !d.valid() || seen[d.ID] {
			return true
		}
		seen[d.ID] = true
		return false
	})
	return list[:min(draftCountLimit, len(list))]
}

type draftLibrary struct {
	open  *core.Signal[bool]
	items *core.Signal[[]savedDraft]
	edit  *core.Signal[savedDraft]
	query *core.Signal[string]
	busy  *core.Signal[bool]
}

func newDraftLibrary(cx *core.Scope) draftLibrary {
	return draftLibrary{open: core.NewSignal(cx, false), items: core.NewSignalFunc(cx, []savedDraft(nil), nil),
		edit: core.NewSignal(cx, savedDraft{}), query: core.NewSignal(cx, ""), busy: core.NewSignal(cx, false)}
}

func (a *app) draftProject() string {
	if ws := a.activeWorkspace(); ws != nil {
		return ws.Target.key() + "|" + ws.Path
	}
	return ""
}

func (a *app) openDrafts(fromComposer bool) {
	a.openPane(paneDrafts)
	if !fromComposer || a.drafts.busy.GetUntracked() {
		return
	}
	s := a.active()
	if s == nil {
		return
	}
	text := s.draft.GetUntracked()
	a.drafts.edit.Set(savedDraft{ID: newSessionID(), Text: text, Title: viewkit.FirstLine(text, 48), Project: a.draftProject()})
}

func (a *app) persistDraftLibrary(items []savedDraft, after func()) {
	if a.st == nil || a.drafts.busy.GetUntracked() {
		return
	}
	if len(items) > draftCountLimit {
		a.toast(ui.ToastWarning, "草稿本已满", "")
		return
	}
	a.drafts.busy.Set(true)
	go func() {
		data, err := json.MarshalIndent(struct {
			Version int          `json:"version"`
			Drafts  []savedDraft `json:"drafts"`
		}{Version: 1, Drafts: items}, "", "  ")
		// Use the reader's encoded-byte limit so successful saves can reopen.
		if err == nil && len(data) > draftFileLimit {
			err = errors.New(apptext.T("草稿本已满"))
		}
		if err == nil {
			err = writeFileAtomic(filepath.Join(a.st.dir, draftsFile), data, 0o600)
		}
		a.cx.Post(func() {
			a.drafts.busy.Set(false)
			if err != nil {
				a.toast(ui.ToastError, "保存失败", err.Error())
				return
			}
			a.drafts.items.Set(items)
			if after != nil {
				after()
			}
		})
	}()
}

func (a *app) saveDraftEntry() {
	d := a.drafts.edit.GetUntracked()
	d.Title = strings.TrimSpace(d.Title)
	if !d.valid() {
		return
	}
	items := slices.Clone(a.drafts.items.GetUntracked())
	items = slices.DeleteFunc(items, func(entry savedDraft) bool { return entry.ID == d.ID })
	a.persistDraftLibrary(append([]savedDraft{d}, items...), func() { a.drafts.edit.Set(savedDraft{}) })
}

func (a *app) insertDraftEntry(d savedDraft) {
	s := a.active()
	if s == nil {
		a.copyText(d.Text, "草稿")
		return
	}
	a.cx.Batch(func() {
		a.activePane.Set("")
		text := s.draft.GetUntracked()
		if strings.TrimSpace(text) == "" {
			s.draft.Set(d.Text)
		} else {
			s.draft.Set(text + "\n\n" + d.Text)
		}
	})
}
