//go:build !js && !android && !ios

package workbench

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/nsgo-dev/nsgo/core"
	"github.com/nsgo-dev/nsgo/nsgotest"
)

func composerRegressionApp(t *testing.T) *nsgotest.App {
	t.Helper()
	a, screen, s := chatDesignFixture(t, 0)
	if err := os.WriteFile(filepath.Join(s.WS, "note.txt"), []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	a.scanWorkspaceFiles(s.WS)
	screen.Post(func() {
		s.agentClosed = true // Layout and IME tests never start a real backend.
		s.turns.Set(nil)
	})
	return screen
}

func TestComposerResizesLongDraft(t *testing.T) {
	app := composerRegressionApp(t)
	app.Paste("id:composer", core.PasteEvent{Text: strings.Repeat("长文本仍然应该能滚动查看。\n", 35)})
	app.Resize(1000, 560)
	app.Settle()
	card := app.Find("id:composer-card").Bounds()
	viewport := app.Find("id:transcript").Bounds()
	if card.Size.Height > viewport.Size.Height-28 {
		t.Fatalf("composer height = %v, viewport = %v; footer and Send must fit", card.Size.Height, viewport.Size.Height)
	}
	shot(app, "composer/long-draft-bounded")
	app.Clear("id:composer")
	if got := app.Find("id:composer").Bounds().Size.Height; got > 80 {
		t.Fatalf("cleared input stayed %v points tall", got)
	}
}

func TestComposerImageOnlyCanSend(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("native clipboard availability differs by platform")
	}
	app := composerRegressionApp(t)
	app.Paste("id:composer", core.PasteEvent{Files: []core.PastedFile{{MIME: "image/png", Data: composerPNG(t)}}})
	if !app.Enabled("id:composer-send") {
		t.Fatal("an image attachment must enable Send without extra text")
	}
}

func TestComposerAttachmentsAndTextStayBounded(t *testing.T) {
	if nsgotest.Target() != "" {
		t.Skip("native clipboard availability differs by platform")
	}
	app := composerRegressionApp(t)
	for range 12 {
		app.Paste("id:composer", core.PasteEvent{Files: []core.PastedFile{{MIME: "image/png", Data: composerPNG(t)}}})
	}
	app.Type("id:composer", strings.Repeat("图片和文字都可以查看。\n", 35))
	app.Resize(780, 560)
	app.Settle()
	card := app.Find("id:composer-card").Bounds()
	viewport := app.Find("id:transcript").Bounds()
	if card.Size.Height > viewport.Size.Height-28 {
		t.Fatalf("attachments plus text take %v points, viewport = %v", card.Size.Height, viewport.Size.Height)
	}
	if !app.Enabled("id:composer-send") {
		t.Fatal("attachments plus text disabled Send")
	}
}

func TestComposerDictationCommitEnablesSend(t *testing.T) {
	app := composerRegressionApp(t)
	app.Focus("id:composer")
	app.Compose("id:composer", "好")
	app.Commit("id:composer", "好")
	if !app.Enabled("id:composer-send") {
		t.Fatal("a committed one-character dictation must enable Send")
	}
	if got := app.Find("id:composer").Text; got != "好" {
		t.Fatalf("committed dictation = %q", got)
	}
}
