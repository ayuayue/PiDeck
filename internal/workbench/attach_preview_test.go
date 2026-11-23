//go:build !js && !android && !ios

package workbench

// Checks the pictures waiting in the composer: a click enlarges one, the
// menu below a secondary click copies or saves it, and the corner control
// still takes it out.

import (
	"testing"
	"time"

	"example.com/pideck-v2/assets"
	"example.com/pideck-v2/internal/remotewire"
)

// TestComposerImagePreview checks the pasted picture's own actions.
func TestComposerImagePreview(t *testing.T) {
	built, screen, sess := startNativeSurfaceApp(t)
	onNativeUI(t, screen, built, func() {
		sess.images.Set([]remotewire.Image{{Data: assets.LogoPNG, MimeType: "image/png", Name: "粘贴的图片.png"}})
	})
	screen.WaitFor("id:attach-image", 5*time.Second)

	// A click on the picture enlarges it, and the dialog closes again.
	screen.Press("id:attach-image")
	screen.WaitFor("id:attach-image-viewer", 5*time.Second)
	screen.WaitFor("id:attach-image-picture", 5*time.Second)
	screen.Press("text:关闭")
	screen.WaitForGone("id:attach-image-picture", 5*time.Second)

	// The menu a secondary click opens offers the bytes back.
	screen.RightClick("id:attach-image")
	screen.WaitFor("text:复制图片", 5*time.Second)
	screen.WaitFor("text:另存图片…", 5*time.Second)
	screen.Press("text:复制图片")
	screen.WaitFor("text:已复制图片", 5*time.Second)

	// The corner control still takes the picture out of the composer.
	screen.Press("role:button 移除图片")
	screen.WaitForGone("id:attach-image", 5*time.Second)
	if got := sess.images.GetUntracked(); len(got) != 0 {
		t.Fatalf("images=%+v; want the removed picture gone", got)
	}
}
