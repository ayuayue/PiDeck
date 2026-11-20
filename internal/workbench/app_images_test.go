//go:build !js && !android && !ios

package workbench

import (
	"bytes"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"example.com/pideck-lite/internal/remotewire"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"github.com/nsgo-dev/nsgo/ui"
)

func newFileDropFixture(t *testing.T) (*app, *session, <-chan func()) {
	t.Helper()
	t.Setenv("PIDECK_LITE_HOME", t.TempDir())
	posts := make(chan func(), 32)
	cx := core.NewRoot(core.RootOptions{
		CheckCommits: true, Clock: core.NewManualClock(time.Unix(1, 0)),
		Post: func(fn func()) { posts <- fn },
	})
	t.Cleanup(cx.Dispose)
	s := &session{ID: "drop-target", WS: t.TempDir(),
		draft: core.NewSignal(cx, ""), images: core.NewSignalFunc(cx, []remotewire.Image(nil), nil), dropPending: core.NewSignal(cx, 0)}
	a := &app{cx: cx, byID: map[string]*session{s.ID: s}, activeID: core.NewSignal(cx, s.ID), toaster: ui.NewToaster(cx)}
	return a, s, posts
}

func applyFileDrop(t *testing.T, posts <-chan func()) {
	t.Helper()
	select {
	case fn := <-posts:
		fn()
	case <-time.After(5 * time.Second):
		t.Fatal("file drop did not post a result within 5 seconds")
	}
}

func writeDropFixture(t *testing.T, dir, name string, data []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func fileDropURI(path, host string) string {
	path = filepath.ToSlash(path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return (&url.URL{Scheme: "file", Host: host, Path: path}).String()
}

func TestDropFilesPublishesOnUIQueue(t *testing.T) {
	a, s, posts := newFileDropFixture(t)
	path := writeDropFixture(t, s.WS, "first.txt", []byte("reference only"))
	a.dropFiles(s, []string{path})
	if got := s.draft.GetUntracked(); got != "" {
		t.Fatalf("drop mutated the draft before the UI result: %q; want empty", got)
	}
	applyFileDrop(t, posts)
	if got := s.draft.GetUntracked(); got != "@first.txt " {
		t.Fatalf("draft = %q; want @first.txt", got)
	}
}

func TestDropFilesDecodesFileURIsOnce(t *testing.T) {
	for _, kind := range []string{"uri", "localhost", "plain", "opaque"} {
		t.Run(kind, func(t *testing.T) {
			a, s, posts := newFileDropFixture(t)
			name := "中文 #%20+ 文件.txt"
			path := writeDropFixture(t, s.WS, name, []byte("reference only"))
			input := path
			switch kind {
			case "uri":
				input = fileDropURI(path, "")
			case "localhost":
				input = fileDropURI(path, "localhost")
			case "opaque":
				input = "file:" + (&url.URL{Path: filepath.ToSlash(path)}).EscapedPath()
			}
			a.dropFiles(s, []string{input})
			applyFileDrop(t, posts)
			if got, want := s.draft.GetUntracked(), "@"+name+" "; got != want || len(a.diagEvents) != 0 {
				t.Fatalf("draft = %q errors=%v; want %q and no errors", got, a.diagEvents, want)
			}
		})
	}
}

func TestDropFilesReferencesDirectoriesAndLargeFiles(t *testing.T) {
	a, s, posts := newFileDropFixture(t)
	dir := filepath.Join(s.WS, "assets.png")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := writeDropFixture(t, s.WS, "large.bin", nil)
	if err := os.Truncate(path, 64<<20); err != nil {
		t.Fatal(err)
	}
	a.dropFiles(s, []string{dir, path})
	applyFileDrop(t, posts)
	if got := s.draft.GetUntracked(); got != "@assets.png @large.bin " || len(s.images.GetUntracked()) != 0 || len(a.diagEvents) != 0 {
		t.Fatalf("draft=%q images=%d errors=%v; want directory and file references only", got, len(s.images.GetUntracked()), a.diagEvents)
	}
}

func TestDropFilesRejectsOversizedImageAndContinues(t *testing.T) {
	a, s, posts := newFileDropFixture(t)
	large := writeDropFixture(t, s.WS, "large.png", nil)
	if err := os.Truncate(large, (6<<20)+1); err != nil {
		t.Fatal(err)
	}
	ref := writeDropFixture(t, s.WS, "valid.txt", []byte("reference"))
	image := writeDropFixture(t, s.WS, "valid.JPG", []byte("image bytes"))
	missing := filepath.Join(s.WS, "missing.txt")
	a.dropFiles(s, []string{large, ref, image, missing})
	applyFileDrop(t, posts)
	images := s.images.GetUntracked()
	if got := s.draft.GetUntracked(); got != "@valid.txt " || len(images) != 1 || images[0].Name != "valid.JPG" || images[0].MimeType != "image/jpeg" || !bytes.Equal(images[0].Data, []byte("image bytes")) {
		t.Fatalf("draft=%q images=%+v; want valid reference and JPEG only", got, images)
	}
	if len(a.diagEvents) != 2 || !strings.Contains(a.diagEvents[0].Text, "6 MB") || !strings.Contains(a.diagEvents[1].Text, "missing.txt") {
		t.Fatalf("errors=%+v; want size and missing-file errors", a.diagEvents)
	}
	for _, event := range a.diagEvents {
		if strings.Contains(event.Text, s.WS) {
			t.Fatalf("error contains the full workspace path: %q", event.Text)
		}
	}
}

func TestDropFilesPreservesInputOrderDraftAndSession(t *testing.T) {
	a, s, posts := newFileDropFixture(t)
	first := writeDropFixture(t, s.WS, "first.png", bytes.Repeat([]byte{1}, 1<<20))
	second := writeDropFixture(t, s.WS, "second.png", []byte{2})
	refA := writeDropFixture(t, s.WS, "first.txt", nil)
	refB := writeDropFixture(t, s.WS, "second.txt", nil)
	inputs := []string{first, refA}
	a.dropFiles(s, inputs)
	// Native events may reuse their slice after the handler returns.
	inputs[0] = filepath.Join(s.WS, "missing.png")
	a.dropFiles(s, []string{second, refB})
	s.draft.Set("typed while loading")
	other := &session{ID: "other", draft: core.NewSignal(a.cx, "other draft"), images: core.NewSignalFunc(a.cx, []remotewire.Image(nil), nil)}
	a.byID[other.ID] = other
	a.activeID.Set(other.ID)
	if got := s.dropPending.GetUntracked(); got != 2 {
		t.Fatalf("pending drops=%d; want 2", got)
	}
	applyFileDrop(t, posts)
	if got := s.dropPending.GetUntracked(); got != 1 {
		t.Fatalf("pending drops after first result=%d; want 1", got)
	}
	applyFileDrop(t, posts)
	if s.filesLoading() {
		t.Fatal("all results applied but file loading is still active")
	}
	var names []string
	for _, image := range s.images.GetUntracked() {
		names = append(names, image.Name)
	}
	if got := s.draft.GetUntracked(); got != "typed while loading @first.txt @second.txt " || !reflect.DeepEqual(names, []string{"first.png", "second.png"}) {
		t.Fatalf("draft=%q images=%v; want current draft followed by both drops in input order", got, names)
	}
	if got := other.draft.GetUntracked(); got != "other draft" || len(other.images.GetUntracked()) != 0 {
		t.Fatalf("switched session changed: draft=%q images=%d; want original draft and no images", got, len(other.images.GetUntracked()))
	}
}

func TestDropFilesIgnoresRemovedOrReplacedSession(t *testing.T) {
	for _, kind := range []string{"removed", "replaced"} {
		t.Run(kind, func(t *testing.T) {
			a, s, posts := newFileDropFixture(t)
			path := writeDropFixture(t, s.WS, "image.png", []byte{1})
			a.dropFiles(s, []string{path})
			switch kind {
			case "removed":
				delete(a.byID, s.ID)
			case "replaced":
				a.byID[s.ID] = &session{ID: s.ID}
			}
			applyFileDrop(t, posts)
			if got := s.images.GetUntracked(); len(got) != 0 {
				t.Fatalf("images=%+v; want no result published to a removed session", got)
			}
		})
	}
}

func TestDropFilesRejectsMalformedURIAndKeepsValidItem(t *testing.T) {
	a, s, posts := newFileDropFixture(t)
	path := writeDropFixture(t, s.WS, "valid.txt", nil)
	a.dropFiles(s, []string{"file:///bad%ZZ", fileDropURI(path, "") + "#unexpected", "https://example.invalid/image.png?query=do-not-log", path})
	applyFileDrop(t, posts)
	if got := s.draft.GetUntracked(); got != "@valid.txt " || len(a.diagEvents) != 3 {
		t.Fatalf("draft=%q errors=%v; want one valid reference and three URI errors", got, a.diagEvents)
	}
	for _, event := range a.diagEvents {
		if strings.Contains(event.Text, "do-not-log") {
			t.Fatalf("invalid URI leaked credentials into error text: %q", event.Text)
		}
	}
}

func TestDroppedImageSizeBoundary(t *testing.T) {
	for _, size := range []int64{0, 6 << 20} {
		path := writeDropFixture(t, t.TempDir(), "image.png", nil)
		if err := os.Truncate(path, size); err != nil {
			t.Fatal(err)
		}
		file := readDroppedFile(path)
		if size == 0 {
			if file.err == nil || len(file.image.Data) != 0 {
				t.Fatalf("empty image: error=%v bytes=%d; want rejection without bytes", file.err, len(file.image.Data))
			}
		} else if file.err != nil || int64(len(file.image.Data)) != size {
			t.Fatalf("image at limit: error=%v bytes=%d; want %d bytes without error", file.err, len(file.image.Data), size)
		}
	}
}

func TestDropFilesWithoutSessionDoesNothing(t *testing.T) {
	a, s, posts := newFileDropFixture(t)
	path := writeDropFixture(t, s.WS, "valid.txt", nil)
	a.dropFiles(nil, []string{path})
	select {
	case <-posts:
		t.Fatal("nil session scheduled a result; want no operation")
	default:
	}
}

func TestDropFilesKeepsSendBlockedUntilFilesAreReady(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	a, screen, s := newAskApp(t)
	gate := make(chan struct{})
	defer func() {
		select {
		case <-gate:
		default:
			close(gate)
		}
	}()
	// Model another queued drop so the real reader cannot finish before the
	// disabled send control is inspected. No disk operation is mocked.
	s.dropTail = gate
	path := writeDropFixture(t, s.WS, "image.png", []byte{1})
	s.draft.Set("keep until files are ready")
	a.dropFiles(s, []string{path})
	screen.WaitFor("label:正在读取", 5*time.Second)
	a.send()
	a.sendDraft(s, deliveryParallel)
	if got := s.draft.GetUntracked(); got != "keep until files are ready" || len(s.turns.GetUntracked()) != 0 {
		t.Fatalf("pending send changed draft=%q turns=%d; want retained draft and no turns", got, len(s.turns.GetUntracked()))
	}
	close(gate)
	screen.WaitUntil(5*time.Second, func() bool { return !s.filesLoading() })
	screen.WaitForGone("label:正在读取", 5*time.Second)
	if got := s.images.GetUntracked(); len(got) != 1 || got[0].Name != "image.png" {
		t.Fatalf("images=%+v; want the ready attachment", got)
	}
}
