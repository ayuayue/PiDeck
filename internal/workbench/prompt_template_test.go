//go:build !js && !android && !ios

package workbench

import (
	"archive/zip"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPromptTemplateBoundedFallbackAndSave(t *testing.T) {
	dir := t.TempDir()
	if text, err := readPromptTemplate(dir); err != nil || text != toolSystem("prompt") {
		t.Fatalf("absent template = %q, %v", text, err)
	}
	for _, invalid := range []string{"", " \n", "bad\x00text", string([]byte{0xff}), strings.Repeat("x", promptTemplateMax+1)} {
		if err := os.WriteFile(filepath.Join(dir, promptTemplateFile), []byte(invalid), 0o600); err != nil {
			t.Fatal(err)
		}
		if text, err := readPromptTemplate(dir); err == nil || text != toolSystem("prompt") {
			t.Fatalf("invalid template did not fall back: length %d, err %v", len(invalid), err)
		}
		if err := savePromptTemplate(dir, invalid); err == nil {
			t.Fatalf("saved invalid template of %d bytes", len(invalid))
		}
	}
	const instruction = "Keep the source language and list acceptance criteria."
	if err := savePromptTemplate(dir, instruction); err != nil {
		t.Fatal(err)
	}
	if text, err := readPromptTemplate(dir); err != nil || text != instruction {
		t.Fatalf("saved template = %q, %v", text, err)
	}
	if err := savePromptTemplate(filepath.Join(dir, "missing"), instruction); err == nil {
		t.Fatal("save in missing directory falsely succeeded")
	}
	if temps, _ := filepath.Glob(filepath.Join(dir, ".*tmp*")); len(temps) != 0 {
		t.Fatalf("atomic write leaked files: %v", temps)
	}
}

func TestPromptTemplateSharedByDesktopAndRemote(t *testing.T) {
	screen, a, s := draftToolFixture(t)
	const instruction = "Use short paragraphs and preserve every constraint."
	if err := savePromptTemplate(a.st.dir, instruction); err != nil {
		t.Fatal(err)
	}
	seen := make(chan [2]string, 2)
	a.llmFn = func(tool, system, prompt string, max int) (string, error) {
		seen <- [2]string{system, prompt}
		return "rewritten", nil
	}
	s.draft.Set("  original text\n")
	a.enhanceDraft(s)
	screen.WaitUntil(5*time.Second, func() bool { return a.aiBusy.GetUntracked() == "" })
	if got := <-seen; got != [2]string{instruction, "  original text\n"} {
		t.Fatalf("desktop system/user messages = %#v", got)
	}
	recorder := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/tools", strings.NewReader(`{"tool":"prompt","text":"phone text"}`))
	done := make(chan struct{})
	go func() { (&remoteHost{app: a}).sessionTool(recorder, req, s.ID); close(done) }()
	screen.WaitUntil(5*time.Second, func() bool {
		select {
		case <-done:
			return true
		default:
			return false
		}
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("remote template call: %d %s", recorder.Code, recorder.Body.String())
	}
	if got := <-seen; got != [2]string{instruction, "phone text"} {
		t.Fatalf("phone system/user messages = %#v", got)
	}
}

func TestPromptTemplateEditorSaveCancelAndFailure(t *testing.T) {
	screen, a, _ := draftToolFixture(t)
	a.openPromptTemplate()
	screen.WaitUntil(5*time.Second, func() bool { return !a.promptTemplate.GetUntracked().busy.GetUntracked() })
	screen.Clear("id:prompt-template-text")
	screen.Type("id:prompt-template-text", "A custom enhancement instruction.")
	screen.Press("id:prompt-template-save")
	screen.WaitUntil(5*time.Second, func() bool { return a.promptTemplate.GetUntracked() == nil })
	if text, err := readPromptTemplate(a.st.dir); err != nil || text != "A custom enhancement instruction." {
		t.Fatalf("editor save = %q, %v", text, err)
	}
	a.openPromptTemplate()
	screen.WaitUntil(5*time.Second, func() bool { return !a.promptTemplate.GetUntracked().busy.GetUntracked() })
	screen.Press("id:prompt-template-default")
	screen.Press("id:prompt-template-cancel")
	if text, _ := readPromptTemplate(a.st.dir); text != "A custom enhancement instruction." {
		t.Fatal("cancel wrote the default to disk")
	}
	a.openPromptTemplate()
	screen.WaitUntil(5*time.Second, func() bool { return !a.promptTemplate.GetUntracked().busy.GetUntracked() })
	form := a.promptTemplate.GetUntracked()
	if err := os.Remove(filepath.Join(a.st.dir, promptTemplateFile)); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(a.st.dir, promptTemplateFile), 0o700); err != nil {
		t.Fatal(err)
	}
	a.savePromptTemplate(form)
	screen.WaitUntil(5*time.Second, func() bool { return !form.busy.GetUntracked() })
	if a.promptTemplate.GetUntracked() != form || form.message.GetUntracked() == "" {
		t.Fatal("failed save closed the editor or lost the error")
	}
}

func TestPromptTemplateSettingsBackupRoundTrip(t *testing.T) {
	st, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	const text = "Preserve meaning and simplify the request."
	if err := savePromptTemplate(st.dir, text); err != nil {
		t.Fatal(err)
	}
	a := &app{st: st}
	raw, err := a.settingsZip()
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := zr.Open(promptTemplateFile); err != nil {
		t.Fatalf("settings backup omitted template: %v", err)
	}
	other, err := newStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := (&app{st: other}).applySettingsArchive(zr); err != nil {
		t.Fatal(err)
	}
	if got, err := readPromptTemplate(other.dir); err != nil || got != text {
		t.Fatalf("restored template = %q, %v", got, err)
	}
}
