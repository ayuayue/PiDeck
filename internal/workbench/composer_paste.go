//go:build !js && !android && !ios

package workbench

// Long pastes never fill the input: a text the user pastes over a screenful is
// written to the app's data directory, shown as one chip above the field, and
// folded back into the message when it is sent. PiDeck's Electron build does
// the same; the threshold, the 2 MiB folded back and the 7-day sweep match it.
// The field keeps short pastes, and an image the platform hands over is
// normalized here too, because a Windows bitmap cannot be drawn or sent.

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"example.com/pideck-v2/internal/apptext"
	"example.com/pideck-v2/internal/remotewire"
	"example.com/pideck-v2/internal/viewkit"
	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/ui"
	"golang.org/x/image/bmp"
)

const (
	// pasteTextDir is the folder of long pastes, under the app's data
	// directory, so no project ever sees it in its git status.
	pasteTextDir = "paste-files"
	// pasteTextMinRunes is the length a paste turns into a file: a screenful
	// of text nobody wants to scroll through in the field.
	pasteTextMinRunes = 5000
	// pasteTextInlineMax bounds what is folded back into a prompt. The file
	// stays a record either way.
	pasteTextInlineMax = 2 << 20
	// pasteTextWriteMax refuses a pathological clipboard outright; the text
	// stays in the field then, which is honest about what happened.
	pasteTextWriteMax = 25 << 20
	// pasteTextRetention is how long a paste file outlives its message: the
	// conversation itself is the record by then.
	pasteTextRetention = 7 * 24 * time.Hour
	// pastedImageMaxBytes is a picture paste's limit, the same as a dropped
	// one.
	pastedImageMaxBytes = 6 << 20
)

var (
	errPasteTooLarge   = errors.New("pasted text is too large")
	errPastedNotImage  = errors.New("pasted file is not an image")
	errPastedImageSize = errors.New("pasted image is too large")
)

// pastedText is one long paste: the file it lives in, and its text while the
// composer holds it.
type pastedText struct {
	Name  string
	Path  string
	Bytes int
	Text  string
}

// pastedTextName is a paste file's name: readable time, random tail so two
// pastes in one second never collide.
func pastedTextName(now time.Time) string {
	var tail [2]byte
	_, _ = rand.Read(tail[:])
	return fmt.Sprintf("paste-%s-%s.md", now.Format("20060102-150405"), hex.EncodeToString(tail[:]))
}

// writePastedText writes one paste under dataDir and returns its record.
// Files are written whole and renamed into place, as every file the app
// keeps is.
func writePastedText(dataDir, text string) (pastedText, error) {
	if len(text) > pasteTextWriteMax {
		return pastedText{}, errPasteTooLarge
	}
	dir := filepath.Join(dataDir, pasteTextDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return pastedText{}, err
	}
	name := pastedTextName(time.Now())
	path := filepath.Join(dir, name)
	if err := writeFileAtomic(path, []byte(text), 0o600); err != nil {
		return pastedText{}, err
	}
	return pastedText{Name: name, Path: path, Bytes: len(text), Text: text}, nil
}

// removePastedText deletes a paste file the user took back out, and only one
// the app wrote.
func removePastedText(dataDir, path string) error {
	root := filepath.Join(dataDir, pasteTextDir)
	rel, err := filepath.Rel(root, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return os.ErrPermission
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// cleanupPastedText deletes paste files older than the retention, so the
// folder cannot grow without bound. It reports how many went.
func cleanupPastedText(dataDir string) int {
	dir := filepath.Join(dataDir, pasteTextDir)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 0
	}
	removed := 0
	for _, e := range entries {
		if !e.Type().IsRegular() || !strings.HasPrefix(e.Name(), "paste-") || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		info, err := e.Info()
		if err != nil || time.Since(info.ModTime()) <= pasteTextRetention {
			continue
		}
		if err := os.Remove(filepath.Join(dir, e.Name())); err == nil {
			removed++
		}
	}
	return removed
}

// pastedFiles is s's long pastes, empty for a session built without the
// signals.
func pastedFiles(s *session) []pastedText {
	if s == nil || s.pasteFiles == nil {
		return nil
	}
	return s.pasteFiles.Get()
}

// setPastedFiles replaces s's long pastes.
func setPastedFiles(s *session, list []pastedText) {
	if s == nil || s.pasteFiles == nil {
		return
	}
	s.pasteFiles.Set(list)
}

// foldPastedText is the message just before it is sent: the typed words
// first, then each paste as it was written, as PiDeck's Electron composer
// folds them. The chips are spent by this.
func (a *app) foldPastedText(s *session, text string) string {
	files := pastedFiles(s)
	if len(files) == 0 {
		return text
	}
	parts := []string{strings.TrimSpace(text)}
	for _, f := range files {
		content := f.Text
		if len(content) > pasteTextInlineMax {
			content = content[:pasteTextInlineMax]
		}
		if strings.TrimSpace(content) != "" {
			parts = append(parts, content)
		}
	}
	setPastedFiles(s, nil)
	return strings.TrimSpace(strings.Join(parts, "\n\n"))
}

// stashPastedText writes a long paste and shows it as a chip, undoing the
// edit that put it in the field. The field is on the UI thread and the write
// is not, so the result comes back through cx.Post.
func (a *app) stashPastedText(s *session, text string) {
	if a.st == nil || len(text) > pasteTextWriteMax {
		return
	}
	// The platform puts the text in the field right after this event; the
	// change handler finds this chunk and undoes that edit.
	s.pendingPaste = text
	dir := a.st.dir
	go func() {
		file, err := writePastedText(dir, text)
		a.cx.Post(func() {
			if a.sessionOf(s.ID) != s {
				return
			}
			if err != nil {
				// Nothing is lost: the text goes back in the field.
				draft := s.draft.GetUntracked()
				if draft != "" && !strings.HasSuffix(draft, "\n") {
					draft += "\n"
				}
				s.draft.Set(draft + text)
				a.toast(ui.ToastError, apptext.T("长文本存文件失败"), viewkit.FirstLine(err.Error(), 160))
				return
			}
			s.pasteFiles.Update(func(list []pastedText) []pastedText {
				return append(append([]pastedText(nil), list...), file)
			})
			a.toast(ui.ToastInfo, apptext.T("长文本已存成文件"), apptext.T("已存为 %s，发送这条消息时会一起发出。", file.Name))
		})
	}()
}

// dropPastedText takes one chip back out, with its file.
func (a *app) dropPastedText(s *session, index int) {
	if s == nil {
		return
	}
	var gone *pastedText
	s.pasteFiles.Update(func(list []pastedText) []pastedText {
		if index < 0 || index >= len(list) {
			return list
		}
		file := list[index]
		gone = &file
		out := make([]pastedText, 0, len(list)-1)
		return append(append(out, list[:index]...), list[index+1:]...)
	})
	if gone == nil || a.st == nil {
		return
	}
	dir := a.st.dir
	go func() { _ = removePastedText(dir, gone.Path) }()
}

// stripPastedText undoes the edit a long paste made: it finds the pasted chunk
// in next and returns what the field held before it. Anything else means the
// platform inserted something besides the paste, which is left alone.
func stripPastedText(prev, next, chunk string) (string, bool) {
	if chunk == "" {
		return next, false
	}
	if i := strings.Index(next, chunk); i >= 0 && next[:i]+next[i+len(chunk):] == prev {
		return prev, true
	}
	return next, false
}

// pastedImage turns one pasted file into an attachment: its type is read from
// its bytes when the platform's name is missing or wrong, and a format the app
// cannot draw is refused instead of attached as a blank tile.
func pastedImage(file core.PastedFile) (remotewire.Image, error) {
	if len(file.Data) == 0 {
		return remotewire.Image{}, errPastedNotImage
	}
	if len(file.Data) > pastedImageMaxBytes {
		return remotewire.Image{}, errPastedImageSize
	}
	mime := strings.ToLower(strings.TrimSpace(file.MIME))
	if !strings.HasPrefix(mime, "image/") {
		mime = http.DetectContentType(file.Data)
	}
	switch mime {
	case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp":
	default:
		return remotewire.Image{}, errPastedNotImage
	}
	name := strings.TrimSpace(file.Name)
	if name == "" {
		name = apptext.T("粘贴的图片")
	}
	return remotewire.Image{Data: file.Data, MimeType: mime, Name: name}, nil
}

// pngFromBMP redraws a Windows bitmap as a PNG, which both the preview and a
// model accept. It runs off the UI thread because a screenshot-sized bitmap
// takes a moment to decode.
func pngFromBMP(data []byte) ([]byte, error) {
	img, err := bmp.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	var out bytes.Buffer
	if err := png.Encode(&out, img); err != nil {
		return nil, err
	}
	return out.Bytes(), nil
}

// addPastedImage attaches a pasted picture, converting a bitmap first and
// reporting what cannot attach.
func (a *app) addPastedImage(s *session, img remotewire.Image) {
	if img.MimeType != "image/bmp" {
		a.addImage(s, img)
		return
	}
	go func() {
		pngData, err := pngFromBMP(img.Data)
		a.cx.Post(func() {
			if a.sessionOf(s.ID) != s {
				return
			}
			if err != nil {
				a.toast(ui.ToastError, apptext.T("这张图片的格式看不了"), viewkit.FirstLine(err.Error(), 160))
				return
			}
			name := strings.TrimSuffix(img.Name, filepath.Ext(img.Name)) + ".png"
			a.addImage(s, remotewire.Image{Data: pngData, MimeType: "image/png", Name: name})
		})
	}()
}

// pasteInto is what the composer does with a paste: pictures attach, paths are
// read as dropped files, and a text too long for the field becomes a file of
// its own.
func (a *app) pasteInto(s *session, e core.PasteEvent) {
	if s == nil {
		return
	}
	for _, f := range e.Files {
		img, err := pastedImage(f)
		switch {
		case err == nil:
			a.addPastedImage(s, img)
		case errors.Is(err, errPastedImageSize):
			a.toast(ui.ToastInfo, apptext.T("图片太大，上限 6 MB"), "")
		case errors.Is(err, errPastedNotImage):
			name := strings.TrimSpace(f.Name)
			if name == "" {
				name = strings.TrimSpace(f.MIME)
			}
			a.toast(ui.ToastInfo, apptext.T("这张图片的格式看不了"), name)
		}
	}
	for _, uri := range e.URIs {
		a.dropFiles(s, []string{uri})
	}
	if len(e.Files) == 0 && len(e.URIs) == 0 && utf8.RuneCountInString(e.Text) >= pasteTextMinRunes {
		a.stashPastedText(s, e.Text)
	}
}

// setComposing records the input method's uncommitted text, and
// clearComposing forgets it.
func setComposing(s *session, text string) {
	if s == nil || s.composing == nil {
		return
	}
	s.composing.Set(text)
}

func clearComposing(s *session) { setComposing(s, "") }

// pastedTextComposing is the composing text Send may take as the draft: a
// voice input method holds whole sentences there, while pinyin waits short
// enough to stay out of the way.
func pastedTextComposing(s *session) string {
	if s == nil || s.composing == nil {
		return ""
	}
	text := strings.TrimSpace(s.composing.Get())
	if utf8.RuneCountInString(text) < 20 {
		return ""
	}
	return text
}
