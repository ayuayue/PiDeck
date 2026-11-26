//go:build !js && !android && !ios

package workbench

// Checks the composer's pastes at the surface: a long text becomes a chip
// instead of filling the field, a picture the platform hands over without a
// usable type still attaches, the field grows with its text, and dictation
// still in the input method does not leave Send dead.

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
	"golang.org/x/image/bmp"
)

// TestComposerLongPasteBecomesChip keeps a screenful out of the field.
func TestComposerLongPasteBecomesChip(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	home := os.Getenv("PIDECK_V2_HOME")
	text := strings.Repeat("这是一段很长的粘贴内容，用来测试输入框里的长文本会变成文件。\n", 200)
	app.Paste("id:composer", core.PasteEvent{Text: text})
	waitApp(app, "id:paste-file-chip", 10*time.Second)
	if got := app.Find("id:composer").Text; strings.Contains(got, "很长的粘贴内容") {
		t.Fatalf("the field kept the paste: %.80q", got)
	}
	if !app.Enabled("id:composer-send") {
		t.Fatal("Send is dead with a paste waiting")
	}
	dir := filepath.Join(home, pasteTextDir)
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("paste files = %d, %v; want one", len(entries), err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if err != nil || string(raw) != text {
		t.Fatalf("the paste file holds %d bytes, %v; want %d", len(raw), err, len(text))
	}
	app.Press("id:paste-file-remove")
	app.WaitForGone("id:paste-file-chip", 5*time.Second)
	if _, err := os.Stat(filepath.Join(dir, entries[0].Name())); !os.IsNotExist(err) {
		t.Fatalf("the paste file outlived its chip: %v", err)
	}
}

// TestComposerPasteShortTextStaysInline leaves a normal paste in the field.
func TestComposerPasteShortTextStaysInline(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	app.Paste("id:composer", core.PasteEvent{Text: "短短一段"})
	app.Settle()
	if got := app.Find("id:composer").Text; got != "短短一段" {
		t.Fatalf("the field holds %q, want the paste", got)
	}
	if len(app.Query("id:paste-file-chip")) != 0 {
		t.Fatal("a short paste became a file")
	}
}

// TestComposerPasteImageWithoutMime sniffs a picture's bytes.
func TestComposerPasteImageWithoutMime(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	app.Paste("id:composer", core.PasteEvent{Files: []core.PastedFile{{Name: "screen", MIME: "application/octet-stream", Data: composerPNG(t)}}})
	app.WaitFor("id:attach-image", 5*time.Second)
}

// TestComposerPasteBitmap attaches a clipboard bitmap as a picture.
func TestComposerPasteBitmap(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	app.Paste("id:composer", core.PasteEvent{Files: []core.PastedFile{{MIME: "image/bmp", Data: composerBMP(t)}}})
	app.WaitFor("id:attach-image", 5*time.Second)
}

// TestComposerGrowsPastTenLines lets the field follow a long draft.
func TestComposerGrowsPastTenLines(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	app.Type("id:composer", strings.Repeat("一行文字\n", 4))
	app.Settle()
	short := app.Find("id:composer").Bounds().Size.Height
	app.Type("id:composer", strings.Repeat("一行文字\n", 26))
	app.Settle()
	long := app.Find("id:composer").Bounds().Size.Height
	if long <= short {
		t.Fatalf("the field did not grow: %v then %v", short, long)
	}
	if long <= short*10/4 {
		t.Fatalf("the field stopped at ten lines: %v points, four lines took %v", long, short)
	}
	if long > app.Find("id:transcript").Bounds().Size.Height {
		t.Fatalf("the field takes the whole transcript: %v", long)
	}
}

// TestComposerSendWhileComposing counts dictated text, not pinyin.
func TestComposerSendWhileComposing(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("driven headless; a platform run is for pixels")
	}
	app := composerApp(t)
	if app.Enabled("id:composer-send") {
		t.Fatal("Send is live with an empty field")
	}
	app.Compose("id:composer", "这是语音输入法留在输入框里的一整句话，还没有上屏，但发送不该是灰的。")
	app.Settle()
	if !app.Enabled("id:composer-send") {
		t.Fatal("Send is dead while the input method holds a sentence")
	}
	app.Compose("id:composer", "nihao")
	app.Settle()
	if app.Enabled("id:composer-send") {
		t.Fatal("Send took pinyin still being composed")
	}
}

// composerPNG is a tiny picture to paste.
func composerPNG(t *testing.T) []byte {
	t.Helper()
	var out bytes.Buffer
	if err := png.Encode(&out, image.NewRGBA(image.Rect(0, 0, 3, 3))); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}

// composerBMP is the bitmap a Windows clipboard hands over for a screenshot.
func composerBMP(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 5, 4))
	for y := range 4 {
		for x := range 5 {
			img.Set(x, y, color.RGBA{R: 10, G: 120, B: 220, A: 255})
		}
	}
	var out bytes.Buffer
	if err := bmp.Encode(&out, img); err != nil {
		t.Fatal(err)
	}
	return out.Bytes()
}
