//go:build !js && !android && !ios

package workbench

// Checks the long-paste file: where it lands, that only the app's own files
// are touched, that the field edit a paste made is undone, and that the text
// folds back into the message it belongs to.

import (
	"bytes"
	"errors"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"example.com/pideck/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"golang.org/x/image/bmp"
)

// pasteFixture is an app whose clock and posts are the test's, with one
// session in front.
func pasteFixture(t *testing.T) (*app, *session, <-chan func()) {
	t.Helper()
	t.Setenv("PIDECK_V2_HOME", t.TempDir())
	posts := make(chan func(), 8)
	cx := core.NewRoot(core.RootOptions{
		CheckCommits: true, Clock: core.NewManualClock(time.Unix(1, 0)),
		Post: func(fn func()) { posts <- fn },
	})
	t.Cleanup(cx.Dispose)
	s := &session{ID: "paste-target", draft: core.NewSignal(cx, ""),
		composing: core.NewSignal(cx, ""), images: core.NewSignalFunc(cx, []remotewire.Image(nil), nil),
		pasteFiles: core.NewSignalFunc(cx, []pastedText(nil), nil), dropPending: core.NewSignal(cx, 0)}
	a := &app{cx: cx, byID: map[string]*session{s.ID: s}, activeID: core.NewSignal(cx, s.ID)}
	return a, s, posts
}

// TestPastedTextFileLifecycle writes a paste, reads it back and deletes it.
func TestPastedTextFileLifecycle(t *testing.T) {
	dataDir := t.TempDir()
	text := strings.Repeat("这一行是粘贴进来的长日志。\n", 300)
	file, err := writePastedText(dataDir, text)
	if err != nil {
		t.Fatalf("writePastedText: %v", err)
	}
	if !strings.HasPrefix(file.Name, "paste-") || !strings.HasSuffix(file.Name, ".md") {
		t.Fatalf("paste file name = %q, want paste-….md", file.Name)
	}
	if file.Bytes != len(text) || file.Text != text {
		t.Fatalf("paste record = %d bytes, want %d", file.Bytes, len(text))
	}
	if filepath.Dir(file.Path) != filepath.Join(dataDir, pasteTextDir) {
		t.Fatalf("paste path = %q, want it under %q", file.Path, pasteTextDir)
	}
	raw, err := os.ReadFile(file.Path)
	if err != nil || string(raw) != text {
		t.Fatalf("paste file holds %d bytes, %v", len(raw), err)
	}
	if err := removePastedText(dataDir, file.Path); err != nil {
		t.Fatalf("removePastedText: %v", err)
	}
	if _, err := os.Stat(file.Path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the paste file is still there")
	}
}

// TestRemovePastedTextStaysInDir refuses a path outside the paste folder.
func TestRemovePastedTextStaysInDir(t *testing.T) {
	dataDir := t.TempDir()
	outside := filepath.Join(dataDir, "config.json")
	if err := removePastedText(dataDir, outside); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("removePastedText of %q = %v, want a refusal", outside, err)
	}
	if err := removePastedText(dataDir, filepath.Join(dataDir, pasteTextDir, "..", "escape.md")); !errors.Is(err, os.ErrPermission) {
		t.Fatalf("removePastedText through .. = %v, want a refusal", err)
	}
}

// TestCleanupPastedTextDropsOnlyOldFiles sweeps past the retention only.
func TestCleanupPastedTextDropsOnlyOldFiles(t *testing.T) {
	dataDir := t.TempDir()
	dir := filepath.Join(dataDir, pasteTextDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	old := filepath.Join(dir, "paste-20200101-000000-aaaa.md")
	fresh := filepath.Join(dir, "paste-20260101-000000-bbbb.md")
	other := filepath.Join(dir, "notes.md")
	for _, path := range []string{old, fresh, other} {
		if err := os.WriteFile(path, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	stamp := time.Now().Add(-pasteTextRetention - time.Hour)
	if err := os.Chtimes(old, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(other, stamp, stamp); err != nil {
		t.Fatal(err)
	}
	if removed := cleanupPastedText(dataDir); removed != 1 {
		t.Fatalf("cleanup removed %d files, want 1", removed)
	}
	for _, path := range []string{fresh, other} {
		if _, err := os.Stat(path); err != nil {
			t.Fatalf("%s went away: %v", filepath.Base(path), err)
		}
	}
}

// TestStripPastedText undoes the paste edit wherever the caret was.
func TestStripPastedText(t *testing.T) {
	const chunk = "粘贴进来的一大段文字"
	cases := []struct {
		prev, next string
		want, ok   bool
	}{
		{"", chunk, true, true},
		{"前面", "前面" + chunk, true, true},
		{"后面", chunk + "后面", true, true},
		{"开头\n结尾", "开头\n" + chunk + "结尾", true, true},
		{"", "用户又敲了字", false, false},
		{"", chunk + "和别的内容", false, false},
	}
	for _, c := range cases {
		got, ok := stripPastedText(c.prev, c.next, chunk)
		if ok != c.ok || (c.ok && got != c.prev) {
			t.Errorf("stripPastedText(%q, %q) = %q, %v; want %v, %v", c.prev, c.next, got, ok, c.prev, c.ok)
		}
	}
}

// TestFoldPastedText puts the typed words first and spends the chips.
func TestFoldPastedText(t *testing.T) {
	_, s, _ := pasteFixture(t)
	s.draft.Set("看看这份日志")
	s.pasteFiles.Set([]pastedText{{Name: "a.md", Text: "第一段长文本"}, {Name: "b.md", Text: "第二段长文本"}})
	got := (&app{}).foldPastedText(s, s.draft.GetUntracked())
	want := "看看这份日志\n\n第一段长文本\n\n第二段长文本"
	if got != want {
		t.Fatalf("folded text = %q, want %q", got, want)
	}
	if len(s.pasteFiles.GetUntracked()) != 0 {
		t.Fatal("the chips were not spent")
	}
	// A paste alone is the whole message.
	s.pasteFiles.Set([]pastedText{{Name: "c.md", Text: "只有这段"}})
	if got := (&app{}).foldPastedText(s, ""); got != "只有这段" {
		t.Fatalf("folded text = %q, want the paste alone", got)
	}
}

// TestPastedTextComposingTakesSentencesOnly keeps pinyin out of Send.
func TestPastedTextComposingTakesSentencesOnly(t *testing.T) {
	_, s, _ := pasteFixture(t)
	s.composing.Set("nihao")
	if got := pastedTextComposing(s); got != "" {
		t.Fatalf("pastedTextComposing of pinyin = %q, want nothing", got)
	}
	s.composing.Set("这是语音输入法留在输入框里的一整句话，还没有上屏。")
	if got := pastedTextComposing(s); got == "" {
		t.Fatal("a dictated sentence was not taken as the draft")
	}
}

// TestPastedImageReadsItsBytes checks the type a paste carries, and what is
// refused.
func TestPastedImageReadsItsBytes(t *testing.T) {
	pngBytes := smallPNG(t)
	if img, err := pastedImage(core.PastedFile{MIME: "application/octet-stream", Data: pngBytes}); err != nil || img.MimeType != "image/png" {
		t.Fatalf("a PNG under another MIME = %+v, %v", img, err)
	}
	if img, err := pastedImage(core.PastedFile{Data: pngBytes, Name: "clip.png"}); err != nil || img.MimeType != "image/png" || img.Name != "clip.png" {
		t.Fatalf("a PNG with no MIME = %+v, %v", img, err)
	}
	if _, err := pastedImage(core.PastedFile{MIME: "text/plain", Data: []byte("not a picture")}); !errors.Is(err, errPastedNotImage) {
		t.Fatalf("plain text = %v, want errPastedNotImage", err)
	}
	if _, err := pastedImage(core.PastedFile{MIME: "image/png", Data: make([]byte, pastedImageMaxBytes+1)}); !errors.Is(err, errPastedImageSize) {
		t.Fatalf("an oversized picture = %v, want errPastedImageSize", err)
	}
}

// TestPNGFromBMP redraws a clipboard bitmap, the one format the composer
// cannot show as it arrives.
func TestPNGFromBMP(t *testing.T) {
	var raw bytes.Buffer
	img := image.NewRGBA(image.Rect(0, 0, 4, 3))
	for y := range 3 {
		for x := range 4 {
			img.Set(x, y, color.RGBA{R: 200, G: 40, B: 20, A: 255})
		}
	}
	if err := bmp.Encode(&raw, img); err != nil {
		t.Fatal(err)
	}
	out, err := pngFromBMP(raw.Bytes())
	if err != nil {
		t.Fatalf("pngFromBMP: %v", err)
	}
	if !bytes.HasPrefix(out, []byte("\x89PNG\r\n\x1a\n")) {
		t.Fatal("pngFromBMP did not produce a PNG")
	}
	decoded, err := png.Decode(bytes.NewReader(out))
	if err != nil {
		t.Fatalf("decode the converted PNG: %v", err)
	}
	if decoded.Bounds() != img.Bounds() {
		t.Fatalf("converted bounds = %v, want %v", decoded.Bounds(), img.Bounds())
	}
}

// smallPNG is the least PNG a test can hand to pastedImage.
func smallPNG(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// TestPastedTextNameIsOrdered keeps the readable stamp the cleanup relies on.
func TestPastedTextNameIsOrdered(t *testing.T) {
	name := pastedTextName(time.Date(2026, 11, 25, 19, 3, 4, 0, time.UTC))
	if !strings.HasPrefix(name, "paste-20261125-190304-") || len(name) != len("paste-20261125-190304-abcd.md") {
		t.Fatalf("paste name = %q", name)
	}
}
